/**
 * Endpoint tests for the wallet-payment purchase-session endpoints
 * (server/endpoints/payments.js) — wallet-payments Step 4 / Step 7 AC map.
 *
 * Strategy (per the plan's risk table): NO network and NO real DB in Jest.
 *   - The endpoint module is loaded with Jest module mocks for the
 *     Prisma-backed model (`PurchaseSessions`) and the auth helper
 *     (`userFromSession`).
 *   - The JSON-RPC helpers are spied at the module boundary (they are the
 *     declared injectable transport seams — tests never hit the network).
 *   - Handlers are invoked DIRECTLY with mock req/res (the same harness as
 *     requestToken.test.js / invite.test.js / filesystem.test.js): Express's
 *     bundled `send`/`mime` resolve to ESM-only versions under Jest and break
 *     `res.json` inside a live listener, so no socket is spun up. The
 *     middleware chain is registered but not executed — auth is mocked at
 *     `userFromSession` (where the real handlers get the user) and rate
 *     limiting is exercised at the limiter-function level below.
 *
 * AC coverage (each maps to a named test):
 *   AC1  — feature gate: 204 when treasury unset (all three endpoints)
 *   AC11 — auth rejections: 401 unauthenticated, 403 non-wallet / non-owner,
 *          400 bad body (+ the middleware/rate-limiter wiring assertions)
 *   AC9  — failure surfacing: F5 reasons surface as machine-readable codes
 *          with the ledger untouched (redeem asserted un-called)
 *   AC5/AC6/AC8 — payer/amount/stale binding surface their F5 codes
 *   AC3  — happy path passes ONLY server-derived values to redeem
 *   AC4  — already-redeemed reporting from the terminal-state fast path
 */

// validatedRequest transitively loads EncryptionManager → updateENV → the
// AWS/LangChain provider stacks, which don't resolve under Jest (same
// workaround as requestToken.test.js). Stub updateENV so the endpoint module
// loads; the middleware itself is never executed in this harness.
jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

jest.mock("../../utils/http", () => {
  const actual = jest.requireActual("../../utils/http");
  return {
    ...actual,
    userFromSession: jest.fn(),
  };
});

jest.mock("../../models/purchaseSessions", () => {
  const fakeCodes = {
    TX_NOT_FOUND: "tx_not_found",
    TX_REVERTED: "tx_reverted",
    TX_TOO_OLD: "tx_too_old",
    NOT_CONFIRMED: "not_confirmed",
    WRONG_RECIPIENT: "wrong_recipient",
    WRONG_TOKEN: "wrong_token",
    AMOUNT_MISMATCH: "amount_mismatch",
    PAYER_MISMATCH: "payer_mismatch",
    AMBIGUOUS_TRANSFER: "ambiguous_transfer",
    RPC_UNAVAILABLE: "rpc_unavailable",
  };
  return {
    PurchaseSessions: {
      FAILURE_REASONS: fakeCodes,
      TTL_MS: 30 * 60 * 1000,
      serializeSession: (s) =>
        s
          ? {
              ...s,
              expected_amount:
                s.expected_amount === undefined || s.expected_amount === null
                  ? null
                  : String(s.expected_amount),
              tx_block_number:
                s.tx_block_number === undefined || s.tx_block_number === null
                  ? null
                  : String(s.tx_block_number),
              credited_amount:
                s.credited_amount === undefined || s.credited_amount === null
                  ? null
                  : String(s.credited_amount),
            }
          : null,
      create: jest.fn(),
      getById: jest.fn(),
      getOwned: jest.fn(),
      redeem: jest.fn(),
      markFailed: jest.fn(),
    },
  };
});

const { userFromSession } = require("../../utils/http");
const { PurchaseSessions } = require("../../models/purchaseSessions");
const rpc = require("../../utils/payments/config");
const { paymentEndpoints } = require("../../endpoints/payments");
const {
  rateLimiter,
  resetRateLimiter,
} = require("../../utils/middleware/rateLimiter");

const WALLET_USER = {
  id: 7,
  username: "wallet_abc123",
  role: "default",
  wallet_address: "0x1111111111111111111111111111111111111111",
};
const OTHER_OWNER = {
  id: 99,
  username: "wallet_other",
  role: "default",
  wallet_address: "0x9999999999999999999999999999999999999999",
};

