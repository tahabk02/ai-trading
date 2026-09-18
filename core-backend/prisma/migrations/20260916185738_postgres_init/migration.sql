-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "indicators" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "targetPrice" DOUBLE PRECISION NOT NULL,
    "currentPrice" DOUBLE PRECISION,
    "mlProbability" DOUBLE PRECISION,
    "modelAccuracy" DOUBLE PRECISION,
    "rsi14" DOUBLE PRECISION,
    "sma20" DOUBLE PRECISION,
    "sma50" DOUBLE PRECISION,
    "timeframe" TEXT NOT NULL DEFAULT '1d',
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL DEFAULT '1d',
    "confidenceGuardrail" DOUBLE PRECISION NOT NULL DEFAULT 0.80,
    "maxRequestsPerMin" INTEGER NOT NULL DEFAULT 120,
    "responseSlaMs" INTEGER NOT NULL DEFAULT 800,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "startingEquity" DOUBLE PRECISION NOT NULL DEFAULT 10000,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "peakEquity" DOUBLE PRECISION NOT NULL DEFAULT 10000,
    "tradesToday" INTEGER NOT NULL DEFAULT 0,
    "winsToday" INTEGER NOT NULL DEFAULT 0,
    "lossesToday" INTEGER NOT NULL DEFAULT 0,
    "killSwitchLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedReason" TEXT,
    "lockedAt" TIMESTAMP(3),
    "unlockedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetHistory" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL DEFAULT '1m',
    "bucketStartMs" BIGINT NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" INTEGER,
    "tickCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TickHistory" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "tsMs" BIGINT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "volume" INTEGER,
    "side" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TickHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Signal_symbol_idx" ON "Signal"("symbol");

-- CreateIndex
CREATE INDEX "Signal_createdAt_idx" ON "Signal"("createdAt");

-- CreateIndex
CREATE INDEX "Prediction_symbol_idx" ON "Prediction"("symbol");

-- CreateIndex
CREATE INDEX "Prediction_createdAt_idx" ON "Prediction"("createdAt");

-- CreateIndex
CREATE INDEX "Prediction_signal_idx" ON "Prediction"("signal");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE INDEX "UserSettings_userId_idx" ON "UserSettings"("userId");

-- CreateIndex
CREATE INDEX "RiskRule_userId_idx" ON "RiskRule"("userId");

-- CreateIndex
CREATE INDEX "RiskRule_userId_ruleType_idx" ON "RiskRule"("userId", "ruleType");

-- CreateIndex
CREATE UNIQUE INDEX "RiskState_userId_key" ON "RiskState"("userId");

-- CreateIndex
CREATE INDEX "RiskState_userId_dayKey_idx" ON "RiskState"("userId", "dayKey");

-- CreateIndex
CREATE INDEX "AssetHistory_symbol_timeframe_bucketStartMs_idx" ON "AssetHistory"("symbol", "timeframe", "bucketStartMs");

-- CreateIndex
CREATE INDEX "AssetHistory_createdAt_idx" ON "AssetHistory"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssetHistory_symbol_timeframe_bucketStartMs_key" ON "AssetHistory"("symbol", "timeframe", "bucketStartMs");

-- CreateIndex
CREATE INDEX "TickHistory_symbol_tsMs_idx" ON "TickHistory"("symbol", "tsMs");

-- CreateIndex
CREATE INDEX "TickHistory_createdAt_idx" ON "TickHistory"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TickHistory_symbol_tsMs_key" ON "TickHistory"("symbol", "tsMs");
