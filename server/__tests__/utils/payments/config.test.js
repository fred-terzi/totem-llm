/* eslint-env jest */
const {
  DEFAULT_PAYMENTS_RPC_URL,
  DEFAULT_PAYMENTS_CHAIN_ID,
  DEFAULT_PAYMENTS_CONFIRMATIONS,
  TRANSFER_TOPIC,
  paymentsConfig,
  packAmounts,
  getPack,
  decodeUsdcTransfers,
  fetchReceipt,
  getBlockHeight,
} = require("../../../utils/payments/config");
const { CREDITS_PER_DOLLAR } = require("../../../utils/credits/units");

const TREASURY = "0x" + "1111111111111111111111111111111111111111";
const USDC = "0x" + "2222222222222222222222222222222222222222";
const PAYER = "0x" + "3333333333333333333333333333333333333333";

/** Builds a treasury-bound USDC Transfer log. */
function transferLog({ token = USDC, from = PAYER, to = TREASURY, value = 10_000_000n }) {
  return {
    address: token,
    topics: [
      TRANSFER_TOPIC,
      "0x" + from.slice(2).toLowerCase().padStart(64, "0"),
      "0x" + to.slice(2).toLowerCase().padStart(64, "0"),
    ],
    data: "0x" + value.toString(16).padStart(64, "0"),
  };
}

describe("paymentsConfig (F1 feature gate, mirrors totemConfig)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PAYMENTS_TREASURY_ADDRESS;
    delete process.env.PAYMENTS_USDC_ADDRESS;
    delete process.env.PAYMENTS_RPC_URL;
    delete process.env.PAYMENTS_CHAIN_ID;
    delete process.env.PAYMENTS_CONFIRMATIONS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("disabled when PAYMENTS_TREASURY_ADDRESS is missing (AC1 server side)", () => {
    const config = paymentsConfig();
    expect(config.enabled).toBe(false);
    expect(config.treasuryAddress).toBeNull();
    expect(config.usdcAddress).toBeNull();
    expect(config.chainId).toBe(DEFAULT_PAYMENTS_CHAIN_ID);
    expect(config.rpcUrl).toBe(DEFAULT_PAYMENTS_RPC_URL);
    expect(config.confirmations).toBe(DEFAULT_PAYMENTS_CONFIRMATIONS);
  });

  test("disabled when treasury address is invalid", () => {
    process.env.PAYMENTS_TREASURY_ADDRESS = "not-an-address";
    expect(paymentsConfig().enabled).toBe(false);
  });

  test("enabled when treasury is a valid hex address (case-insensitive)", () => {
    const upper = "0x" + TREASURY.slice(2).toUpperCase();
    process.env.PAYMENTS_TREASURY_ADDRESS = upper;
    const config = paymentsConfig();
    expect(config.enabled).toBe(true);
    expect(config.treasuryAddress).toBe(upper);
  });

  test("respects env overrides for usdc, chain, rpc, confirmations", () => {
    process.env.PAYMENTS_TREASURY_ADDRESS = TREASURY;
    process.env.PAYMENTS_USDC_ADDRESS = USDC;
    process.env.PAYMENTS_CHAIN_ID = "84532";
    process.env.PAYMENTS_RPC_URL = "https://sepolia.base.org";
    process.env.PAYMENTS_CONFIRMATIONS = "5";
    const config = paymentsConfig();
    expect(config.usdcAddress).toBe(USDC);
    expect(config.chainId).toBe(84532);
    expect(config.rpcUrl).toBe("https://sepolia.base.org");
    expect(config.confirmations).toBe(5);
  });

  test("falls back to defaults when confirmations env is not a positive number", () => {
    process.env.PAYMENTS_TREASURY_ADDRESS = TREASURY;
    process.env.PAYMENTS_CONFIRMATIONS = "abc";
    expect(paymentsConfig().confirmations).toBe(DEFAULT_PAYMENTS_CONFIRMATIONS);
    process.env.PAYMENTS_CONFIRMATIONS = "0";
    expect(paymentsConfig().confirmations).toBe(DEFAULT_PAYMENTS_CONFIRMATIONS);
  });
});