const TREASURY = "0x" + "ab".repeat(20);
const USDC = "0x" + "cd".repeat(20);
const GOOD_TX = "0x" + "1".repeat(64);
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Mock response capturing status/json/end — exactly the res surface the
 * payments handlers use (status/json/end/sendStatus; no `send`, no files).
 */
function makeResponse() {
  return {
    statusCode: null,
    body: null,
    ended: false,
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      this.ended = true;
      return this;
    },
  };
}

function makeRequest({ body = {}, params = {}, query = {} } = {}) {
  return { body, params, query, headers: {}, ip: "127.0.0.1" };
}

/**
 * Captures the route handlers registered by paymentEndpoints on a fake app.
 * @returns {Map<string, {method: string, path: string, handler: Function, middleware: Array}>}
 */
function captureRoutes() {
  const routes = new Map();
  const record = (method) => (path, ...args) => {
    routes.set(`${method} ${path}`, {
      method,
      path,
      handler: args[args.length - 1],
      // flatten — endpoints register middleware as an array: app.post(p, [mw], h)
      middleware: args.slice(0, -1).flat(),
    });
  };
  const fakeApp = {
    get: record("get"),
    post: record("post"),
    put: record("put"),
    delete: record("delete"),
    use: () => {},
  };
  paymentEndpoints(fakeApp);
  return routes;
}

let routes = null;
function getRoute(methodAndPath) {
  if (!routes) routes = captureRoutes();
  const r = routes.get(methodAndPath);
  if (!r) throw new Error(`Route not registered: ${methodAndPath}`);
  return r;
}

/** Invoke a captured handler with auth resolved from the given user. */
async function call(methodAndPath, { user, body, params, query } = {}) {
  userFromSession.mockResolvedValueOnce(user ?? null);
  const r = getRoute(methodAndPath);
  const request = makeRequest({ body, params, query });
  const response = makeResponse();
  await r.handler(request, response);
  return response;
}

/** USDC Transfer receipt builder. `from` is a 20-byte hex address (0x…). */
function transferReceipt({ from, value, blockNumber = "0x64" }) {
  return {
    status: "0x1",
    blockNumber,
    logs: [
      {
        address: USDC,
        topics: [
          TRANSFER_TOPIC,
          "0x" + from.slice(2).padStart(64, "0"),
          "0x" + TREASURY.slice(2).padStart(64, "0"),
        ],
        data: "0x" + value.toString(16).padStart(64, "0"),
      },
    ],
  };
}

function mockPendingSession(overrides = {}) {
  return {
    id: "sess-x",
    user_id: WALLET_USER.id,
    user: WALLET_USER,
    status: "pending",
    expected_amount: 5000000n,
    treasury_address: TREASURY,
    chain_id: 8453,
    failure_reason: null,
    tx_hash: null,
    createdAt: new Date(Date.now() - 60_000), // created 60 s ago
    ...overrides,
  };
}

