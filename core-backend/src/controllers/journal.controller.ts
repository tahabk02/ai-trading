import { Request, Response } from "express";
import { logger } from "../utils/logger";
import {
  journalService,
  JournalValidationError,
  JOURNAL_SIDES,
} from "../services/journal.service";

/**
 * journal.controller.ts — PART 50 [537] local Pocket-style trade journal.
 *
 * The journal is LOCAL: these routes persist operator-recorded entries and
 * their settlements. Nothing is ever forwarded to Pocket Option.
 */

/** Prisma returns `entryTs`/`expiryTs`/`settlementTs` as BigInt; JSON.stringify
 *  refuses BigInt, so every row is safely projected to numbers first. */
function serializeEntry(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return out;
}

function errStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

/**
 * Parse a query value that may arrive as a string, a repeated-param array, or
 * be absent. Returns a clamped integer: `?limit=abc`, `?limit=0`,
 * `?limit=-5&limit=999` all resolve to a safe value in [1, 500] rather than
 * reaching Prisma as NaN (which would surface as a 500).
 */
function parseBoundedInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const n = parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export const createJournalEntry = async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    return res.status(400).json({ error: "symbol is required" });
  }
  const side = String(body.side ?? "").trim().toUpperCase();
  if (!JOURNAL_SIDES.includes(side as "CALL" | "PUT")) {
    return res.status(400).json({ error: 'side must be "CALL" or "PUT"' });
  }
  const entryPrice = Number(body.entryPrice);
  const entryTs = Number(body.entryTs);
  const durationSec = Number(body.durationSec);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return res.status(400).json({ error: "entryPrice must be a positive number" });
  }
  if (!Number.isFinite(entryTs) || entryTs <= 0) {
    return res.status(400).json({ error: "entryTs (broker/tick clock) is required" });
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return res.status(400).json({ error: "durationSec must be positive" });
  }
  const entrySource = String(body.entrySource ?? "").trim();
  if (!entrySource) {
    return res.status(400).json({ error: "entrySource is required" });
  }
  try {
    const row = (await journalService.recordEntry({
      symbol,
      side: side as "CALL" | "PUT",
      entryTs,
      entryPrice,
      durationSec,
      expiryTs: Number(body.expiryTs) || entryTs + durationSec * 1000,
      regimeGate: body.regimeGate == null ? null : String(body.regimeGate),
      tier: body.tier == null ? null : String(body.tier),
      executable: body.executable === true,
      suppressedReason:
        body.suppressedReason == null ? null : String(body.suppressedReason),
      bookAligned:
        body.bookAligned == null ? null : Number(body.bookAligned),
      bookActive: body.bookActive == null ? null : Number(body.bookActive),
      signal: body.signal == null ? null : String(body.signal),
      entrySource,
    })) as Record<string, unknown>;
    return res.status(201).json(serializeEntry(row));
  } catch (err) {
    if (err instanceof JournalValidationError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error("[journal.controller] create failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: errStack(err),
    });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

export const listJournalEntries = async (req: Request, res: Response) => {
  try {
    const count = parseBoundedInt(req.query.limit, 100, 1, 500);
    const rawSymbol = req.query.symbol;
    const symbol = Array.isArray(rawSymbol) ? rawSymbol[0] : rawSymbol;
    const rows = (await journalService.listEntries(
      count,
      typeof symbol === "string" ? symbol : undefined,
    )) as Array<Record<string, unknown>>;
    return res.json({ entries: rows.map(serializeEntry), count: rows.length });
  } catch (err) {
    logger.error("[journal.controller] list failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: errStack(err),
    });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

export const settleJournalEntry = async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) {
    return res.status(400).json({ error: "id is required" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const status = String(body.status ?? "").trim().toUpperCase();
  if (status !== "WIN" && status !== "LOSS" && status !== "VOID") {
    return res.status(400).json({ error: "status must be WIN, LOSS or VOID" });
  }
  try {
    const row = (await journalService.settleEntry(id, {
      status: status as "WIN" | "LOSS" | "VOID",
      settlementPrice:
        body.settlementPrice == null ? null : Number(body.settlementPrice),
      settlementTs:
        body.settlementTs == null ? null : Number(body.settlementTs),
      voidReason: body.voidReason == null ? null : String(body.voidReason),
      settlementSource:
        body.settlementSource == null ? null : String(body.settlementSource),
    })) as Record<string, unknown>;
    return res.json(serializeEntry(row));
  } catch (err) {
    if (err instanceof JournalValidationError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error("[journal.controller] settle failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
      stack: errStack(err),
    });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
