/**
 * historyCollector.service.ts — 30-MINUTE HISTORICAL DATA LAYER (Alpha.5 Pro,
 * Part 3). Built strictly from the REAL observed live OTC tape.
 *
 * Every 60s the collector reads each tracked symbol's genuine tick window
 * (realtimeTickBuffer, up to 2000 prints ≈ 33 min at 1Hz), buckets it into
 * 1-minute OHLCV bars, and upserts AssetHistory + TickHistory rows into the
 * SQLite store. ZERO fabrication: a bar/tick row only exists when real prints
 * were observed — volume stays NULL when the feed carries no genuine size.
 */

import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";
import { realtimeTickBuffer } from "./realtimeTickBuffer.service";

export const HISTORY_WINDOW_MINUTES = 30;
export const HISTORY_BUCKET_MS = 60_000;
export const HISTORY_TICKS_WINDOW = 2000;
export const HISTORY_COLLECTOR_INTERVAL_MS = 60_000;
/** Newest-N persisted 1m bars read once per symbol at boot (PART 32.3 [248]). */
export const HISTORY_BACKFILL_BAR_LIMIT = 1_500;

export interface HistoryTickInput {
  price: number;
  tsMs: number;
  volume?: number | null;
}

export interface HistoryBar {
  bucket_start_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  tick_count: number;
}

/** Epoch ms of the 1-minute bucket a tick falls into. */
export function minuteBucket(tsMs: number): number {
  return Math.floor(tsMs / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
}

/**
 * Pure OHLCV rollup: group real ticks by minute bucket, oldest bucket first.
 * Only finite positive prices participate; volume accumulates ONLY real feed
 * volume (stays null when the tape carries none).
 */
export function buildMinuteBars(ticks: HistoryTickInput[]): HistoryBar[] {
  const buckets = new Map<
    number,
    {
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number | null;
      tickCount: number;
    }
  >();
  for (const tick of ticks) {
    if (!Number.isFinite(tick.price) || tick.price <= 0) continue;
    const b = minuteBucket(tick.tsMs);
    let bar = buckets.get(b);
    if (!bar) {
      bar = {
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: null,
        tickCount: 0,
      };
      buckets.set(b, bar);
    }
    bar.high = Math.max(bar.high, tick.price);
    bar.low = Math.min(bar.low, tick.price);
    bar.close = tick.price;
    bar.tickCount += 1;
    if (tick.volume != null) {
      const real = Number(tick.volume);
      bar.volume = (bar.volume ?? 0) + Math.max(0, real);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket_start_ms, bar]) => ({
      bucket_start_ms,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      tick_count: bar.tickCount,
    }));
}

const prisma = new PrismaClient();

/**
 * ── DATABASE RESILIENCE ────────────────────────────────────────────────────
 *
 * This collector is a BACKGROUND layer. It persists real ticks and feeds the
 * boot backfill. Neither is allowed to take the API server down when Postgres
 * is briefly unreachable (container restart, network blip, laptop resume).
 *
 * Two concrete failure modes existed before this block:
 *
 *  1. `getAssetHistoryBars` / `getRecentBars` / `getHistoryHealth` had NO
 *     try/catch. They are called straight from HTTP routes
 *     (routes/history.routes.ts, routes/health.routes.ts), so a DB outage
 *     turned every history request into an unhandled rejection → HTTP 500.
 *  2. `run()` DOES catch per symbol, but with ~44 symbols that is 44 identical
 *     "Can't reach database server" traces every 60 seconds. The real problem
 *     (the database is down) is buried under the symptom (one symbol failed).
 *
 * `db()` therefore classifies the failure instead of swallowing it blindly:
 * a CONNECTIVITY failure is logged once per outage and answered with an honest
 * empty result, while anything else is rethrown so a genuine query or schema
 * bug still surfaces loudly instead of masquerading as "no history".
 *
 * HONESTY NOTE: the fallback is EMPTY history, never fabricated history. A
 * chart with no bars is visibly empty; a chart with invented bars is a lie.
 */

