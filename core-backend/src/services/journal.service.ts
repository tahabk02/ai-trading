import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";

const prisma = new PrismaClient();

/**
 * JournalService — PART 50 [537] local Pocket-style trade journal.
 *
 * Persists operator-recorded entries (nothing is sent to Pocket Option) with
 * the full gate snapshot for provenance. Settlement is computed client-side
 * from real PO ticks and written back here.
 */

export const JOURNAL_SIDES = ["CALL", "PUT"] as const;
export const JOURNAL_STATUSES = ["OPEN", "WIN", "LOSS", "VOID"] as const;
export type JournalSide = (typeof JOURNAL_SIDES)[number];
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

export interface RecordJournalEntryInput {
  id?: string;
  symbol: string;
  side: JournalSide;
  entryTs: number;
  entryPrice: number;
  durationSec: number;
  expiryTs: number;
  regimeGate?: string | null;
  tier?: string | null;
  executable?: boolean;
  suppressedReason?: string | null;
  bookAligned?: number | null;
  bookActive?: number | null;
  signal?: string | null;
  entrySource: string;
}

export interface SettleJournalEntryInput {
  status: Exclude<JournalStatus, "OPEN">;
  settlementPrice?: number | null;
  settlementTs?: number | null;
  voidReason?: string | null;
  settlementSource?: string | null;
}

export class JournalValidationError extends Error {}

function finiteOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class JournalService {
  /** Persist one operator-recorded entry. Returns the created row. */
  async recordEntry(input: RecordJournalEntryInput): Promise<unknown> {
    const symbol = (input.symbol || "").trim().toUpperCase();
    if (!symbol) {
      throw new JournalValidationError("Journal entry requires a symbol");
    }
    if (!JOURNAL_SIDES.includes(input.side)) {
      throw new JournalValidationError("side must be CALL or PUT");
    }
    if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
      throw new JournalValidationError("entryPrice must be a positive number");
    }
    if (!Number.isFinite(input.entryTs) || input.entryTs <= 0) {
      throw new JournalValidationError("entryTs must be a positive tick clock");
    }
    if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) {
      throw new JournalValidationError("durationSec must be positive");
    }
    const entrySource = String(input.entrySource || "").trim();
    if (!entrySource) {
      throw new JournalValidationError("entrySource is required");
    }
    const expiryTs = Number.isFinite(input.expiryTs)
      ? Math.round(input.expiryTs)
      : Math.round(input.entryTs + input.durationSec * 1000);

    const row = await prisma.journalEntry.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        symbol,
        side: input.side,
        entryTs: BigInt(Math.round(input.entryTs)),
        entryPrice: input.entryPrice,
        durationSec: Math.round(input.durationSec),
        expiryTs: BigInt(expiryTs),
        regimeGate: input.regimeGate ?? null,
        tier: input.tier ?? null,
        executable: input.executable === true,
        suppressedReason: input.suppressedReason ?? null,
        bookAligned: finiteOrNull(input.bookAligned),
        bookActive: finiteOrNull(input.bookActive),
        signal: input.signal ?? null,
        entrySource,
        // [540] A journal entry NEVER implies a signal existed.
        impliesSignal: false,
      },
    });
    logger.info("[JournalService] Entry recorded", {
      symbol,
      side: input.side,
      entryPrice: input.entryPrice,
    });
    return row;
  }

  /** List persisted entries, newest first, bounded. */
  async listEntries(limit = 100, symbol?: string): Promise<unknown[]> {
    return prisma.journalEntry.findMany({
      where: symbol?.trim() ? { symbol: symbol.trim().toUpperCase() } : {},
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    });
  }

  /** Write a settlement result back to a recorded entry. */
  async settleEntry(
    id: string,
    input: SettleJournalEntryInput,
  ): Promise<unknown> {
    const cleanId = String(id || "").trim();
    if (!cleanId) throw new JournalValidationError("id is required");
    if (input.status !== "WIN" && input.status !== "LOSS" && input.status !== "VOID") {
      throw new JournalValidationError("status must be WIN, LOSS or VOID");
    }
    return prisma.journalEntry.update({
      where: { id: cleanId },
      data: {
        status: input.status,
        settlementPrice: finiteOrNull(input.settlementPrice),
        settlementTs:
          input.settlementTs === undefined || input.settlementTs === null
            ? null
            : BigInt(Math.round(input.settlementTs)),
        voidReason: input.voidReason ?? null,
        settlementSource: input.settlementSource ?? null,
      },
    });
  }
}

export const journalService = new JournalService();
