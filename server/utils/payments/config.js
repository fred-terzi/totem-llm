/**
 * Wallet payments — pure config/pack/decoding/RPC helpers (USDC on Base).
 *
 * Companion to `server/utils/totemBalance.js` (same patterns: pure, no server
 * dependencies, unit-testable without booting Prisma or Express). The endpoint
 * (`server/endpoints/payments.js`) wires these into the purchase-session flow.
 *
 * Feature gate: payments are enabled only when `PAYMENTS_TREASURY_ADDRESS`
 * is a valid hex address. Unset/invalid = every payments endpoint reports
 * "off" and the UI hides the buy affordance — safely off by default.
 *
 * Money invariants (credit-units workstream, N1/N2):
 *   - 1 µ$ = 1 USDC base unit exactly (USDC has 6 decimals), so an on-chain
 *     base-unit amount converts to µ$ as a pure integer pass-through.
 *   - All amount math uses BigInt. No floats anywhere in this module.
 *   - Ambiguous on-chain data (zero or multiple matching Transfer logs) is
 *     surfaced as a distinct `ambiguous` result — callers must fail closed,
 *     never guess.
 *
 * Reads only — this module never signs, sends, or mutates on-chain state.
 */

const { CREDITS_PER_DOLLAR, MICRO_PER_DOLLAR } = require("../credits/units");

const DEFAULT_PAYMENTS_RPC_URL = "https://mainnet.base.org";
const DEFAULT_PAYMENTS_CHAIN_ID = 8453; // Base mainnet
const DEFAULT_PAYMENTS_CONFIRMATIONS = 2;

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ERC-20 Transfer event log layout: data = value; topics[1..2] = from, to.
const TRANSFER_DATA_BYTES = 32;
const TRANSFER_TOPIC_BYTES = 32;

/** Pack table — the only place pack prices are defined (F2). */
const PACKS = [
  { id: "usd5", usd: 5 },
  { id: "usd10", usd: 10 },
  { id: "usd25", usd: 25 },
];

/**
 * Resolves the payments configuration from env vars, mirroring
 * `totemConfig()` in `server/utils/totemBalance.js`. The feature is enabled
 * only when the treasury address is a valid `0x…40` hex address.
 * @returns {{enabled: boolean, treasuryAddress: string|null, usdcAddress: string|null, chainId: number, rpcUrl: string, confirmations: number}}
 */
function paymentsConfig() {
  const treasury = (process.env.PAYMENTS_TREASURY_ADDRESS || "").trim();
  const usdc = (process.env.PAYMENTS_USDC_ADDRESS || "").trim();
  const confirmations = Number(
    process.env.PAYMENTS_CONFIRMATIONS || DEFAULT_PAYMENTS_CONFIRMATIONS
  );
  return {
    enabled: /^0x[0-9a-fA-F]{40}$/.test(treasury),
    treasuryAddress: treasury || null,
    usdcAddress: /^0x[0-9a-fA-F]{40}$/.test(usdc) ? usdc : null,
    chainId: Number(process.env.PAYMENTS_CHAIN_ID || DEFAULT_PAYMENTS_CHAIN_ID),
    rpcUrl: (process.env.PAYMENTS_RPC_URL || DEFAULT_PAYMENTS_RPC_URL).trim(),
    confirmations:
      Number.isFinite(confirmations) && confirmations >= 1
        ? confirmations
        : DEFAULT_PAYMENTS_CONFIRMATIONS,
  };
}

/**
 * The purchase pack table, enriched with the payable amounts (F2):
 *   - `usd` — display price
 *   - `usdcBaseUnits` — BigInt, what the user must send (1 µ$ = 1 base unit)
 *   - `credits` — what the ledger credits (integer-exact: usd × CREDITS_PER_DOLLAR)
 * Derived entirely from the `PACKS` table + the units constants — no
 * independent magic numbers at call sites.
 * @returns {Array<{id: string, usd: number, usdcBaseUnits: bigint, credits: number}>}
 */
function packAmounts() {
  return PACKS.map((pack) => ({
    id: pack.id,
    usd: pack.usd,
    // µ$ = USDC base units 1:1 (USDC has 6 decimals) — integer pass-through.
    usdcBaseUnits: BigInt(pack.usd) * BigInt(MICRO_PER_DOLLAR),
    credits: pack.usd * CREDITS_PER_DOLLAR,
  }));
}

/**
 * Looks up a pack by id (from the `PACKS` table — unknown ids are invalid).
 * @param {string} packId
 * @returns {object|null} same shape as `packAmounts()` entries, or null
 */
function getPack(packId) {
  if (typeof packId !== "string") return null;
  return packAmounts().find((p) => p.id === packId) || null;
}

/**
 * Left-pads a hex string (without 0x) to 32 bytes — addresses and uint256
 * values are both 32-byte words in the log topics/data.
 */
function padWord(hex40orValue) {
  return hex40orValue.padStart(TRANSFER_TOPIC_BYTES * 2, "0");
}

