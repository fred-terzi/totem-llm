/**
 * Unit tests for the frontend payments helpers (frontend/src/utils/payments.js)
 * — wallet-payments Step 6 / Step 7 AC map:
 *
 *   AC2 — pack table integer-exactness (credits + USDC base units, no floats)
 *   N1  — calldata building + USDC formatting use string/BigInt math only
 *   AC9 — every F5 failure reason maps to human-readable copy (no bare codes)
 *
 * Pure Node — no network, no wallet, no DOM (the module has zero side
 * effects by design). The `@/utils/constants` + `@/utils/request` imports
 * are mocked: `constants.js` reads `import.meta.env` (Vite-only, unsupported
 * under the CJS babel transform — same workaround as contextUsage.test.js)
 * and this module's pure helpers never touch them at runtime.
 *
 * NOTE: the `resolvePurchaseSession` loop tests live in
 * `payments.resolve.test.js` — keeping the two files separate (the
 * jest-haste-map module graph for a single combined suite balloons memory
 * under this repo's config; two small suites are stable).
 */

jest.mock("@/utils/constants", () => ({
  API_BASE: "/api",
  AUTH_TIMESTAMP: "auth_timestamp",
  fullApiUrl: () => "/api",
}));
jest.mock("@/utils/request", () => ({
  baseHeaders: () => ({}),
  userFromStorage: () => null,
  safeJsonParse: (s, f) => f,
}));

const {
  PURCHASE_PACKS,
  buildUsdcTransferCalldata,
  formatUsdcBaseUnits,
  failureReasonCopy,
  FAILURE_REASON_COPY,
  TERMINAL_SESSION_STATUSES,
} = require("@/utils/payments");

describe("PURCHASE_PACKS (AC2 — integer-exact pack math)", () => {
  it("offers exactly the four spec packs", () => {
    expect(PURCHASE_PACKS.map((p) => p.id)).toEqual([
      "usd1",
      "usd5",
      "usd10",
      "usd25",
    ]);
  });

  it("displays exactly 1 000 / 5 000 / 10 000 / 25 000 credits", () => {
    expect(PURCHASE_PACKS.map((p) => p.credits)).toEqual([
      1_000, 5_000, 10_000, 25_000,
    ]);
  });

  it("carries the exact USDC base-unit amounts as decimal strings (no floats)", () => {
    // 1/5/10/25 USDC × 1e6 base units — integer-exact, string-typed so no
    // float can ever sneak into the value sent on-chain.
    expect(PURCHASE_PACKS.map((p) => p.usdc)).toEqual([
      "1000000",
      "5000000",
      "10000000",
      "25000000",
    ]);
    for (const pack of PURCHASE_PACKS) {
      expect(typeof pack.usdc).toBe("string");
      expect(Number.isInteger(pack.credits)).toBe(true);
    }
  });
});

describe("buildUsdcTransferCalldata (N1 — string/BigInt only)", () => {
  const RECIPIENT = "0xABcdEF0123456789012345678901234567890123";

  it("builds selector + padded recipient + padded value", () => {
    const data = buildUsdcTransferCalldata({
      recipient: RECIPIENT,
      amountBaseUnits: "5000000",
    });
    // 0x + 4-byte selector + two 32-byte words = 138 chars total.
    expect(data).toHaveLength(138);
    expect(data.startsWith("0xa9059cbb")).toBe(true);
    // Recipient word: address, lowercase, left-padded to 32 bytes.
    expect(data.slice(10, 74)).toBe(
      "000000000000000000000000abcdef0123456789012345678901234567890123"
    );
    // Value word: 5 000 000 = 0x4C4B40, left-padded.
    expect(data.slice(74)).toBe(
      "00000000000000000000000000000000000000000000000000000000004c4b40"
    );
  });

  it("is byte-exact for the largest pack (25 000 000 base units)", () => {
    const data = buildUsdcTransferCalldata({
      recipient: RECIPIENT,
      amountBaseUnits: "25000000",
    });
    // 25 000 000 = 0x17D7840.
    expect(data.slice(74)).toBe(
      "00000000000000000000000000000000000000000000000000000000017d7840"
    );
  });

  it("accepts a checksummed recipient (case-insensitive encoding)", () => {
    const lower = buildUsdcTransferCalldata({
      recipient: RECIPIENT.toLowerCase(),
      amountBaseUnits: "1",
    });
    const checksummed = buildUsdcTransferCalldata({
      recipient: RECIPIENT,
      amountBaseUnits: "1",
    });
    expect(lower).toBe(checksummed);
  });

  it("throws on a non-address recipient (fail-closed, never send malformed)", () => {
    expect(() =>
      buildUsdcTransferCalldata({ recipient: "0x1234", amountBaseUnits: "5" })
    ).toThrow();
    expect(() =>
      buildUsdcTransferCalldata({ recipient: "", amountBaseUnits: "5" })
    ).toThrow();
    expect(() =>
      buildUsdcTransferCalldata({ recipient: null, amountBaseUnits: "5" })
    ).toThrow();
  });

  it("throws on a non-integer or non-positive amount", () => {
    expect(() =>
      buildUsdcTransferCalldata({
        recipient: RECIPIENT,
        amountBaseUnits: "5.5",
      })
    ).toThrow();
    expect(() =>
      buildUsdcTransferCalldata({
        recipient: RECIPIENT,
        amountBaseUnits: "1e6",
      })
    ).toThrow();
    expect(() =>
      buildUsdcTransferCalldata({ recipient: RECIPIENT, amountBaseUnits: "0" })
    ).toThrow();
    expect(() =>
      buildUsdcTransferCalldata({ recipient: RECIPIENT, amountBaseUnits: "" })
    ).toThrow();
    expect(() =>
      buildUsdcTransferCalldata({
        recipient: RECIPIENT,
        amountBaseUnits: null,
      })
    ).toThrow();
  });
});

