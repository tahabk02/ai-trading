import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";

const prisma = new PrismaClient();

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