/**
 * Decodes ERC-20 `Transfer(address,address,uint256)` logs from a transaction
 * receipt and returns the ones that are treasury-bound USDC transfers
 * (recipient === treasuryAddress, case-insensitive).
 *
 * Ambiguity policy (N3): zero or multiple matching logs is returned as a
 * distinct shape — the caller must fail the session, never guess which log
 * is "the payment". A single matching log yields `from` and `value` where
 * `value` is a BigInt of USDC base units (== µ$).
 *
 * @param {Array<{topics?: string[], data?: string}>|null|undefined} receiptLogs - `receipt.logs` from eth_getTransactionReceipt
 * @param {{tokenAddress: string, treasuryAddress: string}} opts
 * @returns {{match: {from: string, to: string, value: bigint}|null, ambiguous: boolean}}
 *   - `match` set + `ambiguous: false` → exactly one treasury-bound transfer
 *   - `match: null` + `ambiguous: false` → no matching transfer (payment not found)
 *   - `match: null` + `ambiguous: true`  → multiple matching transfers — fail closed
 */
function decodeUsdcTransfers(receiptLogs, { tokenAddress, treasuryAddress }) {
  if (!Array.isArray(receiptLogs)) return { match: null, ambiguous: false };
  const token = String(tokenAddress || "").toLowerCase();
  const treasury = String(treasuryAddress || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token) || !/^0x[0-9a-f]{40}$/.test(treasury)) {
    return { match: null, ambiguous: false };
  }

  const matches = [];
  for (const log of receiptLogs) {
    if (!log || !Array.isArray(log.topics) || log.topics.length < 3) continue;
    if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (String(log.address || "").toLowerCase() !== token) continue;

    // topics[1] = from (padded), topics[2] = to (padded); data = value word.
    // Addresses live in the low 20 bytes of the 32-byte word → last 40 hex chars.
    const to =
      "0x" + padWord(String(log.topics[2]).slice(2).toLowerCase()).slice(-40);
    if (to !== treasury) continue;

    const dataHex = String(log.data || "").replace(/^0x/, "");
    if (dataHex.length !== TRANSFER_DATA_BYTES * 2) continue; // malformed — not a match
    const from =
      "0x" + padWord(String(log.topics[1]).slice(2).toLowerCase()).slice(-40);
    const value = BigInt("0x" + dataHex);

    matches.push({ from, to, value });
  }

  if (matches.length === 1) return { match: matches[0], ambiguous: false };
  if (matches.length === 0) return { match: null, ambiguous: false };
  return { match: null, ambiguous: true };
}

/**
 * JSON-RPC POST helper with a hard timeout (mirrors `fetchTotemBalance`).
 * Transport is injectable for tests — no network in Jest.
 * @private
 */
async function rpcCall(
  rpcUrl,
  method,
  params,
  { timeoutMs = 5000, fetchImpl = null } = {}
) {
  const _fetch = fetchImpl || globalThis.fetch;
  if (typeof _fetch !== "function")
    throw new Error("No fetch implementation available.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await _fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok)
      throw new Error(`RPC endpoint responded with HTTP ${res.status}.`);
    const json = await res.json();
    if (json.error)
      throw new Error(json.error.message || "RPC endpoint returned an error.");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches a transaction receipt by hash via `eth_getTransactionReceipt`.
 * @param {string} rpcUrl - JSON-RPC endpoint URL
 * @param {string} txHash - 0x-prefixed transaction hash
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {Function} [opts.fetchImpl] - injectable fetch (for tests)
 * @returns {Promise<object|null>} the receipt object, or null when unmined/unknown
 * @throws on network/HTTP/RPC errors — caller decides how to surface it
 */
async function fetchReceipt(rpcUrl, txHash, opts = {}) {
  if (!rpcUrl) throw new Error("Missing RPC URL.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || "")))
    throw new Error("Invalid transaction hash.");
  return rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash], opts);
}

/**
 * Reads the current chain height via `eth_blockNumber`.
 * @param {string} rpcUrl - JSON-RPC endpoint URL
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {Function} [opts.fetchImpl] - injectable fetch (for tests)
 * @returns {Promise<bigint>} current block number
 * @throws on network/HTTP/RPC errors — caller decides how to surface it
 */
async function getBlockHeight(rpcUrl, opts = {}) {
  if (!rpcUrl) throw new Error("Missing RPC URL.");
  const result = await rpcCall(rpcUrl, "eth_blockNumber", [], opts);
  if (typeof result !== "string")
    throw new Error("RPC endpoint did not return a block number.");
  return BigInt(result);
}

module.exports = {
  DEFAULT_PAYMENTS_RPC_URL,
  DEFAULT_PAYMENTS_CHAIN_ID,
  DEFAULT_PAYMENTS_CONFIRMATIONS,
  TRANSFER_TOPIC,
  PACKS,
  paymentsConfig,
  packAmounts,
  getPack,
  decodeUsdcTransfers,
  fetchReceipt,
  getBlockHeight,
};
