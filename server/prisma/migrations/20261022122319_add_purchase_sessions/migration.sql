-- CreateTable
CREATE TABLE "purchase_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER NOT NULL,
    "expected_amount" BIGINT NOT NULL,
    "treasury_address" TEXT NOT NULL,
    "chain_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failure_reason" TEXT,
    "tx_hash" TEXT,
    "tx_block_number" BIGINT,
    "credited_amount" BIGINT,
    "expires_at" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_sessions_tx_hash_key" ON "purchase_sessions"("tx_hash");

-- CreateIndex
CREATE INDEX "purchase_sessions_user_id_createdAt_idx" ON "purchase_sessions"("user_id", "createdAt");
