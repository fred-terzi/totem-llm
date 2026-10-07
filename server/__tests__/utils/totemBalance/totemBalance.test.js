/* eslint-env jest */
const {
  totemConfig,
  formatTotemAmount,
  encodeBalanceOfCall,
  fetchTotemBalance,
  DEFAULT_TOTEM_DECIMALS,
} = require("../../../utils/totemBalance");

const VALID_ADDRESS = "0x" + "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

describe("totemConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TOTEM_ADDRESS;
    delete process.env.TOTEM_DECIMALS;
    delete process.env.TOTEM_CHAIN_ID;
    delete process.env.TOTEM_RPC_URL;
    delete process.env.TOTEM_SYMBOL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("disabled when TOTEM_ADDRESS is missing", () => {
    const config = totemConfig();
    expect(config.enabled).toBe(false);
    expect(config.tokenAddress).toBeNull();
    expect(config.decimals).toBe(18);
    expect(config.chainId).toBe(8453);
    expect(config.symbol).toBe("TOTEM");
  });

  test("enabled when TOTEM_ADDRESS is a valid hex address (case-insensitive)", () => {
    const upperAddress = "0x" + VALID_ADDRESS.slice(2).toUpperCase();
    process.env.TOTEM_ADDRESS = upperAddress;
    const config = totemConfig();
    expect(config.enabled).toBe(true);
    expect(config.tokenAddress).toBe(upperAddress);
  });

  test("disabled when TOTEM_ADDRESS is invalid", () => {
    process.env.TOTEM_ADDRESS = "not-an-address";
    expect(totemConfig().enabled).toBe(false);
  });

  test("respects env overrides for decimals, chain, rpc, symbol", () => {
    process.env.TOTEM_ADDRESS = VALID_ADDRESS;
    process.env.TOTEM_DECIMALS = "6";
    process.env.TOTEM_CHAIN_ID = "42";
    process.env.TOTEM_RPC_URL = "https://example.test/rpc";
    process.env.TOTEM_SYMBOL = "TOM";
    const config = totemConfig();
    expect(config.decimals).toBe(6);
    expect(config.chainId).toBe(42);
    expect(config.rpcUrl).toBe("https://example.test/rpc");
    expect(config.symbol).toBe("TOM");
  });

  test("falls back to defaults when decimals env is not a number", () => {
    process.env.TOTEM_ADDRESS = VALID_ADDRESS;
    process.env.TOTEM_DECIMALS = "abc";
    expect(totemConfig().decimals).toBe(DEFAULT_TOTEM_DECIMALS);
  });
});

describe("formatTotemAmount", () => {
  test("whole amount with 18 decimals", () => {
    expect(formatTotemAmount("0xde0b6b3a7640000", 18)).toBe("1");
  });

  test("fractional amount with 18 decimals", () => {
    // 1.5 tokens = 1.5 * 10^18 wei
    expect(formatTotemAmount((15n * 10n ** 17n).toString(16), 18)).toBe("1.5");
    // 0.25 tokens
    expect(formatTotemAmount((25n * 10n ** 16n).toString(16), 18)).toBe("0.25");
  });

  test("one wei with 18 decimals", () => {
    expect(formatTotemAmount("0x1", 18)).toBe("0.000000000000000001");
  });

  test("zero", () => {
    expect(formatTotemAmount("0x0", 18)).toBe("0");
  });

  test("decimals <= 0 returns raw integer string", () => {
    expect(formatTotemAmount("123", 0)).toBe("123");
    expect(formatTotemAmount("123", -1)).toBe("123");
  });

  test("accepts bigint input", () => {
    expect(formatTotemAmount(10n ** 18n * 2n, 18)).toBe("2");
  });

  test("returns null for invalid input", () => {
    expect(formatTotemAmount("not-hex", 18)).toBeNull();
    expect(formatTotemAmount(null, 18)).toBeNull();
  });
});

