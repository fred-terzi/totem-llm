const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

const SERVER_DIR = path.join(__dirname, "..", "..");

// workspaces.js transitively imports heavy LLM provider stacks (AWS SDK via
// helpers/updateENV → bedrock, etc.) that are irrelevant to these endpoints —
// stub updateENV so the endpoint module loads in the test environment (same
// trick as adminUserEmail.test.js / invite.test.js).
jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

/**
 * Tests for the default-user inference option endpoints (spec F13/F14):
 *
 *   POST /workspace/:slug/inference-option  — member-gated, option-key-only write
 *   GET  /workspace/:slug/inference-options — picker availability payload
 *
 * Follows the same harness pattern as invite.test.js: middleware is bypassed
 * (middleware behavior is covered by the shared middleware's own semantics and
 * the smoke matrix in Step 7) and the registered route handler is invoked
 * directly against a real throwaway SQLite database with the full migration
 * history applied. This exercises the allowlist validation, the membership
 * scoping done inside Workspace.getWithUser via validWorkspaceSlug's
 * resolution, the `Workspace.setInferenceOption` write path, persistence, and
 * the availability payload shape.
 */
describe("inference option endpoints (F13 write / F14 read)", () => {
  let prisma;
  let endpointPrisma;
  let tmpDir;
  let setOptionHandler;
  let getOptionsHandler;
  const OPTIONS = ["totem-free", "totem-anon", "totem-e2ee"];

  let makeUser;
  let makeWorkspace;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "totem-inference-opt-test-"));
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

    // Enable multi-user mode so the endpoint's membership scoping
    // (Workspace.getWithUser → workspace_users.some) is active, as in prod.
    const { PrismaClient } = require("@prisma/client");
    const setupPrisma = new PrismaClient({
      datasources: { db: { url: dbUrl } },
      log: [],
    });
    await setupPrisma.system_settings.create({
      data: { label: "multi_user_mode", value: "true" },
    });
    await setupPrisma.$disconnect();

    // Capture route handlers registered by workspaceEndpoints().
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

    const { workspaceEndpoints } = require("../../endpoints/workspaces");
    workspaceEndpoints(fakeApp);

    // The endpoint's models use a fresh `../utils/prisma` singleton (created
    // after process.env.DATABASE_URL was set above). Grab the same instance
    // so we can close its connection pool in afterAll.
    prisma = require("../../utils/prisma");
    endpointPrisma = prisma;

    const postRoute = routes.find(
      (r) => r.path === "/workspace/:slug/inference-option" && r.method === "post"
    );
    const getRoute = routes.find(
      (r) =>
        r.path === "/workspace/:slug/inference-options" && r.method === "get"
    );
    if (!postRoute) throw new Error("POST inference-option route not found");
    if (!getRoute) throw new Error("GET inference-options route not found");
    setOptionHandler = postRoute.handler;
    getOptionsHandler = getRoute.handler;

    const { User } = require("../../models/user");
    const { Workspace } = require("../../models/workspace");

    makeUser = async (username, role = "default") => {
      const { user, error } = await User.create({
        username,
        password: "Str0ngPass!",
        role,
      });
      expect(error).toBeNull();
      return user;
    };

    makeWorkspace = async (name, ownerId) => {
      const { workspace, message } = await Workspace.new(name, ownerId);
      expect(message).toBeNull();
      return workspace;
    };
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

  /**
   * Invoke a captured handler as `validWorkspaceSlug` would hand it over:
   * the workspace is resolved WITH membership scoping (the middleware's job)
   * and stashed on response.locals. This keeps the membership semantics
   * under test while bypassing only the HTTP middleware plumbing.
   */
  async function callHandler(handler, { user, workspace, body = {} }) {
    const request = {
      params: { slug: workspace?.slug ?? "missing" },
      body,
      ip: "127.0.0.1",
      header: () => null,
    };
    const response = makeResponse();
    response.locals.user = user;
    response.locals.workspace = workspace; // what validWorkspaceSlug sets
    await handler(request, response);
    return { status: response.statusCode, body: response.body };
  }

  it("accepts a valid option key from a workspace member and persists it (AC 12 happy path)", async () => {
    const user = await makeUser("member1");
    const workspace = await makeWorkspace("opt-test-1", user.id);

    const { status, body } = await callHandler(setOptionHandler, {
      user,
      workspace,
      body: { option: "totem-free" },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.option).toBe("totem-free");

    const persisted = await prisma.workspaces.findUnique({
      where: { slug: workspace.slug },
    });
    expect(persisted.user_inference_option).toBe("totem-free");
  });

  it("persists each of the three option keys and null-clears the selection (F5)", async () => {
    const user = await makeUser("member2");
    const workspace = await makeWorkspace("opt-test-2", user.id);

    for (const key of OPTIONS) {
      const { status } = await callHandler(setOptionHandler, {
        user,
        workspace,
        body: { option: key },
      });
      expect(status).toBe(200);
      const persisted = await prisma.workspaces.findUnique({
        where: { slug: workspace.slug },
      });
      expect(persisted.user_inference_option).toBe(key);
    }

    // null clears the selection → legacy behavior (N4/OQ-4)
    const { status: clearStatus } = await callHandler(setOptionHandler, {
      user,
      workspace,
      body: { option: null },
    });
    expect(clearStatus).toBe(200);
    const cleared = await prisma.workspaces.findUnique({
      where: { slug: workspace.slug },
    });
    expect(cleared.user_inference_option).toBeNull();
  });

  it("rejects unknown option keys with 400 and writes nothing (AC 12)", async () => {
    const user = await makeUser("member3");
    const workspace = await makeWorkspace("opt-test-3", user.id);

    for (const bad of ["totem-premium", "openrouter", "", "../../etc"]) {
      const { status, body } = await callHandler(setOptionHandler, {
        user,
        workspace,
        body: { option: bad },
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
    }

    // Raw provider/model injection attempts are just unknown keys — rejected.
    const { status } = await callHandler(setOptionHandler, {
      user,
      workspace,
      body: { option: "openrouter|nvidia/nemotron-3.5-lightning:free" },
    });
    expect(status).toBe(400);

    const persisted = await prisma.workspaces.findUnique({
      where: { slug: workspace.slug },
    });
    expect(persisted.user_inference_option).toBeNull();
  });

  it("scopes resolution by membership: a non-member's request resolves no workspace (404)", async () => {
    const owner = await makeUser("owner4");
    const outsider = await makeUser("outsider4");
    const workspace = await makeWorkspace("opt-test-4", owner.id);

    // Simulate what validWorkspaceSlug produces for a non-member in
    // multi-user mode: Workspace.getWithUser returns null → handler 404s
    // before any write.
    const { Workspace: WS } = require("../../models/workspace");
    const resolved = await WS.getWithUser(outsider, { slug: workspace.slug });
    expect(resolved).toBeNull();

    const { status } = await callHandler(setOptionHandler, {
      user: outsider,
      workspace: null,
      body: { option: "totem-free" },
    });
    expect(status).toBe(404);

    const persisted = await prisma.workspaces.findUnique({
      where: { slug: workspace.slug },
    });
    expect(persisted.user_inference_option).toBeNull();
  });

  it("availability payload returns the three options with slugs and boolean availability, plus current selection (F14)", async () => {
    const user = await makeUser("member5");
    const workspace = await makeWorkspace("opt-test-5", user.id);
    await callHandler(setOptionHandler, {
      user,
      workspace,
      body: { option: "totem-anon" },
    });

    // validWorkspaceSlug re-resolves the workspace per request in prod —
    // simulate that by refetching so `selected` reflects the just-made write.
    const { Workspace: WS } = require("../../models/workspace");
    const refreshed = await WS.getWithUser(user, { slug: workspace.slug });

    const { status, body } = await callHandler(getOptionsHandler, {
      user,
      workspace: refreshed,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.selected).toBe("totem-anon");
    expect(body.options).toHaveLength(3);

    const keys = body.options.map((o) => o.key);
    expect(keys).toEqual(OPTIONS); // registry order = picker display order (F1)
    for (const option of body.options) {
      expect(typeof option.label).toBe("string");
      expect(typeof option.model).toBe("string");
      expect(option.model.length).toBeGreaterThan(0);
      expect(typeof option.available).toBe("boolean");
      // The system_settings label must NOT leak to non-admin consumers.
      expect(option.settingLabel).toBeUndefined();
    }
  });

  it("selected is null for a workspace with no selection (legacy, N4)", async () => {
    const user = await makeUser("member6");
    const workspace = await makeWorkspace("opt-test-6", user.id);

    const { status, body } = await callHandler(getOptionsHandler, {
      user,
      workspace,
    });
    expect(status).toBe(200);
    expect(body.selected).toBeNull();
  });
});
