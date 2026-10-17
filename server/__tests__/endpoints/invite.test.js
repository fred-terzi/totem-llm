const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

const SERVER_DIR = path.join(__dirname, "..", "..");

/**
 * Tests for POST /invite/:code in multi-user mode.
 *
 * Follows the same harness pattern as requestToken.test.js: the invite
 * endpoint's middleware chain is bypassed by calling the registered route
 * handler directly with mock request/response objects. The handler runs
 * against a real throwaway SQLite database (full migration history applied),
 * so the invite-accept flow — including the new optional email pass-through
 * to User.create() — is exercised end-to-end.
 */
describe("POST /invite/:code (multi-user mode)", () => {
  let prisma;
  let endpointPrisma;
  let tmpDir;
  let inviteHandler;

  // Creates a fresh pending invite and returns its code. Invites are
  // single-use (marked claimed on first acceptance), so each successful
  // acceptance in a test needs its own code.
  let makeInviteCode;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "totem-invite-test-"));
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

    // Enable multi-user mode in the throwaway DB so the endpoint's
    // SSO-login-disabled middleware sees the correct flag.
    const { User } = require("../../models/user");
    const { Invite } = require("../../models/invite");

    await prismaEnsureMultiUserMode(dbUrl);

    // A user that already owns an email — used to assert duplicate detection
    // on the invite path.
    const { error: existingUserError } = await User.create({
      username: "existing",
      password: "Str0ngPass!",
      email: "existing@example.com",
    });
    expect(existingUserError).toBeNull();

    makeInviteCode = async () => {
      const { invite: createdInvite, error: inviteError } =
        await Invite.create({
          createdByUserId: 0,
          workspaceIds: [],
        });
      expect(inviteError).toBeNull();
      return createdInvite.code;
    };

    // Capture the route handlers registered by inviteEndpoints().
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

    const { inviteEndpoints } = require("../../endpoints/invite");
    inviteEndpoints(fakeApp);

    // The endpoint's models use a fresh `../utils/prisma` singleton (created
    // after process.env.DATABASE_URL was set above). Grab the same instance
    // so we can close its connection pool in afterAll and let jest exit
    // cleanly.
    prisma = require("../../utils/prisma");
    endpointPrisma = prisma;

    const postRoute = routes.find(
      (r) => r.path === "/invite/:code" && r.method === "post"
    );
    if (!postRoute) throw new Error("POST /invite/:code route not found");
    inviteHandler = postRoute.handler;
  }, 120000);

  afterAll(async () => {
    if (endpointPrisma) await endpointPrisma.$disconnect();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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

  async function acceptInvite(code, body) {
    const request = {
      params: { code },
      body,
      ip: "127.0.0.1",
      header: () => null,
    };
    const response = makeResponse();
    await inviteHandler(request, response);
    return { status: response.statusCode, body: response.body };
  }

  it("accepts an invite with no email (email is optional, unchanged behavior)", async () => {
    const code = await makeInviteCode();
    const { status, body } = await acceptInvite(code, {
      username: "noemail",
      password: "Str0ngPass!",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();

    const user = await prisma.users.findFirst({
      where: { username: "noemail" },
    });
    expect(user).not.toBeNull();
    expect(user.email).toBeNull();
    expect(user.role).toBe("default");
  });

  it("accepts an invite with an email address and stores it normalized", async () => {
    const code = await makeInviteCode();
    const { status, body } = await acceptInvite(code, {
      username: "withemail",
      password: "Str0ngPass!",
      email: "  WithEmail@Example.COM  ",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();

    const user = await prisma.users.findFirst({
      where: { username: "withemail" },
    });
    expect(user).not.toBeNull();
    // Email is trimmed and lowercased by the model validator.
    expect(user.email).toBe("withemail@example.com");
  });

  it("marks the invite as claimed and records the accepting user", async () => {
    const code = await makeInviteCode();
    await acceptInvite(code, {
      username: "claimer",
      password: "Str0ngPass!",
      email: "claimer@example.com",
    });

    const invite = await prisma.invites.findFirst({ where: { code } });
    expect(invite).not.toBeNull();
    expect(invite.status).toBe("claimed");
    expect(invite.claimedBy).toBeGreaterThan(0);

    const user = await prisma.users.findUnique({
      where: { id: invite.claimedBy },
    });
    expect(user.username).toBe("claimer");
    expect(user.email).toBe("claimer@example.com");
  });

  it("rejects a duplicate email with a friendly P2002 message", async () => {
    const code = await makeInviteCode();
    const { status, body } = await acceptInvite(code, {
      username: "dupemail",
      password: "Str0ngPass!",
      email: "existing@example.com",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("A user with that email already exists");

    const user = await prisma.users.findFirst({
      where: { username: "dupemail" },
    });
    expect(user).toBeNull();
  });

  it("rejects an invalid email address without creating a user", async () => {
    const code = await makeInviteCode();
    const { status, body } = await acceptInvite(code, {
      username: "bademail",
      password: "Str0ngPass!",
      email: "not-an-email",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("A valid email address is required");

    const user = await prisma.users.findFirst({
      where: { username: "bademail" },
    });
    expect(user).toBeNull();
  });

  it("does not allow a claimed invite to be accepted again", async () => {
    const code = await makeInviteCode();
    await acceptInvite(code, {
      username: "first-accept",
      password: "Str0ngPass!",
    });
    const { status, body } = await acceptInvite(code, {
      username: "shouldnotexist",
      password: "Str0ngPass!",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invite not found or is invalid.");

    const user = await prisma.users.findFirst({
      where: { username: "shouldnotexist" },
    });
    expect(user).toBeNull();
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
