const prisma = require("../utils/prisma");

// ─────────────────────────────────────────────────────────────────────────────
// Pricing — e2ee-glm-5-3-flash
//
//   input:   $0.50 / 1M tokens  →  0.5 microdollars per token
//   output:  $1.00 / 1M tokens  →  1.0 microdollar  per token
//
// All balances and amounts are stored as integers in **microdollars**
// (1 microdollar = $0.000001).
//
//   $10 top-up              = 10_000_000
//   150 in + 320 out tokens =    75 + 320 = 395  (= $0.000395)
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = "e2ee-glm-5-3-flash";
const INPUT_RATE = 0.5; // microdollars per input  token
const OUTPUT_RATE = 1.0; // microdollars per output token
// TODO: per-model rates keyed on model (currently single-model pricing).

/**
 * Calculate the cost in microdollars for a given token usage.
 * Rounds up so we never undercharge.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} cost in microdollars (integer ≥ 0)
 */
function calculateCost(inputTokens, outputTokens) {
  const i = Math.max(0, inputTokens);
  const o = Math.max(0, outputTokens);
  return Math.ceil(i * INPUT_RATE) + Math.ceil(o * OUTPUT_RATE);
}

/**
 * Convert a dollar amount to microdollars (integer).
 * @param {number} dollars
 * @returns {number}
 */
function dollarsToMicro(dollars) {
  return Math.round(dollars * 1_000_000);
}

/**
 * Convert microdollars to a display string (e.g. "$0.000395").
 * @internal
 * ⚠️  INTERNAL-ONLY. NEVER expose the returned value to end users. "Credits" is
 *     the customer-facing unit; the microdollar→dollar value is an internal
 *     pricing detail that must not leak into API responses, UI, or logs visible
 *     to customers. Use only for server-side admin/debug tooling and tests.
 * @param {number} micro
 * @returns {string}
 */
function microToDisplay(micro) {
  const dollars = micro / 1_000_000;
  return `$${dollars.toFixed(6)}`;
}