describe("packAmounts / getPack (F2 pack table, N1 integer math)", () => {
  test("exposes exactly the three packs", () => {
    expect(packAmounts().map((p) => p.id)).toEqual(["usd5", "usd10", "usd25"]);
    expect(packAmounts().map((p) => p.usd)).toEqual([5, 10, 25]);
  });

  test("AC2: credit amounts are integer-exact (usd × CREDITS_PER_DOLLAR)", () => {
    const byId = Object.fromEntries(packAmounts().map((p) => [p.id, p]));
    expect(byId.usd5.credits).toBe(5_000);
    expect(byId.usd10.credits).toBe(10_000);
    expect(byId.usd25.credits).toBe(25_000);
    for (const pack of packAmounts()) {
      expect(Number.isInteger(pack.credits)).toBe(true);
      expect(pack.credits).toBe(pack.usd * CREDITS_PER_DOLLAR);
    }
  });

  test("N1/N2: µ$ payable equals USDC base units 1:1 (usd × 1 000 000, BigInt)", () => {
    const byId = Object.fromEntries(packAmounts().map((p) => [p.id, p]));
    expect(byId.usd5.usdcBaseUnits).toBe(5_000_000n);
    expect(byId.usd10.usdcBaseUnits).toBe(10_000_000n);
    expect(byId.usd25.usdcBaseUnits).toBe(25_000_000n);
    for (const pack of packAmounts()) {
      expect(typeof pack.usdcBaseUnits).toBe("bigint");
      // Pure integer pass-through: base units == µ$.
      expect(Number(pack.usdcBaseUnits)).toBe(pack.usd * 1_000_000);
    }
  });

  test("getPack resolves known ids and returns null for unknown/invalid", () => {
    expect(getPack("usd10").usd).toBe(10);
    expect(getPack("nope")).toBeNull();
    expect(getPack("")).toBeNull();
    expect(getPack(null)).toBeNull();
    expect(getPack(123)).toBeNull();
  });
});

describe("decodeUsdcTransfers (F5 verification decoder, N3 ambiguity policy)", () => {
  test("decodes a single treasury-bound transfer (happy path)", () => {
    const value = 25_000_000n;
    const { match, ambiguous } = decodeUsdcTransfers(
      [transferLog({ value })],
      { tokenAddress: USDC, treasuryAddress: TREASURY }
    );
    expect(ambiguous).toBe(false);
    expect(match).toEqual({ from: PAYER.toLowerCase(), to: TREASURY.toLowerCase(), value });
    expect(typeof match.value).toBe("bigint");
  });

  test("is case-insensitive on address casing", () => {
    const { match } = decodeUsdcTransfers(
      [transferLog({ token: USDC.toUpperCase(), to: TREASURY.toUpperCase() })],
      { tokenAddress: USDC, treasuryAddress: TREASURY }
    );
    expect(match).not.toBeNull();
    expect(match.to).toBe(TREASURY.toLowerCase());
  });

  test("ignores transfers to other recipients", () => {
    const { match, ambiguous } = decodeUsdcTransfers(
      [transferLog({ to: "0x" + "eeee".repeat(10) })],
      { tokenAddress: USDC, treasuryAddress: TREASURY }
    );
    expect(match).toBeNull();
    expect(ambiguous).toBe(false);
  });

  test("ignores non-USDC token logs", () => {
    const { match, ambiguous } = decodeUsdcTransfers(
      [transferLog({ token: "0x" + "dddd".repeat(10) })],
      { tokenAddress: USDC, treasuryAddress: TREASURY }
    );
    expect(match).toBeNull();
    expect(ambiguous).toBe(false);
  });

  test("ignores non-Transfer topics", () => {
    const log = transferLog({});
    log.topics[0] = "0x" + "ab".repeat(32);
    const { match, ambiguous } = decodeUsdcTransfers([log], {
      tokenAddress: USDC,
      treasuryAddress: TREASURY,
    });
    expect(match).toBeNull();
    expect(ambiguous).toBe(false);
  });

  test("N3: multiple matching transfers → ambiguous (fail closed, never guess)", () => {
    const { match, ambiguous } = decodeUsdcTransfers(
      [transferLog({ value: 5_000_000n }), transferLog({ value: 5_000_000n })],
      { tokenAddress: USDC, treasuryAddress: TREASURY }
    );
    expect(match).toBeNull();
    expect(ambiguous).toBe(true);
  });

  test("zero matching logs → not ambiguous, no match (payment not found)", () => {
    const { match, ambiguous } = decodeUsdcTransfers([], {
      tokenAddress: USDC,
      treasuryAddress: TREASURY,
    });
    expect(match).toBeNull();
    expect(ambiguous).toBe(false);
  });

  test("non-array / malformed logs are handled without throwing", () => {
    expect(decodeUsdcTransfers(null, { tokenAddress: USDC, treasuryAddress: TREASURY })).toEqual({
      match: null,
      ambiguous: false,
    });
    expect(decodeUsdcTransfers(undefined, { tokenAddress: USDC, treasuryAddress: TREASURY })).toEqual({
      match: null,
      ambiguous: false,
    });
    expect(decodeUsdcTransfers([{}, null, { topics: ["x"] }], {
      tokenAddress: USDC,
      treasuryAddress: TREASURY,
    })).toEqual({ match: null, ambiguous: false });
  });

  test("malformed data word (not 32 bytes) is not treated as a match", () => {
    const log = transferLog({});
    log.data = "0x1234"; // too short
    const { match, ambiguous } = decodeUsdcTransfers([log], {
      tokenAddress: USDC,
      treasuryAddress: TREASURY,
    });
    expect(match).toBeNull();
    expect(ambiguous).toBe(false);
  });
});

