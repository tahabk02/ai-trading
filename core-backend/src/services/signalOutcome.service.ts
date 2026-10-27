import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";
import { AI_ENGINE_HTTP_AGENT } from "../utils/aiEngineHttp";

const prisma = new PrismaClient();

const buildAccuracyRecordUrl = (baseUrl: string): string => {
  const cleaned = baseUrl.replace(/\/+$/, "");
  if (cleaned.endsWith("/api/v1")) return `${cleaned}/accuracy/record`;
  if (cleaned.endsWith("/api")) return `${cleaned}/v1/accuracy/record`;
  return `${cleaned}/api/v1/accuracy/record`;
};

/**
 * Best-effort replication of a REAL closed outcome into the AI Engine's rolling
 * accuracy tracker and Bayesian ensemble. The local row is authoritative; an
 * AI outage must never fail or delay the trade-result API.
 */
async function forwardOutcomeToAi(
  input: RecordSignalOutcomeInput,
  safeTier: string,
): Promise<void> {
  const direction = normalizeDirection(input.direction);
  if (!direction) return;

  try {
    await axios.post(
      buildAccuracyRecordUrl(secrets.AI_ENGINE_URL),
      {
        symbol: input.symbol.trim().toUpperCase(),
        direction,
        confidence: sanitizeFloat(input.confidence),
        outcome: input.outcome,
        quality: sanitizeFloat(input.quality),
        factors: input.factors ?? null,
        entry: sanitizeFloat(input.entry),
        exit_price: sanitizeFloat(input.exitPrice),
        tier: safeTier,
        ...(input.regime ? { regime: input.regime } : {}),
        ...(input.componentScores
          ? { component_scores: input.componentScores }
          : {}),
      },
      {
        timeout: 3_000,
        httpAgent: AI_ENGINE_HTTP_AGENT,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": secrets.AI_ENGINE_API_KEY,
        },
      },
    );
  } catch (error) {
    logger.warn("[SignalOutcomeService] AI accuracy forwarding failed", {
      symbol: input.symbol,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeDirection(raw: string | null | undefined): "BUY" | "SELL" | null {
  const value = (raw || "").trim().toUpperCase();
  if (value === "BUY" || value === "CALL" || value === "LONG") return "BUY";
  if (value === "SELL" || value === "PUT" || value === "SHORT") return "SELL";
  return null;
}

/**
 * SignalOutcomeService — persistent accuracy ledger for dispatched signals.
 *
 * PART 5: every genuine closed-trade outcome is persisted as a SignalOutcome
 * row so the AI Engine's rolling accuracy tracker can reconstruct the last-N
 * decision history across restarts. ZERO fabrication — a row is only created
 * from a real fill and its real realized result.
 */

export interface RecordSignalOutcomeInput {
  symbol: string;
  direction?: string | null;
  confidence?: number | null;
  tier?: string | null;
  outcome: "WIN" | "LOSS";
  quality?: number | null;
  factors?: Record<string, number> | null;
  entry?: number | null;
  exitPrice?: number | null;
  pnl?: number | null;
  timeframe?: string | null;
  signalId?: string | null;
  /** Market regime at signal time, when known (improves Bayesian attribution). */
  regime?: string | null;
  /** Explicit signed component scores; optional if `factors` are descriptive. */
  componentScores?: Record<string, number> | null;
}

export interface SignalOutcomeStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
  byTier: Record<string, { count: number; wins: number; winRate: number | null }>;
  bySymbol: Record<string, { count: number; wins: number; winRate: number | null }>;
}

const TIERS = ["T1", "T2", "T3", "T4", "T5"];

export class SignalOutcomeService {
  /** Persist one real closed outcome. Returns the created row. */
  async recordOutcome(
    input: RecordSignalOutcomeInput,
  ): Promise<unknown> {
    const symbol = (input.symbol || "").trim().toUpperCase();
    if (!symbol) {
      throw new Error("RecordSignalOutcome requires a non-empty symbol");
    }
    if (input.outcome !== "WIN" && input.outcome !== "LOSS") {
      throw new Error("outcome must be WIN or LOSS");
    }
    const tier = (input.tier || "T5").trim().toUpperCase();
    const safeTier = TIERS.includes(tier) ? tier : "T5";

    const row = await prisma.signalOutcome.create({
      data: {
        symbol,
        direction: input.direction ?? null,
        confidence: sanitizeFloat(input.confidence),
        tier: safeTier,
        outcome: input.outcome,
        quality: sanitizeFloat(input.quality),
        factors:
          input.factors && typeof input.factors === "object"
            ? JSON.stringify(input.factors)
            : null,
        entry: sanitizeFloat(input.entry),
        exitPrice: sanitizeFloat(input.exitPrice),
        pnl: sanitizeFloat(input.pnl),
        timeframe: input.timeframe ?? null,
        signalId: input.signalId ?? null,
      },
    });
    logger.info("[SignalOutcomeService] Real outcome recorded", {
      symbol,
      direction: input.direction ?? null,
      tier: safeTier,
      outcome: input.outcome,
      pnl: sanitizeFloat(input.pnl) ?? undefined,
    });

    // Fire-and-forget: never block the HTTP response or fail the ledger write.
    void forwardOutcomeToAi({ ...input, symbol }, safeTier);

    return row;
  }

  /** List persisted outcomes, newest first, bounded. */
  async listOutcomes(limit = 100, symbol?: string): Promise<unknown[]> {
    return prisma.signalOutcome.findMany({
      where: symbol?.trim() ? { symbol: symbol.trim().toUpperCase() } : {},
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    });
  }

  /** Aggregate accuracy over a recent window of persisted outcomes. */
  async stats(windowDays = 30): Promise<SignalOutcomeStats> {
    const since = new Date(Date.now() - Number(windowDays) * 86_400_000);
    const rows = await prisma.signalOutcome.findMany({
      where: { createdAt: { gte: since } },
      select: {
        outcome: true,
        tier: true,
        symbol: true,
      },
    });

    const total = rows.length;
    const wins = rows.filter((r) => r.outcome === "WIN").length;
    const losses = rows.filter((r) => r.outcome === "LOSS").length;

    const byTier: Record<string, { count: number; wins: number; winRate: number | null }> = {};
    for (const tier of TIERS) {
      const bucket = rows.filter((r) => (r.tier || "T5") === tier);
      byTier[tier] = {
        count: bucket.length,
        wins: bucket.filter((r) => r.outcome === "WIN").length,
        winRate:
          bucket.length > 0
            ? round4(bucket.filter((r) => r.outcome === "WIN").length / bucket.length)
            : null,
      };
    }

    const bySymbol: Record<string, { count: number; wins: number; winRate: number | null }> = {};
    const symbols = [...new Set(rows.map((r) => r.symbol))];
    for (const sym of symbols) {
      const bucket = rows.filter((r) => r.symbol === sym);
      bySymbol[sym] = {
        count: bucket.length,
        wins: bucket.filter((r) => r.outcome === "WIN").length,
        winRate:
          bucket.length > 0
            ? round4(bucket.filter((r) => r.outcome === "WIN").length / bucket.length)
            : null,
      };
    }

    return {
      total,
      wins,
      losses,
      winRate: total > 0 ? round4(wins / total) : null,
      byTier,
      bySymbol,
    };
  }
}

function sanitizeFloat(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export const signalOutcomeService = new SignalOutcomeService();