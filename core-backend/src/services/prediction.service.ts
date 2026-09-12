import { PrismaClient, Prisma } from "@prisma/client";
import { logger } from "../utils/logger";

// ============================================================
// Types
// ============================================================

export interface SavePredictionInput {
  /** Trading pair or stock symbol (e.g. "BTC/USDT", "AAPL") */
  symbol: string;
  /** Predicted direction: BUY, SELL, or HOLD */
  signal: "BUY" | "SELL" | "HOLD";
  /** ML confidence score in [0, 1] */
  confidence: number;
  /** AI-predicted target price */
  targetPrice: number;
  /** Optional current market price */
  currentPrice?: number;
  /** Raw ML model probability output */
  mlProbability?: number;
  /** Model accuracy metric (e.g. 0.82) */
  modelAccuracy?: number;
  /** Technical indicator values */
  rsi14?: number;
  sma20?: number;
  sma50?: number;
  /** Timeframe of the analysis (e.g. "1h", "1d") */
  timeframe?: string;
  /** Arbitrary metadata as key-value pairs */
  metadata?: Record<string, unknown>;
}

export interface PredictionRecord {
  id: string;
  symbol: string;
  signal: "BUY" | "SELL" | "HOLD";
  confidence: number;
  targetPrice: number;
  currentPrice: number | null;
  mlProbability: number | null;
  modelAccuracy: number | null;
  rsi14: number | null;
  sma20: number | null;
  sma50: number | null;
  timeframe: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Configuration
// ============================================================

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200; // base delay, doubles each attempt

// ============================================================
// PredictionService — Durable persistence for AI predictions
// ============================================================

export class PredictionService {
  private static instance: PredictionService;
  private prisma: PrismaClient;
  private healthy: boolean = true;

  private constructor() {
    this.prisma = new PrismaClient();
  }

  /** Get or create the singleton instance */
  public static getInstance(): PredictionService {
    if (!PredictionService.instance) {
      PredictionService.instance = new PredictionService();
    }
    return PredictionService.instance;
  }

  /**
   * Check database connectivity. Throws if unreachable.
   * Used by health-check endpoints.
   */
  public async healthCheck(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      this.healthy = true;
      return true;
    } catch (error) {
      this.healthy = false;
      logger.error("[PredictionService] Health check failed", {
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Persist a prediction to the database with retry logic.
   *
   * @param input - The prediction data to save
   * @returns The created Prediction record
   * @throws If all retry attempts fail
   */
  public async savePrediction(
    input: SavePredictionInput,
  ): Promise<PredictionRecord> {
    const { symbol, signal, confidence, targetPrice } = input;

    // ── Input validation ──
    if (!symbol?.trim()) {
      throw new Error("[PredictionService] symbol is required");
    }
    if (!["BUY", "SELL"].includes(signal)) {
      throw new Error(
        `[PredictionService] invalid signal: "${signal}" — must be BUY or SELL (the engine never emits HOLD)`,
      );
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(
        `[PredictionService] confidence must be in [0, 1], got ${confidence}`,
      );
    }
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      throw new Error(
        `[PredictionService] targetPrice must be > 0, got ${targetPrice}`,
      );
    }

    const cleanedSymbol = symbol.trim().toUpperCase();

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.info("[PredictionService] Saving prediction", {
          attempt,
          symbol: cleanedSymbol,
          signal,
          confidence,
          targetPrice,
        });

        const record = await this.prisma.prediction.create({
          data: {
            symbol: cleanedSymbol,
            signal,
            confidence,
            targetPrice,
            currentPrice: input.currentPrice ?? null,
            mlProbability: input.mlProbability ?? null,
            modelAccuracy: input.modelAccuracy ?? null,
            rsi14: input.rsi14 ?? null,
            sma20: input.sma20 ?? null,
            sma50: input.sma50 ?? null,
            timeframe: input.timeframe ?? "1d",
            metadata: input.metadata ? JSON.stringify(input.metadata) : null,
          },
        });

        logger.info("[PredictionService] Prediction saved", {
          id: record.id,
          symbol: record.symbol,
          signal: record.signal,
          confidence: record.confidence,
          targetPrice: record.targetPrice,
          elapsed: attempt > 1 ? `after ${attempt} retries` : "first attempt",
        });

        return this.mapToRecord(record);
      } catch (error) {
        lastError = error as Error;

        // If it's a known Prisma connection issue, retry
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          logger.warn(
            "[PredictionService] Prisma known error on attempt %d/%d",
            attempt,
            MAX_RETRIES,
            {
              code: error.code,
              message: error.message,
              symbol: cleanedSymbol,
            },
          );

          // P2024 = connection pool timeout, P1001 = can't reach DB
          if (["P1001", "P1008", "P2024"].includes(error.code)) {
            if (attempt < MAX_RETRIES) {
              const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
              logger.info("[PredictionService] Retrying in %d ms...", delay);
              await this.sleep(delay);
              continue;
            }
          }
        } else if (error instanceof Prisma.PrismaClientValidationError) {
          // Schema mismatch — no point retrying
          logger.error(
            "[PredictionService] Validation error — schema mismatch",
            {
              error: error.message,
            },
          );
          throw error; // bail out immediately
        } else if (error instanceof Prisma.PrismaClientInitializationError) {
          logger.warn(
            "[PredictionService] Prisma init error on attempt %d/%d",
            attempt,
            MAX_RETRIES,
            { message: (error as Error).message },
          );
          if (attempt < MAX_RETRIES) {
            const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            logger.info("[PredictionService] Retrying in %d ms...", delay);
            await this.sleep(delay);
            continue;
          }
        }

        // Non-retriable or exhausted retries
        logger.error("[PredictionService] Failed to save prediction", {
          symbol: cleanedSymbol,
          signal,
          attempt,
          error: lastError.message,
        });
        break;
      }
    }