describe("fetchReceipt (injectable transport, no network in tests)", () => {
  const TX_HASH = "0x" + "ab".repeat(32);

  function mockFetch(resultPayload) {
    return jest.fn().mockResolvedValue({
      ok: true,
      json: async () => resultPayload,
    });
  }

  test("returns the receipt object on success and sends the right RPC body", async () => {
    const receipt = { transactionHash: TX_HASH, blockNumber: "0x64", logs: [] };
    const fetchImpl = mockFetch({ id: 1, jsonrpc: "2.0", result: receipt });
    const out = await fetchReceipt("https://rpc.example.test", TX_HASH, { fetchImpl });
    expect(out).toEqual(receipt);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://rpc.example.test");
    const body = JSON.parse(init.body);
    expect(body.method).toBe("eth_getTransactionReceipt");
    expect(body.params).toEqual([TX_HASH]);
  });

  test("returns null when the tx is unmined/unknown (result: null)", async () => {
    const fetchImpl = mockFetch({ id: 1, jsonrpc: "2.0", result: null });
    const out = await fetchReceipt("https://rpc.example.test", TX_HASH, { fetchImpl });
    expect(out).toBeNull();
  });

  test("throws on invalid tx hash", async () => {
    await expect(
      fetchReceipt("https://rpc.example.test", "0xdeadbeef", { fetchImpl: mockFetch({}) })
    ).rejects.toThrow(/Invalid transaction hash/i);
    await expect(
      fetchReceipt("https://rpc.example.test", "", { fetchImpl: mockFetch({}) })
    ).rejects.toThrow(/Invalid transaction hash/i);
  });

  test("throws on missing RPC URL", async () => {
    await expect(
      fetchReceipt("", TX_HASH, { fetchImpl: mockFetch({}) })
    ).rejects.toThrow(/Missing RPC URL/i);
  });

  test("throws on non-OK HTTP response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 502 });
    await expect(
      fetchReceipt("https://rpc.example.test", TX_HASH, { fetchImpl })
    ).rejects.toThrow(/HTTP 502/i);
  });

  test("throws when RPC returns an error object", async () => {
    const fetchImpl = mockFetch({ id: 1, error: { code: -32000, message: "rate limited" } });
    await expect(
      fetchReceipt("https://rpc.example.test", TX_HASH, { fetchImpl })
    ).rejects.toThrow(/rate limited/i);
  });
});

describe("getBlockHeight (injectable transport, no network in tests)", () => {
  function mockFetch(resultPayload) {
    return jest.fn().mockResolvedValue({
      ok: true,
      json: async () => resultPayload,
    });
  }

  test("returns the block height as BigInt and sends the right RPC body", async () => {
    const fetchImpl = mockFetch({ id: 1, jsonrpc: "2.0", result: "0x1a137" });
    const height = await getBlockHeight("https://rpc.example.test", { fetchImpl });
    expect(height).toBe(106807n);
    expect(typeof height).toBe("bigint");

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.method).toBe("eth_blockNumber");
    expect(body.params).toEqual([]);
  });

  test("throws on missing RPC URL", async () => {
    await expect(getBlockHeight("", { fetchImpl: mockFetch({}) })).rejects.toThrow(
      /Missing RPC URL/i
    );
  });

  test("throws when result is not a string", async () => {
    const fetchImpl = mockFetch({ id: 1, result: 106807 });
    await expect(
      getBlockHeight("https://rpc.example.test", { fetchImpl })
    ).rejects.toThrow(/did not return a block number/i);
  });

  test("throws on RPC error object", async () => {
    const fetchImpl = mockFetch({ id: 1, error: { code: -32000, message: "boom" } });
    await expect(
      getBlockHeight("https://rpc.example.test", { fetchImpl })
    ).rejects.toThrow(/boom/i);
  });
});
