const { Credits } = require("../../models/credits");

// Unit tests for the pure pricing helpers — no DB required.
// These pin the customer billing math so pricing regressions are caught.

describe("Credits.calculateCost (microdollars, rounds up, never undercharges)", () => {
  it("computes input + output at their respective rates", () => {
    // 150 in * 0.5 = 75; 320 out * 1.0 = 320  ->  395
    expect(Credits.calculateCost(150, 320)).toBe(395);
  });

  it("is 0 for zero usage", () => {
    expect(Credits.calculateCost(0, 0)).toBe(0);
  });

  it("charges for input only", () => {
    // 1000 in * 0.5 = 500
    expect(Credits.calculateCost(1000, 0)).toBe(500);
  });

  it("charges for output only", () => {
    // 1000 out * 1.0 = 1000
    expect(Credits.calculateCost(0, 1000)).toBe(1000);
  });

  it("rounds up (ceil) so we never undercharge", () => {
    // 1 in * 0.5 = 0.5 -> ceil 1
    expect(Credits.calculateCost(1, 0)).toBe(1);
  });

  it("clamps negative token counts to 0", () => {
    expect(Credits.calculateCost(-100, -100)).toBe(0);
  });

  it("returns an integer (whole microdollars)", () => {
    for (const [i, o] of [[1, 1], [3, 7], [999, 12345]]) {
      expect(Number.isInteger(Credits.calculateCost(i, o))).toBe(true);
    }
  });
});

describe("Credits.dollarsToMicro", () => {
  it("converts whole dollars to microdollars", () => {
    expect(Credits.dollarsToMicro(10)).toBe(10_000_000);
  });

  it("converts fractional dollars", () => {
    expect(Credits.dollarsToMicro(0.000395)).toBe(395);
  });

  it("rounds to an integer", () => {
    expect(Credits.dollarsToMicro(0.1)).toBe(100_000);
  });
});

describe("Credits.microToDisplay (internal only — never render to end users)", () => {
  it("formats microdollars as a dollar string", () => {
    expect(Credits.microToDisplay(395)).toBe("$0.000395");
  });

  it("handles zero", () => {
    expect(Credits.microToDisplay(0)).toBe("$0.000000");
  });
});

describe("Credits.ratesForModel (per-model rate table, fail-closed)", () => {
  it("returns the exact rate pair for a known model slug", () => {
    expect(Credits.ratesForModel("e2ee-glm-5-3-flash")).toEqual({
      input: 0.5,
      output: 1.0,
    });
    expect(Credits.ratesForModel("z-ai-glm-5-3-flash")).toEqual({
      input: 0.5,
      output: 1.0,
    });
  });

  it("returns the zero-rate pair for the configured free slug", () => {
    expect(Credits.ratesForModel("nvidia/nemotron-3.5-lightning:free")).toEqual({
      input: 0,
      output: 0,
    });
  });

  it("falls back to DEFAULT_MODEL rates for unknown slugs (N7 — fail-closed, never 0)", () => {
    const fallback = Credits.ratesForModel("totally-unknown-model");
    expect(fallback).toEqual(Credits.ratesForModel(Credits.DEFAULT_MODEL));
    // The fallback must cost something — an unknown slug can never bill at 0.
    expect(fallback.input > 0 || fallback.output > 0).toBe(true);
  });

  it("falls back for undefined/null slugs too", () => {
    expect(Credits.ratesForModel(undefined)).toEqual(
      Credits.ratesForModel(Credits.DEFAULT_MODEL)
    );
    expect(Credits.ratesForModel(null)).toEqual(
      Credits.ratesForModel(Credits.DEFAULT_MODEL)
    );
  });

  it("rates the free slug at exactly 0 so debitUsage early-returns (no ledger row)", () => {
    // AC 14: zero-amount debits never reach `debit()`, so no
    // credit_transactions row is created for free-option chats.
    expect(Credits.calculateCost(100_000, 100_000, "nvidia/nemotron-3.5-lightning:free")).toBe(0);
  });
});

describe("Credits.calculateCost (per-model lookups)", () => {
  it("bills the e2ee slug at 0.5/1.0 µ$", () => {
    // 150 in * 0.5 = 75; 320 out * 1.0 = 320  ->  395
    expect(Credits.calculateCost(150, 320, "e2ee-glm-5-3-flash")).toBe(395);
  });

  it("bills the anon slug at the same rate initially (OQ-11)", () => {
    expect(Credits.calculateCost(150, 320, "z-ai-glm-5-3-flash")).toBe(395);
  });

  it("bills an unknown slug at the DEFAULT_MODEL rate (N7 fail-closed)", () => {
    expect(Credits.calculateCost(150, 320, "mystery-model")).toBe(
      Credits.calculateCost(150, 320, Credits.DEFAULT_MODEL)
    );
    expect(Credits.calculateCost(150, 320, "mystery-model")).toBe(395);
  });

  it("charges nothing for the free slug regardless of token counts", () => {
    expect(Credits.calculateCost(1, 1, "nvidia/nemotron-3.5-lightning:free")).toBe(0);
    expect(Credits.calculateCost(999_999, 999_999, "nvidia/nemotron-3.5-lightning:free")).toBe(0);
  });

  it("defaults to the DEFAULT_MODEL rate when no model is passed (backwards compat)", () => {
    expect(Credits.calculateCost(150, 320)).toBe(395);
  });

  it("still rounds up (ceil) per token type under per-model rates", () => {
    // 1 in * 0.5 = 0.5 -> ceil 1; 0 out -> 0
    expect(Credits.calculateCost(1, 0, "e2ee-glm-5-3-flash")).toBe(1);
    // 0 in -> 0; 1 out * 1.0 = 1
    expect(Credits.calculateCost(0, 1, "e2ee-glm-5-3-flash")).toBe(1);
  });
});

describe("Credits.WELCOME_BONUS (credit-units F7/AC8)", () => {
  it("stays 100 000 µ$ internally (= 100 displayed credits)", () => {
    expect(Credits.WELCOME_BONUS).toBe(100_000);
    expect(Math.floor(Credits.WELCOME_BONUS / 1000)).toBe(100);
  });
});
