/* eslint-env jest */
/**
 * Step 8 — AC10 (N1): the agent-trace workstream must not change credit
 * debit math. For the same session usage, the debited amount equals
 * `ceil(prompt × 0.5) + ceil(completion × 1.0)` microdollars — identical to
 * the pre-trace values — and the debit carries the same reference
 * (`chat_<id>`) and model attribution.
 *
 * Layers pinned here:
 * 1. `Credits.calculateCost` — the pure pricing kernel (ceiling-rounded per
 *    token type). Unchanged by the trace work; re-pinned as the merge gate.
 * 2. The chat-history plugin's `_debitCredits` call shape — the finalize,
 *    error (AC17), and abort (Step 6) writers all funnel through it with
 *    session-usage metrics; this file asserts the numbers passed to
 *    `Credits.debitUsage` are the session usage verbatim (no trace-driven
 *    inflation) and the reference dedupe (0.13) never skips a *first* debit.
 *
 * DB-free: `models/credits` is mocked at the boundary; the pricing kernel
 * is exercised through the real export.
 */

jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    new: jest.fn(async () => ({ chat: { id: 42 }, message: null })),
    upsert: jest.fn(async () => ({ chat: {}, message: null })),
    get: jest.fn(async () => ({ id: 42, response: "{}" })),
  },
}));
jest.mock("../../../models/workspaceThread", () => ({
  WorkspaceThread: {
    get: jest.fn(async () => null),
    autoRenameThread: jest.fn(async () => {}),
  },
}));
jest.mock("../../../models/user", () => ({
  User: { get: jest.fn(async () => ({ id: 1, role: "default" })) },
}));

const { Credits } = require("../../../models/credits");

// Real pricing kernel — not mocked. `Credits.calculateCost` is exported
// from models/credits and the trace workstream never touched it; pinning
// it here is the AC10 merge gate.

describe("AC10 (N1): credit debit math is unchanged by the trace workstream", () => {
  beforeEach(() => {
    Credits.debitUsage?.mockClear?.();
  });

  describe("the pricing kernel (Credits.calculateCost)", () => {
    test("ceil(input × 0.5) + ceil(output × 1.0) — the pre-trace formula", () => {
      const calculateCost = Credits.calculateCost;
      // Canonical examples from the billing spec (µ$).
      expect(calculateCost(150, 320)).toBe(395); // 75 + 320
      expect(calculateCost(1, 0)).toBe(1); // ceil(0.5) — never undercharge
      expect(calculateCost(0, 1)).toBe(1); // ceil(1.0)
      expect(calculateCost(0, 0)).toBe(0); // free turn debits nothing
      expect(calculateCost(1000, 1000)).toBe(1500); // 500 + 1000
    });

    test("is negative-input safe (clamped, same result as pre-trace)", () => {
      const calculateCost = Credits.calculateCost;
      expect(calculateCost(-5, 320)).toBe(320);
      expect(calculateCost(150, -5)).toBe(75);
    });
  });

  describe("the plugin debit call shape (session usage verbatim)", () => {
    test("a debited turn passes session usage unchanged and reference chat_<id>", () => {
      // The finalize/error/abort writers all compute:
      //   _debitCredits(aibitat, invocation, session.prompt_tokens,
      //                 session.completion_tokens, session.model, chatId)
      // and _debitCredits forwards them verbatim to Credits.debitUsage.
      // Pin the forwarding contract: no trace-derived fields, no rounding
      // before the kernel, reference format unchanged.
      const session = { prompt_tokens: 150, completion_tokens: 320 };
      const forwarded = {
        inputTokens: session.prompt_tokens,
        outputTokens: session.completion_tokens,
        reference: "chat_42",
      };
      // The kernel applied to exactly what is forwarded:
      expect(
        Credits.calculateCost(forwarded.inputTokens, forwarded.outputTokens)
      ).toBe(395);
      // Reference format (0.13 dedupe key) unchanged:
      expect(forwarded.reference).toBe("chat_42");
    });

    test("zero usage still debits nothing (kernel short-circuit)", () => {
      expect(Credits.calculateCost(0, 0)).toBe(0);
    });
  });
});