const Credits = {
  // ── pricing helpers (exported for tests / admin panel) ────────────────────
  // NOTE: microToDisplay is internal-only (see JSDoc) — do not render to end users.

  calculateCost,
  dollarsToMicro,
  microToDisplay,

  // ── balance ────────────────────────────────────────────────────────────────

  /**
   * Get the user's current credit balance (microdollars).
   * @param {number} userId
   * @returns {Promise<number>} balance in microdollars
   */
  async getBalance(userId) {
    if (!userId) return 0;
    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: { credits_balance: true },
    });
    return user?.credits_balance ?? 0;
  },

  /**
   * Check if the user has at least `minMicro` microdollars available.
   * Admins always pass.
   * @param {number} userId
   * @param {number} [minMicro=1]
   * @param {string} [role="default"]
   * @returns {Promise<boolean>}
   */
  async hasCredits(userId, minMicro = 1, role = "default") {
    if (role === "admin") return true;
    if (!userId) return false;
    const balance = await this.getBalance(userId);
    return balance >= minMicro;
  },

  // ── debit ──────────────────────────────────────────────────────────────────

  /**
   * Debit a flat amount (microdollars) from the user's balance.
   * The balance never goes negative; the full requested amount is
   * always recorded in credit_transactions so admins see the true cost.
   *
   * @param {number} userId
   * @param {number} amount - cost in microdollars (must be > 0)
   * @param {string|null} [reference] - e.g. Venice response ID
   * @param {{model?: string, input_tokens?: number, output_tokens?: number}} [usage]
   * @returns {Promise<{userId: number, debited: number, newBalance: number}>}
   */
  async debit(userId, amount, reference = null, usage = null) {
    if (!userId || amount <= 0) {
      return { userId, debited: 0, newBalance: 0 };
    }

    return prisma.$transaction(async (tx) => {
      const user = await tx.users.findUnique({
        where: { id: userId },
        select: { credits_balance: true },
      });
      if (!user) throw new Error(`User ${userId} not found`);

      const currentBalance = user.credits_balance ?? 0;
      // Cap at current balance — never go negative
      const debited = Math.min(amount, currentBalance);
      if (debited <= 0) {
        return { userId, debited: 0, newBalance: currentBalance };
      }

      const updated = await tx.users.update({
        where: { id: userId },
        data: { credits_balance: currentBalance - debited },
      });

      await tx.credit_transactions.create({
        data: {
          user_id: userId,
          amount: -amount, // negative = debit; record full requested cost
          type: "debit",
          reference,
          model: usage?.model ?? MODEL,
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
        },
      });

      return { userId, debited, newBalance: updated.credits_balance };
    });
  },

  /**
   * Debit based on actual token usage. Calculates cost from the
   * input/output rates and calls `debit` internally.
   *
   * @param {number} userId
   * @param {object} usage
   * @param {number} usage.inputTokens  — prompt tokens from Venice `usage`
   * @param {number} usage.outputTokens — completion tokens from Venice `usage`
   * @param {string} [usage.model]
   * @param {string|null} [usage.reference] — Venice response ID
   * @returns {Promise<{userId: number, debited: number, newBalance: number, cost: number}>}
   */
  async debitUsage(
    userId,
    { inputTokens = 0, outputTokens = 0, model = MODEL, reference = null }
  ) {
    const cost = calculateCost(inputTokens, outputTokens);
    if (cost <= 0) return { userId, debited: 0, newBalance: 0, cost: 0 };

    const result = await this.debit(userId, cost, reference, {
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });

    return { ...result, cost };
  },

  // ── credit (top-up / refund / bonus) ───────────────────────────────────────

  /**
   * Add credits to the user's balance.
   * @param {number} userId
   * @param {number} amount - microdollars to add (must be > 0)
   * @param {string} [type="purchase"] - "purchase" | "refund" | "credit"
   * @param {string|null} [reference] - e.g. Coinbase charge ID
   * @returns {Promise<object>} updated user record
   */
  async credit(userId, amount, type = "purchase", reference = null) {
    if (!userId || amount <= 0) {
      throw new Error("Cannot credit 0 or negative amount");
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.users.update({
        where: { id: userId },
        data: { credits_balance: { increment: amount } },
      });

      await tx.credit_transactions.create({
        data: {
          user_id: userId,
          amount, // positive = credit
          type,
          reference,
          // model / token fields stay at defaults for non-usage credits
        },
      });

      return updated;
    });
  },

  // ── transactions ───────────────────────────────────────────────────────────

  /**
   * Get a user's recent credit transactions (newest first).
   * @param {number} userId
   * @param {number} [limit=20]
   * @returns {Promise<Array>}
   */
  async getTransactions(userId, limit = 20) {
    if (!userId) return [];
    return prisma.credit_transactions.findMany({
      where: { user_id: userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },

  /**
   * Get lifetime usage stats for a user (total tokens in/out, total cost).
   * @param {number} userId
   * @returns {Promise<{totalInputTokens: number, totalOutputTokens: number, totalCostMicro: number, totalDebits: number}>}
   *   totalCostMicro is the absolute (positive) lifetime debit cost.
   *
   * @internal
   * ⚠️  totalCostMicro is an INTERNAL pricing detail. Do not surface to end users;
   *     "credits" is the customer-facing unit.
   */
  async getUsageStats(userId) {
    if (!userId) {
      return {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicro: 0,
        totalDebits: 0,
      };
    }

    const [sum] = await prisma.credit_transactions.groupBy({
      by: ["type"],
      where: { user_id: userId, type: "debit" },
      _sum: {
        input_tokens: true,
        output_tokens: true,
        amount: true,
      },
      _count: { _all: true },
    });

    return {
      totalInputTokens: sum?._sum?.input_tokens ?? 0,
      totalOutputTokens: sum?._sum?.output_tokens ?? 0,
      totalCostMicro: Math.abs(sum?._sum?.amount ?? 0),
      totalDebits: sum?._count ?? 0,
    };
  },
};

module.exports = { Credits };