/**
 * Prisma error codes that mean "the database is momentarily unreachable" — the
 * transient class that must degrade to empty history instead of failing.
 *
 * P1000 (authentication failed) and P1003 (database does not exist) are
 * deliberately NOT in this set, even though they used to be. They are not
 * transient: they mean the configured credentials do not match the database,
 * and no amount of retrying will fix them. Absorbing them here was actively
 * harmful — it served silently EMPTY charts while Postgres filled its log with
 * `FATAL: password authentication failed`, which looks exactly like "no market
 * data yet" to every downstream reader. A misconfiguration must be loud, not
 * quiet. They fall through and surface as a real error.
 *
 * P1017 (server closed the connection) and P2024 (pool fetch timeout) are
 * included because both genuinely recover on their own once the database
 * returns or the pool drains.
 */
const DB_UNREACHABLE_CODES = new Set([
  "P1001", // can't reach database server
  "P1002", // database server timed out
  "P1008", // operation timed out
  "P1017", // server closed the connection
  "P2024", // timed out fetching a connection from the pool
]);

/** Repeat connectivity failures are logged at most this often. */
const DB_LOG_BACKOFF_MS = 60_000;

function isDbUnreachable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && DB_UNREACHABLE_CODES.has(code);
}

/** Health summary for ONE symbol over the 30-minute window. */
export interface AssetHistoryHealth {
  symbol: string;
  bars_30m: number;
  ticks_30m: number;
  min_bucket_ms: number | null;
  max_bucket_ms: number | null;
  window_complete: boolean;
}

