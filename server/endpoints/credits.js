const prisma = require("../utils/prisma");
const { v4: uuidv4 } = require("uuid");
const { userFromSession, multiUserMode } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { Credits } = require("../models/credits");

/**
 * Credit management endpoints.
 *
 * GET  /credits              — current balance + recent transactions
 * POST /credits/debit-test   — admin-only: simulate a debit (for testing)
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

      response.json({
        balance,
        transactions,
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

        const { userId, amount = 100, reference = null } = request.body;
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
        response.json({ success: true, ...result });
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
        } = request.body;
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
        response.json({
          success: true,
          credits_balance: updated.credits_balance,
        });
      } catch (e) {
        console.error("[credits] grant-test error:", e);
        response.status(500).json({ message: e.message });
      }
    }
  );
}

module.exports = { creditEndpoints };
