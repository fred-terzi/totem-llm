/**
 * $TOTEM token balance helpers (ERC-20 on Base).
 *
 * Pure config/format helpers live here (no server dependencies) so they can be
 * unit-tested without booting Prisma or the Express app. The endpoint
 * (`server/endpoints/wallet.js`) wires these into `GET /wallet/balance`.
 *
 * Reads only — never signs, sends, or mutates on-chain state.
 */

const DEFAULT_TOTEM_RPC_URL = "https://mainnet.base.org";
const DEFAULT_TOTEM_CHAIN_ID = 8453; // Base mainnet
const DEFAULT_TOTEM_DECIMALS = 18;
const BALANCE_OF_SELECTOR = "0x70a08231"; // ERC-20 balanceOf(address)

/**
 * Resolves the $TOTEM token configuration from env vars.
 * The feature is considered "enabled" only when TOTEM_ADDRESS is a valid
 * hex address — otherwise the endpoint reports `available: false` and the
 * UI hides the badge. This keeps the feature safely off by default.
 * @returns {{enabled: boolean, tokenAddress: string|null, chainId: number, rpcUrl: string, symbol: string, decimals: number}}
 */
function totemConfig() {
  const tokenAddress = (process.env.TOTEM_ADDRESS || "").trim();
  const decimals = Number(process.env.TOTEM_DECIMALS || DEFAULT_TOTEM_DECIMALS);
  return {
    enabled: /^0x[0-9a-fA-F]{40}$/.test(tokenAddress),
    tokenAddress: tokenAddress || null,
    chainId: Number(process.env.TOTEM_CHAIN_ID || DEFAULT_TOTEM_CHAIN_ID),
    rpcUrl: (process.env.TOTEM_RPC_URL || DEFAULT_TOTEM_RPC_URL).trim(),
    symbol: (process.env.TOTEM_SYMBOL || "TOTEM").trim(),
    decimals: Number.isFinite(decimals) && decimals >= 0 ? decimals : DEFAULT_TOTEM_DECIMALS,
  };
}

/**
 * Converts a raw wei/hex string (as returned by `eth_call`) into a decimal
 * string using the token's decimals. Returns null when the input is not
 * valid hex/numeric so the caller can report "unavailable" instead of "0".
 * @param {string|bigint} rawHex - e.g. "0xde0b6b3a7640000" or a bigint
 * @param {number} decimals - token decimals (default 18)
 * @returns {string|null} - e.g. "1" or "0.000000000000000001"
 */
function formatTotemAmount(rawHex = "0x0", decimals = DEFAULT_TOTEM_DECIMALS) {
  let value;
  try {
    // Accept hex with or without the 0x prefix, or a plain decimal string.
    // (BigInt rejects bare hex strings and needs the 0x prefix.)
    if (typeof rawHex === "string") {
      const trimmed = rawHex.trim();
      if (!/^0x/i.test(trimmed) && /^[0-9]+$/.test(trimmed)) return trimmed;
      if (!/^0x/i.test(trimmed)) rawHex = "0x" + trimmed;
    }
    value = BigInt(rawHex);
  } catch {
    return null;
  }

  if (decimals <= 0) return value.toString();

  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const remainder = value % base;
  if (remainder === 0n) return whole.toString();

  const fraction = remainder
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${whole}.${fraction}`;
}

/**
 * Encodes the `data` field for an ERC-20 `balanceOf(owner)` eth_call.
 * @param {string} ownerAddress - 0x-prefixed address (any casing)
 * @returns {string|null} 0x selector + 32-byte left-padded owner
 */
function encodeBalanceOfCall(ownerAddress = "") {
  const hex = String(ownerAddress).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  return BALANCE_OF_SELECTOR + hex.padStart(64, "0");
}

/**
 * Reads the token balance of `ownerAddress` via a JSON-RPC `eth_call`.
 * Uses the global fetch (Node >= 18) with a hard timeout so a dead RPC
 * endpoint can never hang the login-adjacent read.
 * @param {Object} opts
 * @param {string} opts.rpcUrl - JSON-RPC endpoint URL
 * @param {string} opts.tokenAddress - ERC-20 contract address
 * @param {string} opts.ownerAddress - wallet address to read balance for
 * @param {number} [opts.decimals=18] - token decimals
 * @param {number} [opts.timeoutMs=5000] - request timeout
 * @param {Function} [opts.fetchImpl] - injectable fetch (for tests)
 * @returns {Promise<string>} decimal balance string (may be "0")
 * @throws on network/HTTP/RPC errors — caller decides how to surface it
 */
async function fetchTotemBalance({
  rpcUrl,
  tokenAddress,
  ownerAddress,
  decimals = DEFAULT_TOTEM_DECIMALS,
  timeoutMs = 5000,
  fetchImpl = null,
}) {
  if (!rpcUrl || !tokenAddress) throw new Error("Missing RPC URL or token address.");
  const data = encodeBalanceOfCall(ownerAddress);
  if (!data) throw new Error("Invalid owner address for balanceOf call.");

  const _fetch = fetchImpl || globalThis.fetch;
  if (typeof _fetch !== "function")
    throw new Error("No fetch implementation available.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await _fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: tokenAddress, data }, "latest"],
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`RPC endpoint responded with HTTP ${res.status}.`);

    const json = await res.json();
    if (json.error)
      throw new Error(json.error.message || "RPC endpoint returned an error.");
    if (typeof json.result !== "string")
      throw new Error("RPC endpoint did not return a balance result.");

    return formatTotemAmount(json.result, decimals);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TOTEM_RPC_URL,
  DEFAULT_TOTEM_CHAIN_ID,
  DEFAULT_TOTEM_DECIMALS,
  totemConfig,
  formatTotemAmount,
  encodeBalanceOfCall,
  fetchTotemBalance,
};
