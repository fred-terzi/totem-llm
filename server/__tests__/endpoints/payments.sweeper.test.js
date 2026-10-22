/**
 * Sweeper tests for the wallet-payment background recovery loop
 * (server/endpoints/payments.js `paymentSweeper` / `runPaymentSweep`) —
 * wallet-payments Step 5, AC10.
 *
 * Strategy: identical harness to payments.test.js — the endpoint module is
 * loaded with Jest module mocks for the Prisma-backed model
 * (`PurchaseSessions`) and auth; the JSON-RPC helpers are spied at the
 * module boundary (no network). The sweep function is invoked DIRECTLY via
 * the exported `runPaymentSweep` — no timers, no sleeps.
 *
 * AC map (each AC maps to a named test):
 *   AC10a — expiry: a past-TTL session with no tx → marked `expired`
 *           (expireStale bulk sweep)
 *   AC10b — crashed-tab credit-once: a pending session whose submitted tx
 *           now confirms → sweeper credits it EXACTLY ONCE via the same
 *           `redeem` the confirm endpoint uses; a second sweep run makes
 *           no further redeem attempt (session is terminal)
 *   AC10c — invariants hold: sweeper passes only server-derived values to
 *           redeem (never trusts the stored claim amount alone)
 *   plus  — stuck `crediting` claims are routed to `resolveStuckClaim`
 *           (crash windows), and the feature gate disables the whole loop
 */

jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

// The sweeper reads stuck claims straight off prisma.purchase_sessions —
// mock the client surface the module touches (no real DB in Jest).
// `server/utils/prisma` is CJS `module.exports = prisma` — the mock is the
// client instance itself.
jest.mock("../../utils/prisma", () => ({
  purchase_sessions: {
    findMany: jest.fn(async () => []),
  },
}));

jest.mock("../../models/purchaseSessions", () => {
  return {
    PurchaseSessions: {
      // Same machine-readable codes as the real model (the sweep logic
      // branches on these exact strings via verifyReceipt's returns).
      FAILURE_REASONS: {
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
      },
      CREDITING_STALE_MS: 60 * 1000,
      expireStale: jest.fn(async () => 0),
      resolveStuckClaim: jest.fn(async () => "error"),
      findSweepable: jest.fn(async () => []),
      redeem: jest.fn(),
      markFailed: jest.fn(),
      markExpired: jest.fn(),
    },
  };
});

const prisma = require("../../utils/prisma");
const { PurchaseSessions } = require("../../models/purchaseSessions");
const rpc = require("../../utils/payments/config");
const { paymentSweeper, runPaymentSweep } = require("../../endpoints/payments");

const TREASURY = "0x" + "ab".repeat(20);
const USDC = "0x" + "cd".repeat(20);
const TX_HASH = "0x" + "1".repeat(64);

function mockSession(overrides = {}) {
  return {
    id: "sess-sweep",
    user_id: 7,
    user: { id: 7, wallet_address: "0x1111111111111111111111111111111111111111" },
    status: "pending",
    expected_amount: 5000000n,
    treasury_address: TREASURY,
    chain_id: 8453,
    failure_reason: null,
    tx_hash: TX_HASH,
    tx_block_number: null,
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(),
    expires_at: new Date(Date.now() + 25 * 60 * 1000),
    ...overrides,
  };
}

function freshReceipt() {
  return {
    status: "0x1",
    blockNumber: "0x64",
    logs: [
      {
        address: USDC,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x" + "0".repeat(24) + "1111111111111111111111111111111111111111",
          "0x" + "0".repeat(24) + TREASURY.slice(2).toLowerCase(),
        ],
        data: "0x" + (5000000n).toString(16).padStart(64, "0"),
      },
    ],
  };
}

beforeAll(() => {
  process.env.PAYMENTS_TREASURY_ADDRESS = TREASURY;
  process.env.PAYMENTS_USDC_ADDRESS = USDC;
});

beforeEach(() => {
  jest.resetAllMocks();
  jest.restoreAllMocks();
  process.env.PAYMENTS_TREASURY_ADDRESS = TREASURY;
  process.env.PAYMENTS_USDC_ADDRESS = USDC;
  prisma.purchase_sessions.findMany.mockResolvedValue([]);
  PurchaseSessions.findSweepable.mockResolvedValue([]);
  PurchaseSessions.expireStale.mockResolvedValue(0);
});

describe("paymentSweeper scheduling", () => {
  it("returns a timer when the feature is enabled (F1)", () => {
    const timer = paymentSweeper();
    expect(timer).not.toBeNull();
    clearInterval(timer);
  });

  it("schedules nothing when the feature is disabled (no treasury)", () => {
    delete process.env.PAYMENTS_TREASURY_ADDRESS;
    expect(paymentSweeper()).toBeNull();
  });
});

describe("runPaymentSweep — expiry (AC10a)", () => {
  it("bulk-expires past-TTL sessions with no submitted tx", async () => {
    PurchaseSessions.expireStale.mockResolvedValueOnce(3);

    await runPaymentSweep();

    expect(PurchaseSessions.expireStale).toHaveBeenCalledTimes(1);
  });

  it("expireStale is never called when the feature is disabled", async () => {
    delete process.env.PAYMENTS_TREASURY_ADDRESS;

    await runPaymentSweep();

    expect(PurchaseSessions.expireStale).not.toHaveBeenCalled();
  });
});

