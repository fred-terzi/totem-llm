const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

// admin.js transitively imports heavy LLM provider stacks (AWS SDK, etc.)
// that are irrelevant to the user-management flow — stub updateENV so the
// endpoint module loads in the test environment (same trick as
// requestToken.test.js / invite.test.js).
jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

const SERVER_DIR = path.join(__dirname, "..", "..");

/**
 * Tests for the admin user management endpoints in multi-user mode:
 *
 *   POST /admin/users/new   — creating a user
 *   POST /admin/user/:id    — updating a user
 *
 * Both handlers pass their request body through to User.create() /
 * User.update(), so the optional `email` field (validated + normalized by
 * the model layer) flows end-to-end. This suite asserts that pass-through
 * plus the friendly duplicate/invalid error handling, using the same
 * harness pattern as invite.test.js / requestToken.test.js: the
 * registered route handler is invoked directly with mock request/response
 * objects against a real throwaway SQLite database (full migration history
 * applied).
 */
describe("admin user create/update email (multi-user mode)", () => {
  let prisma;
  let tmpDir;
  let createHandler; // POST /admin/users/new
  let updateHandler; // POST /admin/user/:id

  let adminUser; // acting admin (role admin) for userFromSession
  let newUserId; // user created without email, updated afterwards

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "totem-admin-test-"));
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

    // The prisma client singleton reads DATABASE_URL at instantiation, so it
    // must be set before the endpoint module (and its transitive prisma dep)
    // is required below.
    process.env.DATABASE_URL = dbUrl;

    // Enable multi-user mode + make sure SSO-login-disabled middleware does
    // not 403 the create path (neither SIMPLE_SSO_* var set => login enabled).
    delete process.env.SIMPLE_SSO_ENABLED;
    delete process.env.SIMPLE_SSO_NO_LOGIN;

    const { User } = require("../../models/user");
    await prismaEnsureMultiUserMode(dbUrl);

    prisma = require("../../utils/prisma");

    const { error: adminError } = await User.create({
      username: "admin",
      password: "Str0ngPass!",
      role: "admin",
    });
    expect(adminError).toBeNull();
    adminUser = await prisma.users.findUnique({
      where: { username: "admin" },
    });

    const { error: otherError } = await User.create({
      username: "otheruser",
      password: "Str0ngPass!",
      email: "other@example.com",
    });
    expect(otherError).toBeNull();

    // Capture the route handlers registered by adminEndpoints().
    const routes = [];
    const record =
      (method) =>
      (routePath, ...args) => {
        routes.push({
          method,
          path: routePath,
          handler: args[args.length - 1],
        });
      };
    const fakeApp = {
      get: record("get"),
      post: record("post"),
      put: record("put"),
      delete: record("delete"),
      use: () => {},
    };

    const { adminEndpoints } = require("../../endpoints/admin");
    adminEndpoints(fakeApp);

    const createRoute = routes.find(
      (r) => r.path === "/admin/users/new" && r.method === "post"
    );
    const updateRoute = routes.find(
      (r) => r.path === "/admin/user/:id" && r.method === "post"
    );
    if (!createRoute) throw new Error("POST /admin/users/new route not found");
    if (!updateRoute) throw new Error("POST /admin/user/:id route not found");
    createHandler = createRoute.handler;
    updateHandler = updateRoute.handler;
  }, 120000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeResponse() {
    return {
      statusCode: null,
      body: null,
      locals: { user: adminUser },
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

  async function callCreate(body) {
    const request = { params: {}, body, ip: "127.0.0.1", header: () => null };
    const response = makeResponse();
    await createHandler(request, response);
    return { status: response.statusCode, body: response.body };
  }

  async function callUpdate(id, body) {
    const request = {
      params: { id: String(id) },
      body,
      ip: "127.0.0.1",
      header: () => null,
    };
    const response = makeResponse();
    await updateHandler(request, response);
    return { status: response.statusCode, body: response.body };
  }

  it("POST /admin/users/new accepts no email (optional, unchanged behavior)", async () => {
    const { status, body } = await callCreate({
      username: "noemailadmin",
      password: "Str0ngPass!",
      role: "default",
    });
    expect(status).toBe(200);
    expect(body.user).not.toBeNull();
    expect(body.error).toBeNull();

    const user = await prisma.users.findFirst({
      where: { username: "noemailadmin" },
    });
    expect(user).not.toBeNull();
    expect(user.email).toBeNull();
  });

  it("POST /admin/users/new accepts an email address and stores it normalized", async () => {
    const { status, body } = await callCreate({
      username: "withemailadmin",
      password: "Str0ngPass!",
      role: "default",
      email: "  NewAdmin@Example.COM  ",
    });
    expect(status).toBe(200);
    expect(body.user).not.toBeNull();
    expect(body.error).toBeNull();

    const user = await prisma.users.findFirst({
      where: { username: "withemailadmin" },
    });
    expect(user).not.toBeNull();
    expect(user.email).toBe("newadmin@example.com");
  });

  it("POST /admin/users/new rejects a duplicate email with a friendly message", async () => {
    const { status, body } = await callCreate({
      username: "dupemailadmin",
      password: "Str0ngPass!",
      role: "default",
      email: "other@example.com",
    });
    expect(status).toBe(200);
    expect(body.user).toBeNull();
    expect(body.error).toBe("A user with that email already exists");

    const user = await prisma.users.findFirst({
      where: { username: "dupemailadmin" },
    });
    expect(user).toBeNull();
  });

  it("POST /admin/users/new rejects an invalid email without creating a user", async () => {
    const { status, body } = await callCreate({
      username: "bademailadmin",
      password: "Str0ngPass!",
      role: "default",
      email: "not-an-email",
    });
    expect(status).toBe(200);
    expect(body.user).toBeNull();
    expect(body.error).toBe("A valid email address is required");

    const user = await prisma.users.findFirst({
      where: { username: "bademailadmin" },
    });
    expect(user).toBeNull();
  });

  it("POST /admin/user/:id sets an email on an existing user (normalized)", async () => {
    // Create a user with no email, then set one via update.
    const created = await callCreate({
      username: "targetuser",
      password: "Str0ngPass!",
      role: "default",
    });
    expect(created.body.user).not.toBeNull();
    newUserId = (
      await prisma.users.findUnique({ where: { username: "targetuser" } })
    ).id;

    const { status, body } = await callUpdate(newUserId, {
      email: "  target@Example.COM  ",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();

    const user = await prisma.users.findUnique({ where: { id: newUserId } });
    expect(user.email).toBe("target@example.com");
  });

  it("POST /admin/user/:id can clear an email back to null", async () => {
    const { status, body } = await callUpdate(newUserId, { email: "" });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();

    const user = await prisma.users.findUnique({ where: { id: newUserId } });
    expect(user.email).toBeNull();
  });

  it("POST /admin/user/:id rejects a duplicate email with a friendly message", async () => {
    const { status, body } = await callUpdate(newUserId, {
      email: "other@example.com",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("A user with that email already exists");

    // The target user's email is unchanged (still null from prior test).
    const user = await prisma.users.findUnique({ where: { id: newUserId } });
    expect(user.email).toBeNull();
  });
});

// Sets multi_user_mode=true in the throwaway DB using a dedicated Prisma
// instance (independent of the endpoint's shared singleton).
async function prismaEnsureMultiUserMode(dbUrl) {
  const { PrismaClient } = require("@prisma/client");
  const setupPrisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
    log: [],
  });
  try {
    await setupPrisma.system_settings.create({
      data: { label: "multi_user_mode", value: "true" },
    });
  } finally {
    await setupPrisma.$disconnect();
  }
}
