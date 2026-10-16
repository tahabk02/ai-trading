-- PART 50 [537] — local Pocket-style trade journal (nothing sent to Pocket Option)
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryTs" BIGINT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "expiryTs" BIGINT NOT NULL,
    "regimeGate" TEXT,
    "tier" TEXT,
    "executable" BOOLEAN NOT NULL DEFAULT false,
    "suppressedReason" TEXT,
    "bookAligned" INTEGER,
    "bookActive" INTEGER,
    "signal" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "settlementPrice" DOUBLE PRECISION,
    "settlementTs" BIGINT,
    "voidReason" TEXT,
    "entrySource" TEXT NOT NULL,
    "settlementSource" TEXT,
    "impliesSignal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JournalEntry_symbol_idx" ON "JournalEntry"("symbol");
CREATE INDEX "JournalEntry_status_idx" ON "JournalEntry"("status");
CREATE INDEX "JournalEntry_createdAt_idx" ON "JournalEntry"("createdAt");