describe("runPaymentSweep — stuck crediting claims (crash windows)", () => {
  it("routes stale crediting rows to resolveStuckClaim and leaves fresh ones alone", async () => {
    const stale = mockSession({
      status: "crediting",
      updatedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const fresh = mockSession({
      id: "sess-fresh",
      status: "crediting",
      updatedAt: new Date(), // in-flight — a concurrent caller owns it
    });
    prisma.purchase_sessions.findMany.mockResolvedValueOnce([stale, fresh]);
    PurchaseSessions.resolveStuckClaim.mockResolvedValueOnce("released");

    await runPaymentSweep();

    expect(PurchaseSessions.resolveStuckClaim).toHaveBeenCalledTimes(1);
    expect(PurchaseSessions.resolveStuckClaim).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sess-sweep" })
    );
    // A released crash artifact is NOT re-redeemed by the same sweep —
    // the next sweep's verification pass picks it up (one mutation per
    // row per pass keeps reasoning simple and races impossible).
    expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
  });
});

describe("runPaymentSweep — crashed-tab recovery (AC10b/AC10c)", () => {
  it("credits a pending session whose submitted tx now confirms — exactly once", async () => {
    const session = mockSession();
    PurchaseSessions.findSweepable.mockResolvedValueOnce([session]);
    jest.spyOn(rpc, "fetchReceipt").mockResolvedValueOnce(freshReceipt());
    jest
      .spyOn(rpc, "getBlockTimestamp")
      .mockResolvedValueOnce(Date.now() - 30_000);
    jest.spyOn(rpc, "getBlockHeight").mockResolvedValueOnce(101n); // 2 confs
    PurchaseSessions.redeem.mockResolvedValueOnce({
      result: "credited",
      session: { ...session, status: "credited" },
      error: null,
    });

    const capErr = jest.spyOn(console, "error").mockImplementation(() => {});
    await runPaymentSweep();
    capErr.mockRestore();

    expect(PurchaseSessions.redeem).toHaveBeenCalledTimes(1);
    expect(PurchaseSessions.redeem).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-sweep",
        txHash: TX_HASH,
        blockNumber: 100n, // server-derived from the receipt
        valueMicro: 5000000n, // server-derived from the Transfer log
      })
    );
  });

  it("a second sweep run makes no further redeem attempt (exactly-once, AC10)", async () => {
    // After the first sweep credited the session, findSweepable no longer
    // returns it (status is terminal — the query filters pending/crediting).
    PurchaseSessions.findSweepable.mockResolvedValueOnce([mockSession()]);
    jest.spyOn(rpc, "fetchReceipt").mockResolvedValueOnce(freshReceipt());
    jest.spyOn(rpc, "getBlockTimestamp").mockResolvedValueOnce(Date.now() - 30_000);
    jest.spyOn(rpc, "getBlockHeight").mockResolvedValueOnce(101n);
    PurchaseSessions.redeem.mockResolvedValue({
      result: "credited",
      session: null,
      error: null,
    });

    await runPaymentSweep();
    expect(PurchaseSessions.redeem).toHaveBeenCalledTimes(1);

    // Second sweep: the session has reached a terminal state → not sweepable.
    PurchaseSessions.findSweepable.mockResolvedValueOnce([]);
    await runPaymentSweep();
    expect(PurchaseSessions.redeem).toHaveBeenCalledTimes(1); // unchanged
  });

  it("never trusts the stored claim alone — an RPC failure leaves the session pending for retry", async () => {
    PurchaseSessions.findSweepable.mockResolvedValueOnce([mockSession()]);
    jest.spyOn(rpc, "fetchReceipt").mockRejectedValueOnce(new Error("fetch failed"));

    await runPaymentSweep();

    expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    expect(PurchaseSessions.markFailed).not.toHaveBeenCalled();
    // Not past TTL → not expired either; retried next sweep.
    expect(PurchaseSessions.markExpired).not.toHaveBeenCalled();
  });

  it("expires a submitted-but-unmined session once its TTL passes (AC10a tail)", async () => {
    const session = mockSession({
      expires_at: new Date(Date.now() - 60_000), // TTL passed
    });
    PurchaseSessions.findSweepable.mockResolvedValueOnce([session]);
    jest.spyOn(rpc, "fetchReceipt").mockResolvedValueOnce(null); // never mined

    await runPaymentSweep();

    expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    expect(PurchaseSessions.markExpired).toHaveBeenCalledWith(
      "sess-sweep",
      "tx_not_found"
    );
    expect(PurchaseSessions.markFailed).not.toHaveBeenCalled();
  });

  it("fails a submitted session whose tx is permanently invalid (reverted)", async () => {
    PurchaseSessions.findSweepable.mockResolvedValueOnce([mockSession()]);
    jest
      .spyOn(rpc, "fetchReceipt")
      .mockResolvedValueOnce({ ...freshReceipt(), status: "0x0" }); // reverted

    await runPaymentSweep();

    expect(PurchaseSessions.redeem).not.toHaveBeenCalled();
    expect(PurchaseSessions.markFailed).toHaveBeenCalledWith(
      "sess-sweep",
      "tx_reverted"
    );
  });
});
