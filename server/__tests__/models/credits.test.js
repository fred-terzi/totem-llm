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
