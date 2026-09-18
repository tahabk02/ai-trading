import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { signalOutcomeService } from "../services/signalOutcome.service";

/** Distinguish "the database is unreachable" (recoverable, 503) from "the
 *  query failed" (a bug, 500). Mirrors the classifier in signal.controller. */
function isDbUnavailable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code && ["P1001", "P1008", "P1017", "P2024"].includes(code)) return true;
  const name = (error as { name?: string } | null)?.name;
  if (name === "PrismaClientInitializationError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /can'?t reach database server|connection (pool|refused)|Timed out fetching a new connection|ECONNREFUSED (?:127\.0\.0\.1|localhost|::1):5433/i.test(
    message,
  );
}

/** Redis/cache outages are a SEPARATE recoverable condition from a DB outage. */
function isCacheUnavailable(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (
    /redis/i.test(name) ||
    name === "MaxRetriesPerRequestError" ||
    name === "ReplyError"
  ) {
    return true;
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "NR_CLOSED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /redis|MaxRetriesPerRequest|Stream isn'?t writeable|ECONNREFUSED .*:6379/i.test(
    message,
  );
}

/**
 * POST /signal-outcomes — persist one REAL closed-trade outcome.
 * Body: { symbol, outcome: "WIN"|"LOSS", direction?, confidence?, tier?,
 *         quality?, factors?, entry?, exitPrice?, pnl?, timeframe?, signalId? }
 * Returns the created row. This is the ONLY accuracy-ingestion path for
 * persisted outcomes.
 */
export const postSignalOutcome = async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const body = req.body ?? {};
    const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
    const outcome = body.outcome as string | undefined;
    if (!symbol) {
      return res.status(400).json({
        error: "Validation Error",
        message: 'A non-empty "symbol" field is required.',
      });
    }
    if (outcome !== "WIN" && outcome !== "LOSS") {
      return res.status(400).json({
        error: "Validation Error",
        message: '"outcome" must be "WIN" or "LOSS".',
      });
    }
    const fields = (["direction", "tier", "timeframe", "signalId"] as const).filter(
      (k) => typeof body[k] === "string" && body[k].length > 0,
    );
    const record = await signalOutcomeService.recordOutcome({
      symbol,
      outcome,
      direction: fields.includes("direction") ? body.direction : null,
      tier: fields.includes("tier") ? body.tier : null,
      timeframe: fields.includes("timeframe") ? body.timeframe : null,
      signalId: fields.includes("signalId") ? body.signalId : null,
      confidence:
        typeof body.confidence === "number" && Number.isFinite(body.confidence)
          ? body.confidence
          : null,
      quality:
        typeof body.quality === "number" && Number.isFinite(body.quality)
          ? body.quality
          : null,
      entry:
        typeof body.entry === "number" && Number.isFinite(body.entry)
          ? body.entry
          : null,
      exitPrice:
        typeof body.exitPrice === "number" && Number.isFinite(body.exitPrice)
          ? body.exitPrice
          : null,
      pnl:
        typeof body.pnl === "number" && Number.isFinite(body.pnl)
          ? body.pnl
          : null,
      factors:
        body.factors && typeof body.factors === "object"
          ? (body.factors as Record<string, number>)
          : null,
    });
    const latencyMs = Date.now() - t0;
    logger.info(
      `[signal-outcomes] status=201 latency_ms=${latencyMs} symbol=${symbol} outcome=${outcome}`,
    );
    return res.status(201).json(record);
  } catch (error) {
    const latencyMs = Date.now() - t0;
    if (isCacheUnavailable(error)) {
      return res.status(503).json({ error: "cache_unavailable" });
    }
    if (isDbUnavailable(error)) {
      return res
        .status(503)
        .json({ error: "db_unavailable", message: "Database is unreachable — retry." });
    }
    logger.error(
      `[signal-outcomes] status=500 latency_ms=${latencyMs}`,
      { error: error instanceof Error ? error.message : String(error) },
    );
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /signal-outcomes — list persisted outcomes. Query: ?symbol=&limit=
 */
export const getSignalOutcomes = async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
    const limit = Number(req.query.limit) || 100;
    const rows = await signalOutcomeService.listOutcomes(limit, symbol);
    const latencyMs = Date.now() - t0;
    logger.info(`[signal-outcomes] status=200 latency_ms=${latencyMs} count=${rows.length}`);
    return res.json({ count: rows.length, outcomes: rows });
  } catch (error) {
    const latencyMs = Date.now() - t0;
    if (isCacheUnavailable(error)) {
      return res.status(503).json({ error: "cache_unavailable" });
    }
    if (isDbUnavailable(error)) {
      return res
        .status(503)
        .json({ error: "db_unavailable", message: "Database is unreachable — retry." });
    }
    logger.error(
      `[signal-outcomes] status=500 latency_ms=${latencyMs}`,
      { error: error instanceof Error ? error.message : String(error) },
    );
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /signal-outcomes/stats — rolling accuracy aggregates over the last N days.
 * Query: ?windowDays=
 */
export const getSignalOutcomeStats = async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const windowDays = Number(req.query.windowDays) || 30;
    const stats = await signalOutcomeService.stats(windowDays);
    const latencyMs = Date.now() - t0;
    logger.info(`[signal-outcomes/stats] status=200 latency_ms=${latencyMs}`);
    return res.json(stats);
  } catch (error) {
    const latencyMs = Date.now() - t0;
    if (isCacheUnavailable(error)) {
      return res.status(503).json({ error: "cache_unavailable" });
    }
    if (isDbUnavailable(error)) {
      return res
        .status(503)
        .json({ error: "db_unavailable", message: "Database is unreachable — retry." });
    }
    logger.error(
      `[signal-outcomes/stats] status=500 latency_ms=${latencyMs}`,
      { error: error instanceof Error ? error.message : String(error) },
    );
    return res.status(500).json({ error: "Internal Server Error" });
  }
};