describe("encodeBalanceOfCall", () => {
  test("encodes a valid owner address", () => {
    const data = encodeBalanceOfCall(VALID_ADDRESS);
    // selector (8 hex) + 32-byte left-padded owner (64 hex)
    expect(data).toBe(
      "0x70a08231" + "000000000000000000000000a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    );
    expect(data).toHaveLength(2 + 8 + 64);
  });

  test("lowercases and strips 0x prefix before padding", () => {
    const data = encodeBalanceOfCall(VALID_ADDRESS.toUpperCase());
    expect(data.toLowerCase()).toContain("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
  });

  test("returns null for invalid owner address", () => {
    expect(encodeBalanceOfCall("nope")).toBeNull();
    expect(encodeBalanceOfCall("")).toBeNull();
  });
});

describe("fetchTotemBalance", () => {
  const rpcUrl = "https://rpc.example.test";
  const tokenAddress = VALID_ADDRESS;

  function mockFetch(resultPayload) {
    return jest.fn().mockResolvedValue({
      ok: true,
      json: async () => resultPayload,
    });
  }

  test("returns formatted decimal balance on success", async () => {
    const fetchImpl = mockFetch({ id: 1, jsonrpc: "2.0", result: "0xde0b6b3a7640000" });
    const amount = await fetchTotemBalance({
      rpcUrl,
      tokenAddress,
      ownerAddress: VALID_ADDRESS,
      decimals: 18,
      fetchImpl,
    });
    expect(amount).toBe("1");

    // Verify the JSON-RPC body we sent
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(rpcUrl);
    const body = JSON.parse(init.body);
    expect(body.method).toBe("eth_call");
    expect(body.params[0].to).toBe(tokenAddress);
    expect(body.params[0].data).toBe(
      "0x70a08231" + "000000000000000000000000a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    );
    expect(body.params[1]).toBe("latest");
  });

  test("throws when RPC URL or token address missing", async () => {
    await expect(
      fetchTotemBalance({ rpcUrl: "", tokenAddress, ownerAddress: VALID_ADDRESS })
    ).rejects.toThrow(/Missing RPC URL or token address/i);
    await expect(
      fetchTotemBalance({ rpcUrl, tokenAddress: "", ownerAddress: VALID_ADDRESS })
    ).rejects.toThrow(/Missing RPC URL or token address/i);
  });

  test("throws on invalid owner address", async () => {
    await expect(
      fetchTotemBalance({
        rpcUrl,
        tokenAddress,
        ownerAddress: "bad",
        fetchImpl: mockFetch({}),
      })
    ).rejects.toThrow(/Invalid owner address/i);
  });

  test("throws when no fetch implementation is available", async () => {
    const originalFetch = globalThis.fetch;
    delete globalThis.fetch;
    try {
      await expect(
        fetchTotemBalance({ rpcUrl, tokenAddress, ownerAddress: VALID_ADDRESS })
      ).rejects.toThrow(/No fetch implementation/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws on non-OK HTTP response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(
      fetchTotemBalance({
        rpcUrl,
        tokenAddress,
        ownerAddress: VALID_ADDRESS,
        fetchImpl,
      })
    ).rejects.toThrow(/HTTP 500/i);
  });

  test("throws when RPC returns an error object", async () => {
    const fetchImpl = mockFetch({
      id: 1,
      error: { code: -32000, message: "invalid params" },
    });
    await expect(
      fetchTotemBalance({
        rpcUrl,
        tokenAddress,
        ownerAddress: VALID_ADDRESS,
        fetchImpl,
      })
    ).rejects.toThrow(/invalid params/i);
  });

  test("throws when result is not a string", async () => {
    const fetchImpl = mockFetch({ id: 1, result: 12345 });
    await expect(
      fetchTotemBalance({
        rpcUrl,
        tokenAddress,
        ownerAddress: VALID_ADDRESS,
        fetchImpl,
      })
    ).rejects.toThrow(/did not return a balance result/i);
  });

  test("respects custom decimals", async () => {
    const fetchImpl = mockFetch({ id: 1, result: "0x186a0" }); // 100000
    const amount = await fetchTotemBalance({
      rpcUrl,
      tokenAddress,
      ownerAddress: VALID_ADDRESS,
      decimals: 6,
      fetchImpl,
    });
    expect(amount).toBe("0.1");
  });
});
