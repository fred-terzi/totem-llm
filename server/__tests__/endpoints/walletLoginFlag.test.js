const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

// system.js transitively imports heavy LLM provider stacks (AWS SDK, etc.)
// that are irrelevant to these endpoints — stub updateENV so the endpoint
// modules load in the test environment (same pattern as the other
// endpoint tests).
jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

const SERVER_DIR = path.join(__dirname, "..", "..");

/**
 * Tests for the allow_wallet_login setting, its exposure on the
 * unauthenticated GET /system/public-registration flag endpoint, and the
 * gating of POST /auth/wallet/nonce + POST /auth/wallet/verify.
 *
 * Same harness as publicRegistrationFlag.test.js: capture the registered
 * route handlers via a fake `app`, invoke them directly with mock
 * request/response objects, against a real throwaway SQLite database
 * (full migration history applied).
 */
describe("allow_wallet_login setting", () => {
  let prisma;
  let endpointPrisma;
  let tmpDir;
  let flagHandler;
  let nonceHandler;
  let verifyHandler;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "totem-wallet-login-test-")
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

    // Capture the route handlers registered by systemEndpoints() and
    // walletEndpoints()
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
    const { walletEndpoints } = require("../../endpoints/wallet");
    walletEndpoints(fakeApp);

    // The endpoints' models use fresh `../utils/prisma` singletons (created
    // after resetModules). Grab the same instance so we can close its
    // connection pool in afterAll and let jest exit cleanly.
    endpointPrisma = require("../../utils/prisma");

    const flagRoute = routes.find(
      (r) => r.path === "/system/public-registration" && r.method === "get"
    );
    if (!flagRoute)
      throw new Error("GET /system/public-registration not found");
    flagHandler = flagRoute.handler;

    const nonceRoute = routes.find(
      (r) => r.path === "/auth/wallet/nonce" && r.method === "post"
    );
    if (!nonceRoute) throw new Error("POST /auth/wallet/nonce not found");
    nonceHandler = nonceRoute.handler;

    const verifyRoute = routes.find(
      (r) => r.path === "/auth/wallet/verify" && r.method === "post"
    );
    if (!verifyRoute) throw new Error("POST /auth/wallet/verify not found");
    verifyHandler = verifyRoute.handler;
  }, 120000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (endpointPrisma) await endpointPrisma.$disconnect();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockResponse() {
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
      end() {},
    };
  }

  async function getFlag() {
    const response = mockResponse();
    await flagHandler({}, response);
    return { status: response.statusCode, body: response.body };
  }

  async function callHandler(handler, body = {}) {
    const response = mockResponse();
    await handler({ body, ip: "127.0.0.1", url: "" }, response);
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

  // ---------------------------------------------------------------
  // Model: default + sanitizer
  // ---------------------------------------------------------------

  it("SystemSettings.isWalletLoginEnabled() defaults to true when unset (back-compat)", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    await setSetting("allow_wallet_login", null);
    expect(await SystemSettings.isWalletLoginEnabled()).toBe(true);
  });

  it("SystemSettings.isWalletLoginEnabled() reflects the stored value", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    await setSetting("allow_wallet_login", "false");
    expect(await SystemSettings.isWalletLoginEnabled()).toBe(false);
    await setSetting("allow_wallet_login", "true");
    expect(await SystemSettings.isWalletLoginEnabled()).toBe(true);
  });

  it("toggling the setting via SystemSettings.updateSettings persists and reverts", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    await setSetting("allow_wallet_login", null);

    const { success } = await SystemSettings.updateSettings({
      allow_wallet_login: false,
    });
    expect(success).toBe(true);

    const stored = await SystemSettings.get({ label: "allow_wallet_login" });
    // Validation normalizes booleans to the string "true"/"false"
    expect(stored?.value).toBe("false");
    expect(await SystemSettings.isWalletLoginEnabled()).toBe(false);

    await SystemSettings.updateSettings({ allow_wallet_login: true });
    const reverted = await SystemSettings.get({
      label: "allow_wallet_login",
    });
    expect(reverted?.value).toBe("true");
    expect(await SystemSettings.isWalletLoginEnabled()).toBe(true);
  });

  it("the validation normalizes truthy/falsy garbage instead of storing it raw", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    await SystemSettings.updateSettings({ allow_wallet_login: "yes-please" });
    const stored = await SystemSettings.get({ label: "allow_wallet_login" });
    expect(stored?.value).toBe("false");
  });

  // ---------------------------------------------------------------
  // Flag endpoint
  // ---------------------------------------------------------------

  it("the flag endpoint reports walletLogin=false on a fresh DB (not multi-user)", async () => {
    await setSetting("multi_user_mode", "false");
    await setSetting("allow_wallet_login", null);
    const { status, body } = await getFlag();
    expect(status).toBe(200);
    expect(body).toEqual({
      multiUserMode: false,
      publicRegistration: false,
      walletLogin: false,
    });
  });

  it("the flag endpoint reports walletLogin=true by default in multi-user mode", async () => {
    await setSetting("multi_user_mode", "true");
    await setSetting("allow_wallet_login", null);
    const { status, body } = await getFlag();
    expect(status).toBe(200);
    expect(body).toEqual({
      multiUserMode: true,
      publicRegistration: false,
      walletLogin: true,
    });
  });

  it("the flag endpoint reports walletLogin=false when disabled in multi-user mode", async () => {
    await setSetting("multi_user_mode", "true");
    await setSetting("allow_wallet_login", "false");
    const { body } = await getFlag();
    expect(body).toEqual({
      multiUserMode: true,
      publicRegistration: false,
      walletLogin: false,
    });
  });

  // ---------------------------------------------------------------
  // Endpoint gating
  // ---------------------------------------------------------------

  it("POST /auth/wallet/nonce is refused with 403 when wallet login is disabled", async () => {
    await setSetting("multi_user_mode", "true");
    await setSetting("allow_wallet_login", "false");

    const { status, body } = await callHandler(nonceHandler, { origin: "" });
    expect(status).toBe(403);
    expect(body).toEqual({
      error: "Wallet login is disabled. Use your username and password.",
    });
  });

  it("POST /auth/wallet/verify is refused with 403 in the { valid, user, token, message } shape when disabled", async () => {
    await setSetting("multi_user_mode", "true");
    await setSetting("allow_wallet_login", "false");

    const { status, body } = await callHandler(verifyHandler, {
      signature: "0xdeadbeef",
      nonce: "some-nonce",
    });
    expect(status).toBe(403);
    expect(body).toEqual({
      valid: false,
      user: null,
      token: null,
      message: "Wallet login is disabled. Use your username and password.",
    });
  });

  it("both wallet endpoints are refused when multi-user mode is off (even with the flag on)", async () => {
    await setSetting("multi_user_mode", "false");
    await setSetting("allow_wallet_login", "true");

    const nonceResult = await callHandler(nonceHandler, { origin: "" });
    expect(nonceResult.status).toBe(403);

    const verifyResult = await callHandler(verifyHandler, {
      signature: "0xdeadbeef",
      nonce: "some-nonce",
    });
    expect(verifyResult.status).toBe(403);
  });

  it("a blocked verify attempt is recorded in the event log as wallet_login_blocked", async () => {
    await setSetting("multi_user_mode", "true");
    await setSetting("allow_wallet_login", "false");

    await callHandler(verifyHandler, {
      signature: "0xdeadbeef",
      nonce: "some-nonce",
    });

    const { EventLogs } = require("../../models/eventLogs");
    const logs = await EventLogs.getByEvent("wallet_login_blocked", 1);
    expect(logs.length).toBeGreaterThan(0);
    const metadata = JSON.parse(logs[0].metadata || "{}");
    expect(metadata.endpoint).toBe("verify");
    expect(metadata.reason).toBe("wallet-login-disabled");
  });

  it("a disabled gate does not consume or mutate nonce state (no wallet:* rows written by nonce)", async () => {
    await setSetting("multi_user_mode", "true");
    await setSetting("allow_wallet_login", "false");

    await callHandler(nonceHandler, { origin: "" });

    const { CacheData } = require("../../models/cacheData");
    const activeNonces = await CacheData.count({
      name: { startsWith: "wallet:nonce:" },
    });
    expect(activeNonces).toBe(0);
  });
});
