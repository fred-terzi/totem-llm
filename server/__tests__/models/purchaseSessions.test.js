const { PurchaseSessions } = require("../../models/purchaseSessions");

// Unit tests for the pure/static helpers of the purchaseSessions model —
// no DB required. The DB-level invariants (P2002 anchor, cascade, BigInt
// roundtrip) were verified live against SQLite in Step 2; the redeem
// pipeline's integration behavior is covered by the endpoint tests (Step 7).

describe("PurchaseSessions.FAILURE_REASONS", () => {
  it("exposes a stable machine-readable code for every F5 failure mode", () => {
    const codes = Object.values(PurchaseSessions.FAILURE_REASONS);
    // spec F5's six verification checks + transport-level failures
    for (const expected of [
      "tx_not_found",
      "tx_reverted",
      "tx_too_old",
      "not_confirmed",
      "amount_mismatch",
      "payer_mismatch",
      "ambiguous_transfer",
      "rpc_unavailable",
    ]) {
      expect(codes).toContain(expected);
    }
  });

  it("has no duplicate codes (codes are unique)", () => {
    const codes = Object.values(PurchaseSessions.FAILURE_REASONS);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("PurchaseSessions.serializeSession", () => {
  it("converts BigInt fields to exact decimal strings", () => {
    const out = PurchaseSessions.serializeSession({
      id: "s1",
      expected_amount: 10000000n,
      tx_block_number: 123n,
      credited_amount: 10000000n,
      status: "credited",
    });
    expect(out.expected_amount).toBe("10000000");
    expect(out.tx_block_number).toBe("123");
    expect(out.credited_amount).toBe("10000000");
    // result must be JSON-safe (JSON.stringify throws on raw BigInt)
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("passes null BigInt fields through as null", () => {
    const out = PurchaseSessions.serializeSession({
      id: "s2",
      expected_amount: 5_000_000n,
      tx_block_number: null,
      credited_amount: null,
      status: "pending",
    });
    expect(out.tx_block_number).toBeNull();
    expect(out.credited_amount).toBeNull();
  });

  it("returns null for a null session", () => {
    expect(PurchaseSessions.serializeSession(null)).toBeNull();
  });

  it("preserves non-BigInt fields untouched", () => {
    const out = PurchaseSessions.serializeSession({
      id: "s3",
      status: "failed",
      failure_reason: "amount_mismatch",
      expected_amount: 1n,
      tx_block_number: null,
      credited_amount: null,
    });
    expect(out.id).toBe("s3");
    expect(out.status).toBe("failed");
    expect(out.failure_reason).toBe("amount_mismatch");
  });
});

describe("PurchaseSessions session constants", () => {
  it("session TTL is 30 minutes (spec F4)", () => {
    expect(PurchaseSessions.TTL_MS).toBe(30 * 60 * 1000);
  });

  it("crediting-claim staleness window is positive and short (crash recovery)", () => {
    expect(PurchaseSessions.CREDITING_STALE_MS).toBeGreaterThan(0);
    expect(PurchaseSessions.CREDITING_STALE_MS).toBeLessThanOrEqual(
      PurchaseSessions.TTL_MS
    );
  });
});