class HistoryCollectorService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunAt: string | null = null;
  private lastStats: Map<string, { bars: number; ticks: number }> = new Map();

  /** Consecutive connectivity failures, reset on the first success. */
  private dbFailures = 0;
  /** Epoch ms the current outage began, for the recovery log line. */
  private dbDownSince: number | null = null;
  /** Epoch ms of the last outage log, enforcing DB_LOG_BACKOFF_MS. */
  private lastDbLogAt = 0;

  /**
   * Run one DB operation, degrading gracefully ONLY on connectivity failure.
   *
   * @param label    operation name for the log (e.g. "assetHistory.upsert")
   * @param op       the Prisma call
   * @param fallback returned to the caller when the database is unreachable
   *
   * Connectivity failures return `fallback`; every other error is rethrown so a
   * real query/schema bug is never hidden behind a silently empty result.
   */
  private async db<T>(label: string, op: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const result = await op();
      if (this.dbFailures > 0) {
        logger.info("History collector: database reachable again", {
          after_consecutive_failures: this.dbFailures,
          down_for_ms: this.dbDownSince ? Date.now() - this.dbDownSince : 0,
        });
        this.dbFailures = 0;
        this.dbDownSince = null;
      }
      return result;
    } catch (err) {
      if (!isDbUnreachable(err)) throw err;

      this.dbFailures += 1;
      const now = Date.now();
      if (this.dbDownSince === null) this.dbDownSince = now;
      if (now - this.lastDbLogAt >= DB_LOG_BACKOFF_MS) {
        this.lastDbLogAt = now;
        logger.error("History collector: database unavailable — degrading to empty history", {
          operation: label,
          consecutive_failures: this.dbFailures,
          error: err instanceof Error ? err.message : String(err),
          hint:
            "Postgres unreachable. A NATIVELY-run core-backend needs host port 5433 " +
            "(localhost:5433); a containerised one needs postgres:5432. " +
            "If this persists after the database is up, restart the backend so it " +
            "re-reads DATABASE_URL.",
        });
      }
      return fallback;
    }
  }

  /** Live connectivity state, surfaced for /health. */
  public dbStatus(): { reachable: boolean; consecutiveFailures: number; downSince: string | null } {
    return {
      reachable: this.dbFailures === 0,
      consecutiveFailures: this.dbFailures,
      downSince: this.dbDownSince ? new Date(this.dbDownSince).toISOString() : null,
    };
  }

  /**
   * One collection pass for a single symbol, from real ticks → DB rows.
   * Returns the count of bars upserted and unique ticks persisted.
   */
  public async collectForSymbol(
    symbol: string,
    nowMs = Date.now(),
  ): Promise<{ bars: number; ticksInserted: number; barsFound: number; ticksInWindow: number }> {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm) return { bars: 0, ticksInserted: 0, barsFound: 0, ticksInWindow: 0 };

    const windowTicks = realtimeTickBuffer
      .getRecentWindow(norm, HISTORY_TICKS_WINDOW)
      .filter(
        (t) =>
          Number.isFinite(t.price) &&
          t.price > 0 &&
          Number.isFinite(t.tsMs) &&
          t.tsMs >= nowMs - HISTORY_WINDOW_MINUTES * HISTORY_BUCKET_MS,
      );

    const bars = buildMinuteBars(windowTicks.map((t) => ({ price: t.price, tsMs: t.tsMs })));

    if (bars.length === 0 && windowTicks.length === 0) {
      return { bars: 0, ticksInserted: 0, barsFound: 0, ticksInWindow: 0 };
    }

    let barsUpserted = 0;
    for (const bar of bars) {
      const bucket = BigInt(bar.bucket_start_ms);
      const record = {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        tickCount: bar.tick_count,
      };
      const persisted = await this.db(
        "assetHistory.upsert",
        () =>
          prisma.assetHistory.upsert({
            where: {
              symbol_timeframe_bucketStartMs: {
                symbol: norm,
                timeframe: "1m",
                bucketStartMs: bucket,
              },
            },
            update: record,
            create: {
              symbol: norm,
              timeframe: "1m",
              bucketStartMs: bucket,
              ...record,
            },
          }),
        null,
      );
      // Only count a bar we actually wrote. `db()` returns null on a
      // connectivity failure, so incrementing unconditionally would report
      // bars in the health summary that were never persisted.
      if (persisted) barsUpserted += 1;
    }

    let ticksInserted = 0;
    if (windowTicks.length > 0) {
      // SQLite has no skipDuplicates — dedupe EXISTING (symbol, tsMs) rows by
      // reading what's already persisted for the window, then insert only the
      // genuinely new prints. Step-merges make passes idempotent.
      const cutoff = BigInt(nowMs - HISTORY_WINDOW_MINUTES * HISTORY_BUCKET_MS);
      const existing = await this.db(
        "tickHistory.findMany",
        () =>
          prisma.tickHistory.findMany({
            where: { symbol: norm, tsMs: { gte: cutoff } },
            select: { tsMs: true },
          }),
        null,
      );
      // Unreachable DB → we cannot know what is already persisted, so inserting
      // blind risks duplicate (symbol, tsMs) rows. Skip the tick insert for this
      // pass; the next successful pass re-reads and converges.
      if (existing === null) {
        this.lastStats.set(norm, { bars: barsUpserted, ticks: 0 });
        return {
          bars: barsUpserted,
          ticksInserted: 0,
          barsFound: bars.length,
          ticksInWindow: windowTicks.length,
        };
      }
      const existingSet = new Set(existing.map((r) => r.tsMs.toString()));
      const fresh = windowTicks
        .map((t) => ({
          symbol: norm,
          tsMs: BigInt(t.tsMs),
          price: t.price,
          volume: null,
          side: null,
        }))
        .filter((row) => !existingSet.has(row.tsMs.toString()));
      if (fresh.length > 0) {
        try {
          const result = await prisma.tickHistory.createMany({ data: fresh });
          ticksInserted =
            typeof result === "object" && result !== null ? Number(result.count) : 0;
        } catch (err: any) {
          // P2002 = unique constraint (symbol, tsMs): a concurrent writer already
          // persisted these real ticks. The overlap is honest — we skip and move on.
          if (err?.code === "P2002" || isDbUnreachable(err)) {
            ticksInserted = 0;
          } else {
            throw err;
          }
        }
      }
    }

    this.lastStats.set(norm, { bars: barsUpserted, ticks: ticksInserted });
    return {
      bars: barsUpserted,
      ticksInserted,
      barsFound: bars.length,
      ticksInWindow: windowTicks.length,
    };
  }

  /**
   * Ingest externally-sourced REAL bars (Alpha.5 Pro, Part 6.3) — used by the
   * ai-engine's 60s AssetHistory upsert job. Each bar is an idempotent upsert
   * keyed (symbol, timeframe, bucketStartMs); the same unique key the local
   * tape collector writes, so the ai-engine's real observations reconcile the
   * same store without duplicating rows.
   */
  public async upsertBars(
    symbol: string,
    timeframe: string,
    bars: Array<{
      bucketStartMs: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume?: number | null;
      tickCount?: number;
    }>,
  ): Promise<number> {
    const norm = (symbol || "").trim().toUpperCase();
    const tf = (timeframe || "1m").trim() || "1m";
    if (!norm || !Array.isArray(bars) || bars.length === 0) return 0;

    let upserted = 0;
    for (const bar of bars) {
      if (!Number.isFinite(bar.bucketStartMs) || bar.bucketStartMs <= 0) continue;
      const open = Number(bar.open);
      const high = Number(bar.high);
      const low = Number(bar.low);
      const close = Number(bar.close);
      if (![open, high, low, close].every(Number.isFinite)) continue;
      const record = {
        open,
        high,
        low,
        close,
        volume: bar.volume == null ? null : Number(bar.volume),
        tickCount: bar.tickCount == null ? 1 : Math.max(0, Math.round(Number(bar.tickCount))),
      };
      const persisted = await this.db(
        "assetHistory.upsert(ingest)",
        () =>
          prisma.assetHistory.upsert({
            where: {
              symbol_timeframe_bucketStartMs: {
                symbol: norm,
                timeframe: tf,
                bucketStartMs: BigInt(bar.bucketStartMs),
              },
            },
            update: record,
            create: {
              symbol: norm,
              timeframe: tf,
              bucketStartMs: BigInt(bar.bucketStartMs),
              ...record,
            },
          }),
        null,
      );
      if (persisted) upserted += 1;
    }
    return upserted;
  }

  /** One full pass: every symbol with real ticks in the ring. */
  public async run(
    nowMs = Date.now(),
  ): Promise<{ symbols: number; bars: number; ticks: number }> {
    if (this.running) {
      return { symbols: 0, bars: 0, ticks: 0 };
    }
    this.running = true;
    try {
      const symbols = realtimeTickBuffer.getTrackedSymbols();
      let totalBars = 0;
      let totalTicks = 0;
      for (const symbol of symbols) {
        try {
          const res = await this.collectForSymbol(symbol, nowMs);
          totalBars += res.bars;
          totalTicks += res.ticksInserted;
        } catch (err) {
          logger.error("History collector: symbol pass failed", {
            symbol,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.lastRunAt = new Date(nowMs).toISOString();
      if (symbols.length > 0) {
        logger.info("History collector pass complete", {
          symbols: symbols.length,
          bars: totalBars,
          ticks: totalTicks,
          last_run_at: this.lastRunAt,
        });
      }
      return { symbols: symbols.length, bars: totalBars, ticks: totalTicks };
    } finally {
      this.running = false;
    }
  }

  /** OHLCV bars for one symbol over the trailing window (oldest first). */
  public async getAssetHistoryBars(
    symbol: string,
    windowMinutes = HISTORY_WINDOW_MINUTES,
    nowMs = Date.now(),
  ): Promise<HistoryBar[]> {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm) return [];
    const cutoff = BigInt(nowMs - windowMinutes * HISTORY_BUCKET_MS);
    // Wrapped because this is served straight from routes/history.routes.ts: an
    // unhandled throw here is what turned a DB outage into an HTTP 500.
    const rows = await this.db(
      "assetHistory.findMany",
      () =>
        prisma.assetHistory.findMany({
          where: {
            symbol: norm,
            timeframe: "1m",
            bucketStartMs: { gte: cutoff },
          },
          orderBy: { bucketStartMs: "asc" },
        }),
      null,
    );
    if (rows === null) return [];
    return rows.map((r) => ({
      bucket_start_ms: Number(r.bucketStartMs),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      tick_count: r.tickCount,
    }));
  }

  /**
   * The newest `limit` persisted 1m bars for ONE symbol, oldest first.
   *
   * This is the BOOT BACKFILL read (PART 32.3 [248]). It deliberately takes a
   * ROW COUNT rather than a wall-clock window: the in-memory candle aggregator
   * needs "give me the most recent N minutes of real history", and a window
   * would silently return fewer bars than requested for a symbol whose feed is
   * sparse — which is exactly the case the backfill exists to cover.
   *
   * One read path for every asset type; nothing here inspects OTC / REAL /
   * CRYPTO.
   */
  public async getRecentBars(
    symbol: string,
    limit = HISTORY_BACKFILL_BAR_LIMIT,
  ): Promise<HistoryBar[]> {
    const norm = (symbol || "").trim().toUpperCase();
    const take = Math.max(1, Math.min(10_000, Math.round(Number(limit) || 0)));
    if (!norm) return [];
    const rows = await this.db(
      "assetHistory.findMany(backfill)",
      () =>
        prisma.assetHistory.findMany({
          where: { symbol: norm, timeframe: "1m" },
          orderBy: { bucketStartMs: "desc" },
          take,
        }),
      null,
    );
    if (rows === null) return [];
    return rows
      .map((r) => ({
        bucket_start_ms: Number(r.bucketStartMs),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        tick_count: r.tickCount,
      }))
      .reverse();
  }

  /** Real tick count for one symbol over the trailing window. */
  public async getTickCount(
    symbol: string,
    windowMinutes = HISTORY_WINDOW_MINUTES,
    nowMs = Date.now(),
  ): Promise<number> {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm) return 0;
    const cutoff = BigInt(nowMs - windowMinutes * HISTORY_BUCKET_MS);
    return this.db(
      "tickHistory.count",
      () => prisma.tickHistory.count({ where: { symbol: norm, tsMs: { gte: cutoff } } }),
      0,
    );
  }

  /** Persisted 30-minute window health for one symbol (byte-truth proof). */
  public async getHistoryHealth(
    symbol: string,
    nowMs = Date.now(),
  ): Promise<AssetHistoryHealth> {
    const bars = await this.getAssetHistoryBars(symbol, HISTORY_WINDOW_MINUTES, nowMs);
    const ticks = await this.getTickCount(symbol, HISTORY_WINDOW_MINUTES, nowMs);
    const min_bucket_ms = bars.length > 0 ? bars[0].bucket_start_ms : null;
    const max_bucket_ms =
      bars.length > 0 ? bars[bars.length - 1].bucket_start_ms : null;
    const spanMs =
      min_bucket_ms != null && max_bucket_ms != null
        ? max_bucket_ms - min_bucket_ms
        : 0;
    const window_complete =
      bars.length >= HISTORY_WINDOW_MINUTES &&
      spanMs >= (HISTORY_WINDOW_MINUTES - 1) * HISTORY_BUCKET_MS;
    return {
      symbol: (symbol || "").trim().toUpperCase(),
      bars_30m: bars.length,
      ticks_30m: ticks,
      min_bucket_ms,
      max_bucket_ms,
      window_complete,
    };
  }

  public start(intervalMs = HISTORY_COLLECTOR_INTERVAL_MS): void {
    if (this.timer) return;
    // First pass lands almost immediately; DB rows exist within seconds of
    // boot, not after the first 60s tick.
    setImmediate(() => {
      void this.run().catch((err) =>
        logger.error("History collector: initial pass failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
    this.timer = setInterval(() => {
      void this.run().catch((err) =>
        logger.error("History collector: pass failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, intervalMs);
    if (!this.timer.unref) return;
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const historyCollector = new HistoryCollectorService();
export default historyCollector;