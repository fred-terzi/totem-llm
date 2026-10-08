const prisma = require("../utils/prisma");

/**
 * Credit management for the hosted Totem beta.
 *
 * 1 credit = 1 LLM token.
 * Credits are debited after each agent/chat turn based on actual
 * token usage reported by the LLM provider (Venice).
 *
 * The balance never goes negative. If the user's balance is lower
 * than the tokens used, only the available balance is debited.
 * The full token cost is still recorded in credit_transactions
 * so the admin can see the true cost.
 */
const Credits = {
  /**
   * Get the user's current credit balance.
   * @param {number} userId
   * @returns {Promise<number>}
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
   * Check if the user has at least `minBalance` credits.
   * Admins always pass.
   * @param {number} userId
   * @param {number} [minBalance=1]
   * @param {string} [role="default"]
   * @returns {Promise<boolean>}
   */
  async hasCredits(userId, minBalance = 1, role = "default") {
    if (role === "admin") return true;
    if (!userId) return false;
    const balance = await this.getBalance(userId);
    return balance >= minBalance;
  },

  /**
   * Debit credits from the user's balance.
   * The actual debit is capped at the current balance (never goes negative).
   * The full requested amount is recorded in credit_transactions
   * so the true cost is always visible to admins.
   *
   * @param {number} userId
   * @param {number} amount - Number of credits (tokens) to debit
   * @param {string} [reference] - Transaction reference (e.g. chat ID as string)
   * @returns {Promise<{userId: number, debited: number, newBalance: number}>}
   */
  async debit(userId, amount, reference = null) {
    if (!userId || amount <= 0) {
      return { userId, debited: 0, newBalance: 0 };
    }

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.users.findUnique({
        where: { id: userId },
        select: { credits_balance: true },
      });
      if (!user) throw new Error(`User ${userId} not found`);

      const currentBalance = user.credits_balance ?? 0;
      // Cap the debit at the current balance so it never goes negative
      const debited = Math.min(amount, currentBalance);
      if (debited <= 0) {
        return { userId, debited: 0, newBalance: currentBalance };
      }

      const updated = await tx.users.update({
        where: { id: userId },
        data: { credits_balance: currentBalance - debited },
      });

      // Record the full requested amount (not the capped debit) so
      // admins can see the true cost vs what was actually charged.
      await tx.credit_transactions.create({
        data: {
          user_id: userId,
          amount: -amount,
          type: "debit",
          reference,
        },
      });

      return {
        userId,
        debited,
        newBalance: updated.credits_balance,
      };
    });

    return result;
  },

  /**
   * Credit the user's balance (purchase, refund, bonus, etc.).
   * @param {number} userId
   * @param {number} amount - Number of credits to add (must be > 0)
   * @param {string} [type="purchase"] - "purchase" | "refund" | "credit"
   * @param {string} [reference] - Transaction reference (e.g. Coinbase charge ID)
   * @returns {Promise<object>} Updated user record
   */
  async credit(userId, amount, type = "purchase", reference = null) {
    if (!userId || amount <= 0) {
      throw new Error("Cannot credit 0 or negative amount");
    }

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.users.update({
        where: { id: userId },
        data: { credits_balance: { increment: amount } },
      });

      await tx.credit_transactions.create({
        data: {
          user_id: userId,
          amount,
          type,
          reference,
        },
      });

      return updated;
    });

    return user;
  },

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
};

module.exports = { Credits };
