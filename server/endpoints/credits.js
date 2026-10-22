const { v4: uuidv4 } = require("uuid");
const { userFromSession, reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { Credits } = require("../models/credits");
const {
  microToCredits,
  formatLedgerCredits,
} = require("../utils/credits/units");

/**
 * Credit management endpoints.
 *
 * GET  /credits              — current balance + recent transactions
 * POST /credits/debit-test   — admin-only: simulate a debit (for testing)
 *
 * UNITS: the API speaks **credits** to clients (1 credit = $0.001 = 1 000 µ$,
 * see server/utils/credits/units.js). Raw microdollar values never cross the
 * API boundary. The admin test endpoints still ACCEPT µ$ in request bodies
 * (internal tooling, unchanged contract) but report results in credits.
 */
function creditEndpoints(app) {
  if (!app) return;

  app.get("/credits", [validatedRequest], async (request, response) => {
    try {
      const user = await userFromSession(request, response);
      if (!user) {
        return response.status(401).json({ message: "Not authenticated" });
      }

      const balance = await Credits.getBalance(user.id);
      const transactions = await Credits.getTransactions(user.id, 20);

      // µ$ → credits at the API boundary (spec credit-units F2). Amounts in
      // transaction rows are numeric credits with ≤2-decimal precision;
      // all other row fields pass through unchanged.
      response.json({
        balance: microToCredits(balance),
        transactions: transactions.map((row) => ({
          ...row,
          amount: parseFloat(formatLedgerCredits(row.amount)),
        })),
      });
    } catch (e) {
      console.error("[credits] GET error:", e);
      response.status(500).json({ message: "Internal error" });
    }
  });

  app.post(
    "/credits/debit-test",
    [validatedRequest],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        if (!user) {
          return response.status(401).json({ message: "Not authenticated" });
        }
        if (user.role !== "admin") {
          return response.status(403).json({ message: "Admin only" });
        }

        const { userId, amount = 100, reference = null } = reqBody(request);
        if (!userId || !amount || amount <= 0) {
          return response
            .status(400)
            .json({ message: "userId and amount (positive int) required" });
        }

        const result = await Credits.debit(
          userId,
          amount,
          reference || `test_${uuidv4().slice(0, 8)}`
        );
        // newBalance is µ$ internally — report credits (spec credit-units F3).
        response.json({
          success: true,
          ...result,
          newBalance: microToCredits(result.newBalance),
        });
      } catch (e) {
        console.error("[credits] debit-test error:", e);
        response.status(500).json({ message: e.message });
      }
    }
  );

  app.post(
    "/credits/grant-test",
    [validatedRequest],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        if (!user) {
          return response.status(401).json({ message: "Not authenticated" });
        }
        if (user.role !== "admin") {
          return response.status(403).json({ message: "Admin only" });
        }

        const {
          userId,
          amount = 100,
          type = "credit",
          reference = null,
        } = reqBody(request);
        if (!userId || !amount || amount <= 0) {
          return response
            .status(400)
            .json({ message: "userId and amount (positive int) required" });
        }

        const updated = await Credits.credit(
          userId,
          amount,
          type,
          reference || `test_${uuidv4().slice(0, 8)}`
        );
        // credits_balance is µ$ internally — report credits (F3).
        response.json({
          success: true,
          credits_balance: microToCredits(updated.credits_balance),
        });
      } catch (e) {
        console.error("[credits] grant-test error:", e);
        response.status(500).json({ message: e.message });
      }
    }
  );
}

module.exports = { creditEndpoints };
