-- Add model, input_tokens, output_tokens to credit_transactions.
-- SQLite requires the table-redefine strategy for ALTER TABLE ADD COLUMN.

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_credit_transactions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "reference" TEXT,
    "model" TEXT NOT NULL DEFAULT 'e2ee-glm-5-3-flash',
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_credit_transactions" ("id", "user_id", "amount", "type", "reference", "createdAt")
SELECT "id", "user_id", "amount", "type", "reference", "createdAt" FROM "credit_transactions";

DROP TABLE "credit_transactions";
ALTER TABLE "new_credit_transactions" RENAME TO "credit_transactions";

PRAGMA foreign_keys=ON;

CREATE INDEX "credit_transactions_user_id_idx" ON "credit_transactions"("user_id");