    throw (
      lastError ??
      new Error("[PredictionService] Unknown error saving prediction")
    );
  }

  /**
   * Retrieve the most recent predictions, optionally filtered by symbol.
   *
   * @param symbol - Optional symbol filter
   * @param limit - Max records to return (default 50, max 200)
   */
  public async getPredictions(
    symbol?: string,
    limit: number = 50,
  ): Promise<PredictionRecord[]> {
    try {
      const where = symbol?.trim()
        ? { symbol: symbol.trim().toUpperCase() }
        : {};

      const records = await this.prisma.prediction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(limit, 200),
      });

      return records.map(this.mapToRecord);
    } catch (error) {
      logger.error("[PredictionService] Failed to fetch predictions", {
        symbol,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Get a single prediction by its UUID.
   */
  public async getPredictionById(id: string): Promise<PredictionRecord | null> {
    try {
      const record = await this.prisma.prediction.findUnique({ where: { id } });
      return record ? this.mapToRecord(record) : null;
    } catch (error) {
      logger.error("[PredictionService] Failed to fetch prediction by ID", {
        id,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Delete predictions older than a given date.
   * Useful for data retention / cleanup jobs.
   *
   * @returns Number of deleted records
   */
  public async purgeOldPredictions(olderThan: Date): Promise<number> {
    try {
      const result = await this.prisma.prediction.deleteMany({
        where: { createdAt: { lt: olderThan } },
      });
      logger.info("[PredictionService] Purged old predictions", {
        count: result.count,
        olderThan: olderThan.toISOString(),
      });
      return result.count;
    } catch (error) {
      logger.error("[PredictionService] Failed to purge predictions", {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /**
   * Map a Prisma Prediction model to our clean PredictionRecord interface,
   * parsing the metadata JSON string back to an object.
   */
  private mapToRecord(record: {
    id: string;
    symbol: string;
    signal: string;
    confidence: number;
    targetPrice: number;
    currentPrice: number | null;
    mlProbability: number | null;
    modelAccuracy: number | null;
    rsi14: number | null;
    sma20: number | null;
    sma50: number | null;
    timeframe: string;
    metadata: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): PredictionRecord {
    return {
      id: record.id,
      symbol: record.symbol,
      signal: record.signal as "BUY" | "SELL" | "HOLD",
      confidence: record.confidence,
      targetPrice: record.targetPrice,
      currentPrice: record.currentPrice,
      mlProbability: record.mlProbability,
      modelAccuracy: record.modelAccuracy,
      rsi14: record.rsi14,
      sma20: record.sma20,
      sma50: record.sma50,
      timeframe: record.timeframe,
      metadata: record.metadata ? JSON.parse(record.metadata) : null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /** Promise-based sleep for retry backoff */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================
// Singleton export for easy import
// ============================================================

export const predictionService = PredictionService.getInstance();
