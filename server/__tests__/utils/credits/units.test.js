const {
  CREDITS_PER_DOLLAR,
  microToCredits,
  formatLedgerCredits,
} = require("../../../utils/credits/units");

// Unit tests for the credit unit conversion helpers (credit-units workstream).
// Pure functions — no DB required.

describe("CREDITS_PER_DOLLAR (single source of truth, credit-units F1/AC1)", () => {
  it("is exactly 1000 (1 credit = $0.001 = 1000 µ$)", () => {
    expect(CREDITS_PER_DOLLAR).toBe(1000);
  });
});

describe("microToCredits (integer floor)", () => {
  it("converts exact multiples", () => {
    expect(microToCredits(0)).toBe(0);
    expect(microToCredits(1000)).toBe(1);
    expect(microToCredits(100_000)).toBe(100); // welcome bonus displays as 100 credits (F7/AC6)
    expect(microToCredits(10_000_000)).toBe(10_000); // a $10 pack
  });

  it("floors sub-credit amounts (never rounds up)", () => {
    // A typical chat turn costs ~395 µ$ → 0 whole credits.
    expect(microToCredits(395)).toBe(0);
    expect(microToCredits(999)).toBe(0);
    expect(microToCredits(1999)).toBe(1);
  });

  it("guards non-finite inputs to 0", () => {
    expect(microToCredits(NaN)).toBe(0);
    expect(microToCredits(Infinity)).toBe(0);
    expect(microToCredits(-Infinity)).toBe(0);
    expect(microToCredits(undefined)).toBe(0);
    expect(microToCredits(null)).toBe(0);
  });

  it("guards negative inputs to 0", () => {
    expect(microToCredits(-395)).toBe(0);
    expect(microToCredits(-1)).toBe(0);
  });
});

describe("microToCredits flooring invariant (AC9)", () => {
  it("holds microToCredits(m) * 1000 <= m for all m >= 0", () => {
    // Deterministic sweep across magnitudes, plus boundary values.
    const samples = [];
    for (let m = 0; m <= 2_000_000; m += 17) samples.push(m);
    for (let m = 0; m <= 1000; m++) samples.push(m);
    for (const m of [999, 1000, 1001, 1999, 2000, 100_000, 999_999, 10_000_000]) {
      samples.push(m);
    }
    for (const m of samples) {
      expect(microToCredits(m) * CREDITS_PER_DOLLAR).toBeLessThanOrEqual(m);
    }
  });
});

describe("formatLedgerCredits (µ$ → ≤2-decimal credit string)", () => {
  it("formats typical per-turn debits (AC4)", () => {
    expect(formatLedgerCredits(395)).toBe("0.39");
    expect(formatLedgerCredits(1500)).toBe("1.5");
    expect(formatLedgerCredits(1000)).toBe("1");
  });

  it("preserves sign for negative (debit) rows", () => {
    expect(formatLedgerCredits(-395)).toBe("-0.39");
    expect(formatLedgerCredits(-1500)).toBe("-1.5");
  });

  it("truncates (never rounds up) beyond 2 decimals", () => {
    // 1 µ$ = 0.001 credits — below display precision, truncates to 0.
    expect(formatLedgerCredits(1)).toBe("0");
    // 1 999 µ$ = 1.999 credits → truncates to 1.99, never 2.
    expect(formatLedgerCredits(1999)).toBe("1.99");
    // 1 999 999 µ$ = 1999.999 credits → 1999.99.
    expect(formatLedgerCredits(1_999_999)).toBe("1999.99");
  });

  it("trims trailing zeros", () => {
    expect(formatLedgerCredits(1100)).toBe("1.1"); // 1.10 → 1.1
    expect(formatLedgerCredits(1050)).toBe("1.05");
  });

  it("handles zero and guards", () => {
    expect(formatLedgerCredits(0)).toBe("0");
    expect(formatLedgerCredits(NaN)).toBe("0");
    expect(formatLedgerCredits(Infinity)).toBe("0");
    expect(formatLedgerCredits(undefined)).toBe("0");
    expect(formatLedgerCredits(null)).toBe("0");
  });
});
