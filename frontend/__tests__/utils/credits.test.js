/**
 * Unit tests for frontend/src/utils/credits.js — the frontend mirror of the
 * server's µ$↔credits conversion (server/utils/credits/units.js).
 *
 * Covers the admin-panel unit conversion (UserRow display + grant flow):
 *   - microToCredits parity with the server implementation (same inputs,
 *     same outputs — the admin table must agree with the user's own
 *     GET /credits balance for the same underlying µ$ value).
 *   - creditsToMicro inverse round-trip for the grant flow.
 *   - Fail-closed guards: a malformed grant amount must throw, never
 *     silently become a 1000×-smaller µ$ grant.
 *
 * Pure Node — no DOM, no network.
 */
const {
  CREDITS_PER_DOLLAR,
  MICRO_PER_CREDIT,
  microToCredits,
  creditsToMicro,
} = require("@/utils/credits");

describe("frontend credits unit helpers", () => {
  describe("constants", () => {
    it("mirror the server's single source of truth (1 credit = $0.001 = 1 000 µ$)", () => {
      expect(CREDITS_PER_DOLLAR).toBe(1000);
      expect(MICRO_PER_CREDIT).toBe(1000);
    });
  });

  describe("microToCredits", () => {
    it("converts µ$ to credits with floor semantics", () => {
      expect(microToCredits(100_000)).toBe(100); // welcome bonus: 100 000 µ$ → 100 credits
      expect(microToCredits(20_000)).toBe(20); // one venice-image generation
      expect(microToCredits(1_000)).toBe(1);
      expect(microToCredits(1_999)).toBe(1); // floors partial credits
      expect(microToCredits(999)).toBe(0);
    });

    it("guards non-finite, zero, and negative inputs to 0", () => {
      expect(microToCredits(0)).toBe(0);
      expect(microToCredits(-5_000)).toBe(0);
      expect(microToCredits(NaN)).toBe(0);
      expect(microToCredits(Infinity)).toBe(0);
      expect(microToCredits(null)).toBe(0);
      expect(microToCredits(undefined)).toBe(0);
      expect(microToCredits("100000")).toBe(0);
    });
  });

  describe("creditsToMicro", () => {
    it("converts whole credits to µ$ (inverse of microToCredits)", () => {
      expect(creditsToMicro(100)).toBe(100_000);
      expect(creditsToMicro(20)).toBe(20_000);
      expect(creditsToMicro(1)).toBe(1_000);
    });

    it("round-trips through microToCredits", () => {
      for (const credits of [1, 20, 100, 25_000]) {
        expect(microToCredits(creditsToMicro(credits))).toBe(credits);
      }
    });

    it("throws on malformed amounts (fail closed — never a silent 1000×-smaller grant)", () => {
      expect(() => creditsToMicro(0)).toThrow();
      expect(() => creditsToMicro(-100)).toThrow();
      expect(() => creditsToMicro(10.5)).toThrow(); // fractional credits rejected
      expect(() => creditsToMicro(NaN)).toThrow();
      expect(() => creditsToMicro(Infinity)).toThrow();
      expect(() => creditsToMicro("100")).toThrow();
      expect(() => creditsToMicro(null)).toThrow();
      expect(() => creditsToMicro(undefined)).toThrow();
    });
  });
});
