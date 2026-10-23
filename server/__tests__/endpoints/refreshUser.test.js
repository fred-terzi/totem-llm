const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");
const bcrypt = require("bcryptjs");
const JWT = require("jsonwebtoken");

// system.js transitively imports heavy LLM provider stacks (AWS SDK, etc.)
// that are irrelevant to this flow — stub updateENV so the endpoint module
// loads in the test environment.
jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

const SERVER_DIR = path.join(__dirname, "..", "..");

/**
 * Tests for GET /system/refresh-user sliding-session behavior.
 *
 * Same strategy as requestToken.test.js: capture the registered route handler
 * via a fake `app`, then invoke it directly with mock request/response objects
 * against a real throwaway SQLite database. `multiUserMode()` reads
 * response.locals.multiUserMode, which we set to true to simulate a
 * multi-user deployment.
 */
describe("GET /system/refresh-user (sliding sessions)", () => {
  let prisma;
  let endpointPrisma;
  let tmpDir;
  let refreshUserHandler;
  let originalJwtSecret;
  let testUser;

  beforeAll(async () => {
    originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "test-jwt-secret";
    delete process.env.JWT_EXPIRY;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "totem-refresh-user-test-"));
    const dbUrl = `file:${path.join(tmpDir, "test.db")}`;

    execSync(
      `npx prisma migrate deploy --schema ${path.join(
        SERVER_DIR,
        "prisma",
        "schema.prisma"
      )}`,
      {
        cwd: SERVER_DIR,
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: "pipe",
      }
    );

    jest.resetModules();
    process.env.DATABASE_URL = dbUrl;

    const { PrismaClient } = require("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [] });

    await prisma.system_settings.create({
      data: { label: "multi_user_mode", value: "true" },
    });

    testUser = await prisma.users.create({
      data: {
        username: "alice",
        password: bcrypt.hashSync("correct-horse", 10),
        email: "alice@example.com",
        seen_recovery_codes: true,
      },
    });

    // Capture the route handlers registered by systemEndpoints()
    const routes = [];
    const record =
      (method) =>
      (routePath, ...args) => {
        routes.push({ method, path: routePath, handler: args[args.length - 1] });
      };
    const fakeApp = {
      get: record("get"),
      post: record("post"),
      put: record("put"),
      delete: record("delete"),
      use: () => {},
    };

    const { systemEndpoints } = require("../../endpoints/system");
    systemEndpoints(fakeApp);

    endpointPrisma = require("../../utils/prisma");

    const route = routes.find(
      (r) => r.path === "/system/refresh-user" && r.method === "get"
    );
    if (!route) throw new Error("GET /system/refresh-user route not found");
    refreshUserHandler = route.handler;
  }, 120000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (endpointPrisma) await endpointPrisma.$disconnect();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  function makeRequest(token) {
    return {
      header: (name) => (name === "Authorization" ? `Bearer ${token}` : null),
    };
  }

  function makeResponse() {
    return {
      statusCode: null,
      body: null,
      locals: { multiUserMode: true },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  async function callRefreshUser(token) {
    const response = makeResponse();
    await refreshUserHandler(makeRequest(token), response);
    return { status: response.statusCode, body: response.body };
  }

  it("returns the user and no newToken for a fresh token", async () => {
    const token = JWT.sign(
      { id: testUser.id, username: testUser.username },
      process.env.JWT_SECRET,
      { expiresIn: "30d" } // iat = now
    );
    const { status, body } = await callRefreshUser(token);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.user.username).toBe("alice");
    expect(body.user.password).toBeUndefined();
    expect(body.newToken).toBeUndefined();
  });

  it("re-issues a newToken when the JWT is older than the 7-day threshold", async () => {
    // jsonwebtoken 9.x forbids `iat` in sign options and `noTimestamp`
    // strips it from the payload entirely — so we backdate by putting both
    // `iat` and `exp` directly in the payload (registered claims are allowed
    // there) and omitting `expiresIn`.
    const nowSec = Math.floor(Date.now() / 1000);
    const staleToken = JWT.sign(
      {
        id: testUser.id,
        username: testUser.username,
        iat: nowSec - 20 * 24 * 60 * 60, // issued 20 days ago
        exp: nowSec + 30 * 24 * 60 * 60, // still valid for 30 more days
      },
      process.env.JWT_SECRET
    );

    const { status, body } = await callRefreshUser(staleToken);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.user.username).toBe("alice");

    // A fresh token must be present and decode to the same identity
    expect(body.newToken).toBeTruthy();
    const payload = JWT.verify(body.newToken, process.env.JWT_SECRET);
    expect(payload.id).toBe(testUser.id);
    expect(payload.username).toBe(testUser.username);
    // And it must not be the same token we sent in
    expect(body.newToken).not.toBe(staleToken);
  });

  it("returns success:false for an invalid token without newToken", async () => {
    const garbageToken = JWT.sign(
      { id: 999999, username: "ghost" },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    const { status, body } = await callRefreshUser(garbageToken);
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.user).toBeNull();
    expect(body.newToken).toBeUndefined();
  });

  it("honors JWT_REFRESH_THRESHOLD_MS when set", async () => {
    const originalThreshold = process.env.JWT_REFRESH_THRESHOLD_MS;
    // Threshold of 1 hour: a token issued 2 hours ago must be re-issued
    process.env.JWT_REFRESH_THRESHOLD_MS = String(60 * 60 * 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      const token = JWT.sign(
        {
          id: testUser.id,
          username: testUser.username,
          iat: nowSec - 2 * 60 * 60, // issued 2 hours ago
          exp: nowSec + 30 * 24 * 60 * 60,
        },
        process.env.JWT_SECRET
      );
      const { body } = await callRefreshUser(token);
      expect(body.success).toBe(true);
      expect(body.newToken).toBeTruthy();
    } finally {
      if (originalThreshold === undefined)
        delete process.env.JWT_REFRESH_THRESHOLD_MS;
      else process.env.JWT_REFRESH_THRESHOLD_MS = originalThreshold;
    }
  });
});