describe("formatUsdcBaseUnits (N1 — string math, no floats)", () => {
  it("formats whole and fractional USDC amounts", () => {
    expect(formatUsdcBaseUnits("5000000")).toBe("5");
    expect(formatUsdcBaseUnits("10000000")).toBe("10");
    expect(formatUsdcBaseUnits("25000000")).toBe("25");
    expect(formatUsdcBaseUnits("10500000")).toBe("10.5");
    expect(formatUsdcBaseUnits("123456789")).toBe("123.456789");
    expect(formatUsdcBaseUnits("999")).toBe("0.000999");
    expect(formatUsdcBaseUnits("0")).toBe("0");
  });

  it("trims trailing zeros in the fractional part", () => {
    expect(formatUsdcBaseUnits("5000001")).toBe("5.000001");
    expect(formatUsdcBaseUnits("1500000")).toBe("1.5");
    expect(formatUsdcBaseUnits("1000100")).toBe("1.0001");
  });

  it("returns null for invalid input (caller renders nothing, never a wrong number)", () => {
    expect(formatUsdcBaseUnits("abc")).toBe(null);
    expect(formatUsdcBaseUnits("1.5")).toBe(null);
    expect(formatUsdcBaseUnits("")).toBe(null);
    expect(formatUsdcBaseUnits(null)).toBe(null);
    expect(formatUsdcBaseUnits(undefined)).toBe(null);
  });

  it("round-trips against BigInt exactly", () => {
    for (const base of ["1", "999", "5000000", "25000000", "123456789"]) {
      const formatted = formatUsdcBaseUnits(base);
      // Reconstruct the integer from the string without floats.
      const [whole, frac = ""] = formatted.split(".");
      const rebuilt = BigInt(whole + frac.padEnd(6, "0"));
      expect(rebuilt.toString()).toBe(BigInt(base).toString());
    }
  });
});

describe("failureReasonCopy (AC9 — human-readable reasons)", () => {
  it("maps every F5 machine-readable reason to copy", () => {
    const serverReasons = [
      "tx_not_found",
      "tx_reverted",
      "tx_too_old",
      "not_confirmed",
      "wrong_recipient",
      "wrong_token",
      "amount_mismatch",
      "payer_mismatch",
      "ambiguous_transfer",
      "rpc_unavailable",
      "ledger_write_failed",
    ];
    for (const reason of serverReasons) {
      const copy = failureReasonCopy(reason);
      expect(copy).toBeTruthy();
      expect(FAILURE_REASON_COPY[reason]).toBe(copy);
    }
  });

  it("gives a safe generic message for unknown/empty reasons (never a bare code)", () => {
    expect(failureReasonCopy("something_new")).toContain(
      "could not be verified"
    );
    expect(failureReasonCopy(null)).toContain("could not be verified");
    expect(failureReasonCopy(undefined)).toContain("could not be verified");
    expect(failureReasonCopy("")).toContain("could not be verified");
  });

  it("never leaks a raw machine code into the user-facing copy", () => {
    for (const reason of Object.keys(FAILURE_REASON_COPY)) {
      expect(failureReasonCopy(reason)).not.toBe(reason);
    }
  });
});

describe("TERMINAL_SESSION_STATUSES", () => {
  it("covers every terminal status the server can report", () => {
    expect(TERMINAL_SESSION_STATUSES).toEqual([
      "credited",
      "failed",
      "expired",
      "already-redeemed",
    ]);
  });
});
