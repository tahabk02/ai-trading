/**
 * history.routes.ts — 30-MINUTE HISTORICAL DATA LAYER (Alpha.5 Pro, Part 3).
 *
 * GET /api/v1/history?symbol=XYZ&window=30m — persisted OHLCV bars + tick count
 *   for one asset, read back from the SQLite store the collector filled from the
 *   REAL observed tape. `window` is validated to 1m..720m (default 30m).
 *
 * GET /api/v1/health/history?symbol=XYZ — persisted-window health proof
 *   (bars_30m / ticks_30m / window_complete). Mirrored on the ROOT namespace
 *   as /health/history so the autopilot probe stays consistent with the rest
 *   of the /health surface.
 */

import { Router, Request, Response } from "express";
import { historyCollector, HISTORY_WINDOW_MINUTES, HistoryBar } from "../services/historyCollector.service";
import { logger } from "../utils/logger";

const router = Router();

function parseWindow(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(720, Math.round(n)));
}

export function historyBarsToJson(
  bars: HistoryBar[],
  symbol: string,
  timeframe = "1m",
): Array<Record<string, unknown>> {
  return bars.map((b) => ({
    symbol,
    timeframe,
    bucket_start_ms: b.bucket_start_ms,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    tick_count: b.tick_count,
  }));
}

/**
 * GET /api/v1/history?symbol=XYZ&window=30m
 */
router.get("/history", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? "")
    .trim()
    .toUpperCase();
  if (!symbol) {
    return res.status(400).json({ error: "symbol is required" });
  }
  const windowMinutes = parseWindow(req.query.window, HISTORY_WINDOW_MINUTES);
  try {
    const nowMs = Date.now();
    const [bars, ticksCount] = await Promise.all([
      historyCollector.getAssetHistoryBars(symbol, windowMinutes, nowMs),
      historyCollector.getTickCount(symbol, windowMinutes, nowMs),
    ]);
    return res.json({
      symbol,
      window: `${windowMinutes}m`,
      bars: historyBarsToJson(bars, symbol),
      ticks_count: ticksCount,
      last_update: bars.length > 0 ? new Date(nowMs).toISOString() : null,
    });
  } catch (err) {
    logger.error("History route failed", {
      symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: "History read failed" });
  }
});

/**
 * GET /api/v1/health/history?symbol=XYZ — persisted-window health proof.
 * Also mounted on the ROOT namespace as /health/history (see health.routes.ts).
 */
router.get("/health/history", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? req.query.s ?? "")
    .trim()
    .toUpperCase();
  if (!symbol) {
    return res.status(400).json({ error: "symbol is required" });
  }
  try {
    const health = await historyCollector.getHistoryHealth(symbol);
    if (!health.window_complete) {
      return res.status(202).json({
        ...health,
        message: `insufficient history: ${health.bars_30m}/30 bars persisted`,
      });
    }
    return res.json(health);
  } catch (err) {
    logger.error("History health route failed", {
      symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: "History health read failed" });
  }
});

/**
 * POST /api/v1/history/ingest — upsert REAL externally-observed bars
 *   (Alpha.5 Pro, Part 6.3). The ai-engine's 60s AssetHistory job pushes its
 *   independently-observed real prices here; idempotent on the
 *   (symbol, timeframe, bucketStartMs) key, zero fabrication.
 */
function isDbUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /P1001|P1008|P1017|P2024|ECONNREFUSED|can't reach database server|localhost:5433|database system is starting up/i.test(
    message,
  );
}

router.post("/history/ingest", async (req: Request, res: Response) => {
  const t0 = Date.now();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const timeframe = String(body.timeframe ?? "1m").trim() || "1m";
  const bars = Array.isArray(body.bars) ? body.bars : [];

  const finish = (status: number, payload: Record<string, unknown>) => {
    const latencyMs = Date.now() - t0;
    const message = `[history] symbol=${symbol || "-"} status=${status} latency_ms=${latencyMs}`;
    const meta = { symbol, status, latencyMs, timeframe };
    if (status >= 500) {
      logger.error(message, meta);
    } else {
      logger.info(message, meta);
    }
    return res.status(status).json(payload);
  };

  if (!symbol) {
    return finish(400, { error: "symbol is required" });
  }
  if (bars.length === 0) {
    return finish(400, { error: "bars is required" });
  }

  const parsed: Array<{
    bucketStartMs: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number | null;
    tickCount?: number;
  }> = [];
  for (const raw of bars) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const bucketStartMs = Number(b.bucketStartMs);
    if (!Number.isFinite(bucketStartMs) || bucketStartMs <= 0) {
      return finish(400, {
        error: "each bar needs a positive numeric bucketStartMs",
      });
    }
    const open = Number(b.open);
    const high = Number(b.high);
    const low = Number(b.low);
    const close = Number(b.close);
    if (![open, high, low, close].every(Number.isFinite)) {
      return finish(400, {
        error: "each bar needs finite numeric open/high/low/close",
      });
    }
    parsed.push({
      bucketStartMs,
      open,
      high,
      low,
      close,
      volume: b.volume == null ? null : Number(b.volume),
      tickCount: b.tickCount == null ? undefined : Number(b.tickCount),
    });
  }

  try {
    const upserted = await historyCollector.upsertBars(symbol, timeframe, parsed);
    return finish(200, {
      ok: true,
      symbol,
      timeframe,
      window: "30m",
      ingested: upserted,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const status = isDbUnavailableError(err) ? 503 : 500;
    const payload =
      status === 503
        ? { error: "db_unavailable", detail }
        : { error: "History ingest failed", detail };
    return finish(status, payload);
  }
});

export default router;