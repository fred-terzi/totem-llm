const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

// system.js transitively imports heavy LLM provider stacks (AWS SDK, etc.)
// that are irrelevant to this endpoint — stub updateENV so the endpoint
// module loads in the test environment (same pattern as requestToken.test.js
// and publicRegistrationFlag.test.js).
jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

const SERVER_DIR = path.join(__dirname, "..", "..");
const WELCOME_BONUS = 100_000;

/**
 * Tests for POST /system/new-user — the public email-registration endpoint.
 *
 * Same harness as the other endpoint tests: capture the registered route
 * handler via a fake `app` (middleware chain bypassed — including the rate
 * limiter, which is exercised through its own suite and asserted separately
 * via event/balance side effects), invoke it directly with mock
 * request/response objects, against a real throwaway SQLite database (full
 * migration history applied).
 */
describe("POST /system/new-user (public email registration)", () => {
  let prisma;
  let endpointPrisma;
  let tmpDir;
  let registerHandler;
  let originalJwtSecret;

  beforeAll(async () => {
    originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "test-jwt-secret";

    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "totem-new-user-test-")
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

    await setSettingViaSetupClient(dbUrl, "multi_user_mode", "true");
    await setSettingViaSetupClient(dbUrl, "allow_public_registration", "true");

    // A pre-existing user used for duplicate-detection assertions.
    const { User } = require("../../models/user");
    const { error: existingUserError } = await User.create({
      username: "existing",
      password: "Str0ngPass!",
      email: "existing@example.com",
    });
    expect(existingUserError).toBeNull();

    // Capture the route handlers registered by systemEndpoints().
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

    const route = routes.find(
      (r) => r.path === "/system/new-user" && r.method === "post"
    );
    if (!route) throw new Error("POST /system/new-user route not found");
    registerHandler = route.handler;
  }, 120000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (endpointPrisma) await endpointPrisma.$disconnect();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.JWT_SECRET = originalJwtSecret;
  });

  async function setSettingViaSetupClient(dbUrl, label, value) {
    const { PrismaClient } = require("@prisma/client");
    const setupPrisma = new PrismaClient({
      datasources: { db: { url: dbUrl } },
      log: [],
    });
    try {
      await setupPrisma.system_settings.upsert({
        where: { label },
        update: { value },
        create: { label, value },
      });
    } finally {
      await setupPrisma.$disconnect();
    }
  }

  function makeResponse() {
    return {
      statusCode: null,
      body: null,
      locals: {},
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
      end() {
        return this;
      },
    };
  }

  async function register(body, ip = "127.0.0.1") {
    const request = { body, ip, header: () => null };
    const response = makeResponse();
    await registerHandler(request, response);
    return { status: response.statusCode, body: response.body };
  }

  async function flipSetting(label, value) {
    await endpointPrisma.system_settings.upsert({
      where: { label },
      update: { value },
      create: { label, value },
    });
  }

  it("refuses with 403 when public registration is disabled", async () => {
    await flipSetting("allow_public_registration", "false");
    const { status, body } = await register({
      username: "gatekeeper",
      password: "Str0ngPass!",
      email: "gatekeeper@example.com",
    });
    expect(status).toBe(403);
    expect(body.success).toBe(false);

    const user = await prisma.users.findFirst({
      where: { username: "gatekeeper" },
    });
    expect(user).toBeNull();

    await flipSetting("allow_public_registration", "true");
  });

  it("refuses when multi-user mode is off even if the flag is on", async () => {
    await flipSetting("multi_user_mode", "false");
    const { status } = await register({
      username: "singleuser",
      password: "Str0ngPass!",
      email: "singleuser@example.com",
    });
    expect(status).toBe(403);
    const user = await prisma.users.findFirst({
      where: { username: "singleuser" },
    });
    expect(user).toBeNull();
    await flipSetting("multi_user_mode", "true");
  });

  it("registers a new user with email, grants the welcome bonus, creates a workspace, and logs the event", async () => {
    const { status, body } = await register({
      username: "newuser",
      password: "Str0ngPass!",
      email: "  NewUser@Example.COM  ",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, error: null });

    const user = await prisma.users.findUnique({
      where: { email: "newuser@example.com" },
    });
    expect(user).not.toBeNull();
    expect(user.username).toBe("newuser");
    expect(user.email).toBe("newuser@example.com");
    expect(user.role).toBe("default");
    expect(user.suspended).toBe(0);

    // Welcome bonus credited via the ledger.
    expect(user.credits_balance).toBe(WELCOME_BONUS);
    const bonusTx = await prisma.credit_transactions.findFirst({
      where: { user_id: user.id, type: "credit", reference: "signup_newuser@example.com" },
    });
    expect(bonusTx).not.toBeNull();
    expect(bonusTx.amount).toBe(WELCOME_BONUS);

    // Default workspace auto-created and linked to the user.
    const membership = await prisma.workspace_users.findFirst({
      where: { user_id: user.id },
    });
    expect(membership).not.toBeNull();
    const workspace = await prisma.workspaces.findUnique({
      where: { id: membership.workspace_id },
    });
    expect(workspace.name).toBe("My Workspace");

    // Audit event recorded.
    const event = await prisma.event_logs.findFirst({
      where: { event: "user_registered", userId: user.id },
    });
    expect(event).not.toBeNull();
  });

  it("rejects a missing email (email is required in this flow)", async () => {
    const { status, body } = await register({
      username: "noemail",
      password: "Str0ngPass!",
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/email/i);
    const user = await prisma.users.findFirst({
      where: { username: "noemail" },
    });
    expect(user).toBeNull();
  });

  it("rejects an invalid email address without creating a user", async () => {
    const { status, body } = await register({
      username: "bademail",
      password: "Str0ngPass!",
      email: "not-an-email",
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe("A valid email address is required");
    const user = await prisma.users.findFirst({
      where: { username: "bademail" },
    });
    expect(user).toBeNull();
  });

  it("rejects a duplicate email with a friendly message and creates no user", async () => {
    const { status, body } = await register({
      username: "dupemail",
      password: "Str0ngPass!",
      email: "existing@example.com",
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe("A user with that email already exists");
    const user = await prisma.users.findFirst({
      where: { username: "dupemail" },
    });
    expect(user).toBeNull();
  });

  it("rejects a duplicate username with a friendly message and creates no user", async () => {
    const { status, body } = await register({
      username: "existing",
      password: "Str0ngPass!",
      email: "unrelated@example.com",
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe("A user with that username already exists");
    // The pre-existing user is untouched, no extra account created.
    const count = await prisma.users.count({
      where: { username: "existing" },
    });
    expect(count).toBe(1);
  });

  it("rejects missing username and missing password", async () => {
    const noUsername = await register({
      password: "Str0ngPass!",
      email: "missing-username@example.com",
    });
    expect(noUsername.status).toBe(400);
    expect(noUsername.body.error).toMatch(/username/i);

    const noPassword = await register({
      username: "nopassword",
      email: "nopassword@example.com",
    });
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.error).toMatch(/password/i);

    const count = await prisma.users.count({
      where: { email: "nopassword@example.com" },
    });
    expect(count).toBe(0);
  });

  it("the new user can log in by email through /request-token-style lookup", async () => {
    // Registers above already created newuser@example.com — verify the
    // Chunk 2/3 lookup resolves by email (login-by-email end-to-end).
    const { User } = require("../../models/user");
    const found = await User.getByUsernameOrEmail("NEWUSER@example.com");
    expect(found).not.toBeNull();
    expect(found.username).toBe("newuser");
  });
});