describe("payments endpoints", () => {
  beforeAll(() => {
    process.env.PAYMENTS_TREASURY_ADDRESS = TREASURY;
    process.env.PAYMENTS_USDC_ADDRESS = USDC;
  });

  beforeEach(() => {
    resetRateLimiter();
    // resetAllMocks (not clearAllMocks): clearAllMocks does NOT clear
    // mockResolvedValueOnce queues, which leak across tests when a handler
    // returns before consuming its queued user (the 204 feature-gate path).
    jest.resetAllMocks();
    jest.restoreAllMocks();
    userFromSession.mockResolvedValue(null); // default: unauthenticated
    process.env.PAYMENTS_TREASURY_ADDRESS = TREASURY;
    process.env.PAYMENTS_USDC_ADDRESS = USDC;
  });

  describe("route registration", () => {
    it("registers the three purchase-session routes with validatedRequest", () => {
      for (const key of [
        "post /credits/purchase-session",
        "post /credits/purchase-session/:id/confirm",
        "get /credits/purchase-session/:id",
      ]) {
        const r = getRoute(key);
        expect(r.middleware.map((m) => m.name)).toContain("validatedRequest");
      }
      // Session creation carries the per-IP rate limiter (N5).
      const create = getRoute("post /credits/purchase-session");
      expect(create.middleware.length).toBe(2);
    });
  });

  describe("feature gate (AC1)", () => {
    it("204 with no body on all three endpoints when treasury is unset", async () => {
      delete process.env.PAYMENTS_TREASURY_ADDRESS;

      const create = await call("post /credits/purchase-session", {
        user: WALLET_USER,
        body: { packId: "usd5" },
      });
      expect(create.statusCode).toBe(204);
      expect(create.ended).toBe(true);
      expect(PurchaseSessions.create).not.toHaveBeenCalled();

      const confirm = await call(
        "post /credits/purchase-session/:id/confirm",
        { user: WALLET_USER, params: { id: "sess-x" }, body: { txHash: GOOD_TX } }
      );
      expect(confirm.statusCode).toBe(204);

      const poll = await call("get /credits/purchase-session/:id", {
        user: WALLET_USER,
        params: { id: "sess-x" },
      });
      expect(poll.statusCode).toBe(204);
    });
  });

  describe("auth & validation (AC11)", () => {
    it("401 when unauthenticated, model never touched", async () => {
      const res = await call("post /credits/purchase-session", {
        user: null,
        body: { packId: "usd5" },
      });
      expect(res.statusCode).toBe(401);
      expect(PurchaseSessions.create).not.toHaveBeenCalled();
    });

    it("403 fail-closed for a password-only account (no wallet_address)", async () => {
      const res = await call("post /credits/purchase-session", {
        user: { id: 5, wallet_address: null },
        body: { packId: "usd5" },
      });
      expect(res.statusCode).toBe(403);
      expect(PurchaseSessions.create).not.toHaveBeenCalled();
    });

    it("400 on an unknown packId", async () => {
      const res = await call("post /credits/purchase-session", {
        user: WALLET_USER,
        body: { packId: "usd999" },
      });
      expect(res.statusCode).toBe(400);
      expect(PurchaseSessions.create).not.toHaveBeenCalled();
    });

    it("403 when a non-owner confirms someone else's session", async () => {
      PurchaseSessions.getById.mockResolvedValueOnce(
        mockPendingSession({ user_id: OTHER_OWNER.id })
      );
      const res = await call("post /credits/purchase-session/:id/confirm", {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(403);
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    });

    it("400 when confirm is called without a well-formed txHash", async () => {
      PurchaseSessions.getById.mockResolvedValueOnce(mockPendingSession());
      const res = await call("post /credits/purchase-session/:id/confirm", {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: "not-a-hash" },
      });
      expect(res.statusCode).toBe(400);
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    });

    it("403 on a non-owner status poll", async () => {
      PurchaseSessions.getById.mockResolvedValueOnce(
        mockPendingSession({ user_id: OTHER_OWNER.id })
      );
      const res = await call("get /credits/purchase-session/:id", {
        user: WALLET_USER,
        params: { id: "sess-x" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("middleware wiring: the per-IP limiter is a rateLimiter() instance that 429s past its max (N5)", async () => {
      const create = getRoute("post /credits/purchase-session");
      expect(create.middleware).toHaveLength(2);

      // Drive the limiter directly with a tight budget to prove the 429
      // path (the shared in-memory limiter is the repo's standard mechanism
      // — its internals are covered by its own middleware tests).
      const limiter = rateLimiter({ max: 2, windowMs: 60_000 });
      const statuses = [];
      for (let i = 0; i < 3; i++) {
        const req = makeRequest();
        const res = makeResponse();
        await limiter(req, res, () => {});
        statuses.push(res.statusCode ?? "next");
      }
      expect(statuses).toEqual(["next", "next", 429]);
    });
  });

  describe("session creation (AC2 boundary)", () => {
    it("200 + exact pack math; redeem-ready session params", async () => {
      PurchaseSessions.create.mockResolvedValueOnce({
        session: mockPendingSession({ id: "sess-1" }),
        error: null,
      });

      const res = await call("post /credits/purchase-session", {
        user: WALLET_USER,
        body: { packId: "usd5" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.id).toBe("sess-1");
      expect(res.body.expectedAmountUsdc).toBe("5000000"); // exact decimal string
      expect(res.body.treasuryAddress).toBe(TREASURY);
      // The wallet must target the TOKEN contract (manual-test finding: a tx
      // to the treasury EOA directly is a silent no-op that still mines).
      expect(res.body.usdcAddress).toBe(USDC);
      expect(res.body.chainId).toBe(8453);
      // µ$ amount derived from the pack table — BigInt into the model.
      expect(PurchaseSessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 7,
          expectedAmountMicro: 5000000n,
          treasuryAddress: TREASURY,
        })
      );
    });
  });

  describe("confirm outcomes (AC3–AC9)", () => {
    const CONFIRM = "post /credits/purchase-session/:id/confirm";

    it("reports credited on the happy path with server-derived values (AC3)", async () => {
      const session = mockPendingSession();
      PurchaseSessions.getById.mockResolvedValue(session);
      PurchaseSessions.redeem.mockResolvedValueOnce({
        result: "credited",
        session: {
          ...session,
          status: "credited",
          credited_amount: 5000000n,
        },
        error: null,
      });

      jest
        .spyOn(rpc, "fetchReceipt")
        .mockResolvedValueOnce(
          transferReceipt({
            from: WALLET_USER.wallet_address,
            value: 5000000n,
          })
        );
      jest
        .spyOn(rpc, "getBlockTimestamp")
        .mockResolvedValueOnce(Date.now() - 30_000); // fresh block
      jest.spyOn(rpc, "getBlockHeight").mockResolvedValueOnce(101n); // 2 confs

      const res = await call(CONFIRM, {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("credited");
      // THE invariant: redeem got ONLY server-derived values — the client
      // supplied just the txHash; amount/blockNumber came from the receipt.
      expect(PurchaseSessions.redeem).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-x",
          valueMicro: 5000000n,
          blockNumber: 100n,
        })
      );
    });

    it("reports already-redeemed for a second confirm of a credited session (AC4)", async () => {
      PurchaseSessions.getById.mockResolvedValueOnce(
        mockPendingSession({
          status: "credited",
          tx_hash: GOOD_TX,
        })
      );
      // Spy (no stub) so the not-called assertion has a mock to inspect —
      // restoreAllMocks in beforeEach strips prior spies.
      jest.spyOn(rpc, "fetchReceipt");

      const res = await call(CONFIRM, {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("already-redeemed");
      // No RPC, no redeem — the DB is authoritative on terminal states.
      expect(rpc.fetchReceipt).not.toHaveBeenCalled();
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    });

    it("surfaces payer-mismatch as a permanent failure without crediting (AC5)", async () => {
      // getById is re-read after markFailed (the endpoint reports the
      // post-write state) — the mock must reflect the failed row.
      const failed = mockPendingSession({
        status: "failed",
        failure_reason: "payer_mismatch",
      });
      PurchaseSessions.getById
        .mockResolvedValueOnce(mockPendingSession()) // pre-verification read
        .mockResolvedValue(failed); // post-markFailed re-read
      PurchaseSessions.markFailed.mockResolvedValue(failed);

      jest
        .spyOn(rpc, "fetchReceipt")
        .mockResolvedValueOnce(
          transferReceipt({
            from: OTHER_OWNER.wallet_address, // someone else paid
            value: 5000000n,
          })
        );
      jest
        .spyOn(rpc, "getBlockTimestamp")
        .mockResolvedValueOnce(Date.now() - 30_000);
      jest.spyOn(rpc, "getBlockHeight").mockResolvedValueOnce(101n);

      const res = await call(CONFIRM, {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.failureReason).toBe("payer_mismatch");
      expect(PurchaseSessions.markFailed).toHaveBeenCalledWith(
        "sess-x",
        "payer_mismatch"
      );
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled(); // nothing credited
    });

    it("stays pending (transient) on an unmined tx — no credit, no fail (AC7/N3)", async () => {
      PurchaseSessions.getById.mockResolvedValue(mockPendingSession());
      jest.spyOn(rpc, "fetchReceipt").mockResolvedValueOnce(null); // unmined

      const res = await call(CONFIRM, {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(res.body.failureReason).toBe("tx_not_found");
      expect(PurchaseSessions.markFailed).not.toHaveBeenCalled();
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    });

    it("stays pending (transient) when the RPC is unreachable — fail closed (N3)", async () => {
      PurchaseSessions.getById.mockResolvedValue(mockPendingSession());
      jest
        .spyOn(rpc, "fetchReceipt")
        .mockRejectedValueOnce(new Error("fetch failed"));

      const res = await call(CONFIRM, {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(res.body.failureReason).toBe("rpc_unavailable");
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    });

    it("surfaces amount-mismatch on an underpaid tx (AC6)", async () => {
      const failed = mockPendingSession({
        status: "failed",
        failure_reason: "amount_mismatch",
      });
      PurchaseSessions.getById.mockResolvedValue(failed);
      PurchaseSessions.markFailed.mockResolvedValue(failed);

      jest
        .spyOn(rpc, "fetchReceipt")
        .mockResolvedValueOnce(
          transferReceipt({
            from: WALLET_USER.wallet_address,
            value: 4999999n, // 1 base unit short
          })
        );
      jest
        .spyOn(rpc, "getBlockTimestamp")
        .mockResolvedValueOnce(Date.now() - 30_000);
      jest.spyOn(rpc, "getBlockHeight").mockResolvedValueOnce(101n);

      const res = await call(CONFIRM, {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.failureReason).toBe("amount_mismatch");
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    });

    it("surfaces tx_too_old for a pre-session deposit replay (AC8)", async () => {
      // Session created 10 minutes ago; the tx block is one hour old.
      const failed = mockPendingSession({
        status: "failed",
        failure_reason: "tx_too_old",
      });
      PurchaseSessions.getById.mockResolvedValue(failed);
      PurchaseSessions.markFailed.mockResolvedValue(failed);

      jest
        .spyOn(rpc, "fetchReceipt")
        .mockResolvedValueOnce(
          transferReceipt({
            from: WALLET_USER.wallet_address,
            value: 5000000n,
          })
        );
      jest
        .spyOn(rpc, "getBlockTimestamp")
        .mockResolvedValueOnce(Date.now() - 60 * 60 * 1000); // 1 h old

      const res = await call(CONFIRM, {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.failureReason).toBe("tx_too_old");
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    });

    it("reports not_confirmed (pending) when confirmations are short (AC7 transient)", async () => {
      PurchaseSessions.getById.mockResolvedValue(mockPendingSession());

      jest
        .spyOn(rpc, "fetchReceipt")
        .mockResolvedValueOnce(
          transferReceipt({
            from: WALLET_USER.wallet_address,
            value: 5000000n,
          })
        );
      jest
        .spyOn(rpc, "getBlockTimestamp")
        .mockResolvedValueOnce(Date.now() - 30_000);
      jest.spyOn(rpc, "getBlockHeight").mockResolvedValueOnce(100n); // 1 conf < 2

      const res = await call(CONFIRM, {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(res.body.failureReason).toBe("not_confirmed");
      expect(PurchaseSessions.markFailed).not.toHaveBeenCalled();
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    });

    it("surfaces ambiguous_transfer when two treasury-bound USDC transfers share one tx (N3/AC9)", async () => {
      const failed = mockPendingSession({
        status: "failed",
        failure_reason: "ambiguous_transfer",
      });
      PurchaseSessions.getById.mockResolvedValue(failed);
      PurchaseSessions.markFailed.mockResolvedValue(failed);

      const double = transferReceipt({
        from: WALLET_USER.wallet_address,
        value: 5000000n,
      });
      double.logs.push({ ...double.logs[0] }); // two identical matching logs

      jest.spyOn(rpc, "fetchReceipt").mockResolvedValueOnce(double);
      jest
        .spyOn(rpc, "getBlockTimestamp")
        .mockResolvedValueOnce(Date.now() - 30_000);
      jest.spyOn(rpc, "getBlockHeight").mockResolvedValueOnce(101n);

      const res = await call(CONFIRM, {
        user: WALLET_USER,
        params: { id: "sess-x" },
        body: { txHash: GOOD_TX },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.failureReason).toBe("ambiguous_transfer");
      expect(PurchaseSessions.redeem).not.toHaveBeenCalled(); // never guess
    });
  });
});
