const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");
const bcrypt = require("bcryptjs");

// system.js transitively imports heavy LLM provider stacks (AWS SDK, etc.)
// that are irrelevant to the login flow — stub updateENV so the endpoint
// module loads in the test environment.
jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

const SERVER_DIR = path.join(__dirname, "..", "..");

/**
 * Tests for POST /request-token in multi-user mode.
 *
 * Instead of spinning up Express (whose bundled `send`/`mime` resolve to
 * ESM-only top-level versions under jest and break `res.json`), we capture the
 * registered route handler via a fake `app`, then invoke it directly with mock
 * request/response objects. The handler runs against a real throwaway SQLite
 * database (full migration history applied), so the login flow — including the
 * new username-OR-email identifier lookup — is exercised end-to-end.
 */
describe("POST /request-token (multi-user mode)", () => {
  let prisma;
  let endpointPrisma;
  let tmpDir;
  let loginHandler;
  let originalJwtSecret;

  beforeAll(async () => {
    originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "test-jwt-secret";

    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "totem-request-token-test-")
    );
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

    // Enable multi-user mode
    await prisma.system_settings.create({
      data: { label: "multi_user_mode", value: "true" },
    });

    const passwordHash = bcrypt.hashSync("correct-horse", 10);
    await prisma.users.create({
      data: {
        username: "alice",
        password: passwordHash,
        email: "alice@example.com",
        seen_recovery_codes: true,
      },
    });
    await prisma.users.create({
      data: {
        username: "bob",
        password: passwordHash,
        email: "bob@example.com",
        seen_recovery_codes: true,
      },
    });
    // A user without an email — email is optional and must not break login.
    await prisma.users.create({
      data: {
        username: "carol",
        password: passwordHash,
        email: null,
        suspended: 1,
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

    // The endpoint's models use a fresh `../utils/prisma` singleton (created
    // after resetModules). Grab the same instance so we can close its
    // connection pool in afterAll and let jest exit cleanly.
    endpointPrisma = require("../../utils/prisma");

    const loginRoute = routes.find(
      (r) => r.path === "/request-token" && r.method === "post"
    );
    if (!loginRoute) throw new Error("POST /request-token route not found");
    loginHandler = loginRoute.handler;
  }, 120000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (endpointPrisma) await endpointPrisma.$disconnect();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  function makeRequest({ username, password }) {
    return {
      body: { username, password },
      ip: "127.0.0.1",
      header: () => null,
    };
  }

  function makeResponse() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
      sendStatus(code) {
        this.statusCode = code;
        return this;
      },
    };
  }

  async function login(username, password) {
    const response = makeResponse();
    await loginHandler(makeRequest({ username, password }), response);
    return { status: response.statusCode, body: response.body };
  }

  it("logs in with username and password (unchanged behavior)", async () => {
    const { status, body } = await login("alice", "correct-horse");
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.user.username).toBe("alice");
    expect(body.user.email).toBe("alice@example.com");
    // Password must never be exposed
    expect(body.user.password).toBeUndefined();
  });

  it("logs in with an email address instead of username", async () => {
    const { status, body } = await login("alice@example.com", "correct-horse");
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.user.username).toBe("alice");
  });

  it("matches emails case-insensitively", async () => {
    const { body } = await login("Alice@Example.COM", "correct-horse");
    expect(body.valid).toBe(true);
    expect(body.user.username).toBe("alice");
  });

  it("resolves each user to their own account", async () => {
    const { body } = await login("bob", "correct-horse");
    expect(body.valid).toBe(true);
    expect(body.user.username).toBe("bob");
    expect(body.user.email).toBe("bob@example.com");
  });

  it("rejects a valid email with a wrong password ([002])", async () => {
    const { body } = await login("alice@example.com", "wrong-password");
    expect(body.valid).toBe(false);
    expect(body.token).toBeNull();
    expect(body.message).toBe("[002] Invalid login credentials.");
  });

  it("rejects an unknown identifier ([001])", async () => {
    const { body } = await login("nobody@example.com", "correct-horse");
    expect(body.valid).toBe(false);
    expect(body.token).toBeNull();
    expect(body.message).toBe("[001] Invalid login credentials.");
  });

  it("rejects a suspended account ([004])", async () => {
    const { body } = await login("carol", "correct-horse");
    expect(body.valid).toBe(false);
    expect(body.token).toBeNull();
    expect(body.message).toBe("[004] Account suspended by admin.");
  });
});
