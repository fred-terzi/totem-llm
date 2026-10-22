jest.mock("@/utils/constants", () => ({ API_BASE: "/api" }));
jest.mock("@/utils/request", () => ({ baseHeaders: () => ({}) }));
const { resolvePurchaseSession } = require("@/utils/payments");

const base = {
  sessionId: "s-1",
  txHash: "0x" + "1".repeat(64),
  sleepFn: async () => {},
};

describe("resolvePurchaseSession (F9 confirm + poll loop)", () => {
  it("returns credited immediately on a first-pass confirm", async () => {
    const confirmFn = jest
      .fn()
      .mockResolvedValue({ status: "credited", session: { id: "s-1" } });
    const result = await resolvePurchaseSession({ ...base, confirmFn });
    expect(result.status).toBe("credited");
    expect(confirmFn).toHaveBeenCalledTimes(1);
  });

  it("treats already-redeemed as terminal (AC4 shape)", async () => {
    const confirmFn = jest
      .fn()
      .mockResolvedValue({ status: "already-redeemed" });
    const result = await resolvePurchaseSession({ ...base, confirmFn });
    expect(result.status).toBe("already-redeemed");
  });

  it("polls status and re-confirms until a terminal state arrives", async () => {
    const confirmFn = jest
      .fn()
      .mockResolvedValueOnce({
        status: "pending",
        failureReason: "not_confirmed",
      })
      .mockResolvedValueOnce({ status: "credited" });
    const statusFn = jest
      .fn()
      .mockResolvedValue({ session: { status: "pending" } });
    const result = await resolvePurchaseSession({
      ...base,
      confirmFn,
      statusFn,
    });
    expect(result.status).toBe("credited");
    expect(statusFn).toHaveBeenCalledTimes(1);
    expect(confirmFn).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed session with its reason", async () => {
    const confirmFn = jest
      .fn()
      .mockResolvedValue({
        status: "failed",
        failureReason: "amount_mismatch",
      });
    const result = await resolvePurchaseSession({ ...base, confirmFn });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("amount_mismatch");
  });

  it("reads a terminal state from the GET poll even when confirm stayed pending", async () => {
    const confirmFn = jest
      .fn()
      .mockResolvedValue({
        status: "pending",
        failureReason: "not_confirmed",
      });
    const statusFn = jest
      .fn()
      .mockResolvedValue({
        session: { status: "credited", failure_reason: null },
      });
    const result = await resolvePurchaseSession({
      ...base,
      confirmFn,
      statusFn,
    });
    expect(result.status).toBe("credited");
  });

  it("surfaces expired from the poll", async () => {
    const confirmFn = jest
      .fn()
      .mockResolvedValue({ status: "pending", failureReason: "tx_not_found" });
    const statusFn = jest
      .fn()
      .mockResolvedValue({
        session: { status: "expired", failure_reason: "session_expired" },
      });
    const result = await resolvePurchaseSession({
      ...base,
      confirmFn,
      statusFn,
    });
    expect(result.status).toBe("expired");
    expect(result.failureReason).toBe("session_expired");
  });

  it("reports pending (sweeper handoff) when the deadline passes", async () => {
    const confirmFn = jest
      .fn()
      .mockResolvedValue({ status: "pending", failureReason: "tx_not_found" });
    const result = await resolvePurchaseSession({
      ...base,
      confirmFn,
      deadlineMs: 0, // deadline already passed after the first confirm
    });
    expect(result.status).toBe("pending");
    expect(result.failureReason).toBe("tx_not_found");
  });

  it("maps a feature-disabled (204) confirm response to a failed session", async () => {
    const confirmFn = jest.fn().mockResolvedValue({ available: false });
    const result = await resolvePurchaseSession({ ...base, confirmFn });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("feature_disabled");
  });

  it("maps a feature-disabled (204) status response to a failed session", async () => {
    const confirmFn = jest
      .fn()
      .mockResolvedValue({ status: "pending", failureReason: "not_confirmed" });
    const statusFn = jest.fn().mockResolvedValue({ available: false });
    const result = await resolvePurchaseSession({
      ...base,
      confirmFn,
      statusFn,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("feature_disabled");
  });

  it("returns cancelled before any polling once the modal unmounts", async () => {
    const confirmFn = jest
      .fn()
      .mockResolvedValue({ status: "pending", failureReason: "not_confirmed" });
    const statusFn = jest
      .fn()
      .mockResolvedValue({ session: { status: "pending" } });
    const result = await resolvePurchaseSession({
      ...base,
      confirmFn,
      statusFn,
      isCancelled: () => true,
    });
    expect(result.status).toBe("cancelled");
    expect(statusFn).not.toHaveBeenCalled();
  });
});
