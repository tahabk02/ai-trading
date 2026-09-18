-- CreateTable
CREATE TABLE "SignalOutcome" (
    "id" TEXT NOT NULL,
    "signalId" TEXT,
    "symbol" TEXT NOT NULL,
    "direction" TEXT,
    "confidence" DOUBLE PRECISION,
    "tier" TEXT NOT NULL DEFAULT 'T5',
    "outcome" TEXT NOT NULL,
    "quality" DOUBLE PRECISION,
    "factors" TEXT,
    "entry" DOUBLE PRECISION,
    "exitPrice" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION,
    "timeframe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SignalOutcome_symbol_idx" ON "SignalOutcome"("symbol");

-- CreateIndex
CREATE INDEX "SignalOutcome_outcome_idx" ON "SignalOutcome"("outcome");

-- CreateIndex
CREATE INDEX "SignalOutcome_tier_idx" ON "SignalOutcome"("tier");

-- CreateIndex
CREATE INDEX "SignalOutcome_signalId_idx" ON "SignalOutcome"("signalId");

-- CreateIndex
CREATE INDEX "SignalOutcome_createdAt_idx" ON "SignalOutcome"("createdAt");

-- AlterTable (elastic): `signalId` references Signal only when a persisted
-- signal exists; rows may be recorded without one (snapshot ingestion), so the
-- FK is added without dropping existing rows.
ALTER TABLE "SignalOutcome" ADD CONSTRAINT "SignalOutcome_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;