const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

// system.js transitively imports heavy LLM provider stacks (AWS SDK, etc.)
// that are irrelevant to this endpoint — stub updateENV so the endpoint
// module loads in the test environment (same pattern as requestToken.test.js).
jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

const SERVER_DIR = path.join(__dirname, "..", "..");

/**
 * Tests for the allow_public_registration setting and the unauthenticated
 * GET /system/public-registration flag endpoint.
 *
 * Same harness as the other endpoint tests: capture the registered route
 * handler via a fake `app`, invoke it directly with mock request/response
 * objects, against a real throwaway SQLite database (full migration history
 * applied).
 */
describe("allow_public_registration setting", () => {
  let prisma;
  let endpointPrisma;
  let tmpDir;
  let flagHandler;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "totem-public-registration-test-")
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

    const route = routes.find(
      (r) => r.path === "/system/public-registration" && r.method === "get"
    );
    if (!route) throw new Error("GET /system/public-registration not found");
    flagHandler = route.handler;
  }, 120000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (endpointPrisma) await endpointPrisma.$disconnect();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function getFlag() {
    const response = {
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
    await flagHandler({}, response);
    return { status: response.statusCode, body: response.body };
  }

  async function setSetting(label, value) {
    if (value === null) {
      await prisma.system_settings.deleteMany({ where: { label } });
      return;
    }
    await prisma.system_settings.upsert({
      where: { label },
      update: { value },
      create: { label, value },
    });
  }

  it("SystemSettings.isPublicRegistrationEnabled() defaults to false when unset", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    await setSetting("allow_public_registration", null);
    expect(await SystemSettings.isPublicRegistrationEnabled()).toBe(false);
  });

  it("the flag endpoint reports multiUserMode=false, publicRegistration=false and walletLogin=false on a fresh DB", async () => {
    await setSetting("multi_user_mode", "false");
    await setSetting("allow_public_registration", null);
    await setSetting("allow_wallet_login", null);
    const { status, body } = await getFlag();
    expect(status).toBe(200);
    expect(body).toEqual({
      multiUserMode: false,
      publicRegistration: false,
      walletLogin: false,
    });
  });

  it("the flag endpoint reports publicRegistration=false when the setting is off", async () => {
    await setSetting("multi_user_mode", "true");
    await setSetting("allow_public_registration", "false");
    await setSetting("allow_wallet_login", null);
    const { status, body } = await getFlag();
    expect(status).toBe(200);
    expect(body).toEqual({
      multiUserMode: true,
      publicRegistration: false,
      walletLogin: true,
    });
  });

  it("the flag endpoint reports publicRegistration=true when enabled in multi-user mode", async () => {
    await setSetting("multi_user_mode", "true");
    await setSetting("allow_public_registration", "true");
    const { status, body } = await getFlag();
    expect(status).toBe(200);
    expect(body).toEqual({
      multiUserMode: true,
      publicRegistration: true,
      walletLogin: true,
    });
  });

  it("the flag endpoint reports publicRegistration=false when enabled but multi-user mode is off", async () => {
    await setSetting("multi_user_mode", "false");
    await setSetting("allow_public_registration", "true");
    const { body } = await getFlag();
    expect(body).toEqual({
      multiUserMode: false,
      publicRegistration: false,
      walletLogin: false,
    });
  });

  it("toggling the setting via SystemSettings.updateSettings persists and reverts", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    await setSetting("allow_public_registration", null);

    const { success } = await SystemSettings.updateSettings({
      allow_public_registration: true,
    });
    expect(success).toBe(true);

    const stored = await SystemSettings.get({
      label: "allow_public_registration",
    });
    // Validation normalizes booleans to the string "true"/"false"
    expect(stored?.value).toBe("true");
    expect(await SystemSettings.isPublicRegistrationEnabled()).toBe(true);

    await SystemSettings.updateSettings({ allow_public_registration: false });
    const reverted = await SystemSettings.get({
      label: "allow_public_registration",
    });
    expect(reverted?.value).toBe("false");
    expect(await SystemSettings.isPublicRegistrationEnabled()).toBe(false);
  });

  it("the validation normalizes truthy/falsy garbage instead of storing it raw", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    await SystemSettings.updateSettings({
      allow_public_registration: "yes-please",
    });
    const stored = await SystemSettings.get({
      label: "allow_public_registration",
    });
    expect(stored?.value).toBe("false");
  });
});
