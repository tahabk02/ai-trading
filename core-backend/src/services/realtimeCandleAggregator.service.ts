import { logger } from "../utils/logger";
import { canonicalizeSymbol } from "../utils/symbolFormat";

// ── Aggregated timeframes — Pocket Option's canonical multi-resolution grid ──
// The server computes this exact PO ladder for every live symbol and emits each
// close to EXACTLY the (symbol, timeframe) channel a client subscribed to, so a
// S10 client never sees H1 frames and vice versa. Labels are the PO canonical
// codes (S=seconds, M=minutes, H=hours, D=days): the same codes the client
// market terminal and the pocket-bridge emit. Legacy shorthand aliases ("5s",
// "1m", "1h", …) still resolve via canonicalTimeframe() for back-compat.
export type AggregatedTimeframe =
  | "S5"
  | "S10"
  | "S15"
  | "S30"
  | "M1"
  | "M2"
  | "M3"
  | "M5"
  | "M10"
  | "M15"
  | "M30"
  | "H1"
  | "H4"
  | "D1";

export const SERVER_CANDLE_TFS: AggregatedTimeframe[] = [
  "S5",
  "S10",
  "S15",
  "S30",
  "M1",
  "M2",
  "M3",
  "M5",
  "M10",
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
];

const TF_MS: Record<AggregatedTimeframe, number> = {
  S5: 5_000,
  S10: 10_000,
  S15: 15_000,
  S30: 30_000,
  M1: 60_000,
  M2: 120_000,
  M3: 180_000,
  M5: 300_000,
  M10: 600_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

// Legacy shorthand → PO canonical (so "5s", "1m", "1h" still resolve after the
// grid moved to PO codes — historical clients and stored settings keep working).
const TF_ALIASES: Record<string, AggregatedTimeframe> = {
  "5s": "S5",
  "10s": "S10",
  "15s": "S15",
  "30s": "S30",
  "1m": "M1",
  "2m": "M2",
  "3m": "M3",
  "5m": "M5",
  "10m": "M10",
  "15m": "M15",
  "30m": "M30",
  "1h": "H1",
  "4h": "H4",
  "1d": "D1",
};

const TF_LABELS: Record<number, string> = Object.fromEntries(
  Object.entries(TF_MS).map(([label, ms]) => [ms, label]),
);

const REORDER_MS = 2_000;
const SWEEP_INTERVAL_MS = 1_000;
const MAX_CLOSED_PER_TF = 512;
/** Persisted history granularity — the only resolution the store natively holds. */
const HISTORY_MINUTE_MS = 60_000;
// ── CANDLE PARITY WATCHDOG ──
// Flags any symbol that keeps receiving raw ticks while its bucket rings do
// NOT advance — a raw tick with no active bucket increment. Detected within
// the intra-family grid (1s … 1m) where write cadence MUST track ticks; the
// assertion is a validation/log signal of record (broadcastCandleParity) so a
// flat-line pair announces itself instead of silently rendering a dead axis.
const PARITY_TRACK_MAX_MS = 60_000;
const PARITY_BREACH_CYCLES = 3; // ≥3 consecutive 1s sweeps with ticking-write stall
const PARITY_FLAG_COOLDOWN_MS = 30_000;

/** Live tick-vs-bucket parity counters for one symbol (diagnostic surface). */
export interface CandleParityTelemetry {
  symbol: string;
  ticks: number;
  writes: number;
  byTf: Record<string, number>;
}

/** Parity breach alert broadcast to the symbol's subscribers. */
export interface CandleParityAlert {
  symbol: string;
  timeframe: string | null;
  ticks: number;
  writes: number;
  tickDelta: number;
  writeDelta: number;
}

type ParityHandler = (alert: CandleParityAlert) => void;

interface SymbolParity {
  norm: string;
  ticks: number;
  writes: number;
  byTf: Map<string, number>;
  seenTicks: number;
  seenWrites: number;
  seenByTf: Map<string, number>;
  zeroCycles: number;
  zeroByTf: Map<string, number>;
  lastFlagAt: number;
  lastFlagByTf: Map<string, number>;
}

// ── Server-emitted closed-candle payload (broadcastCandle shape) ──
export interface ServerClosedCandle {
  symbol: string;
  timeframe: string;
  timestamp: number; // bucket-start ms on the broker clock grid
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: true;
  /**
   * SETTLED-BAR PROVENANCE. A server-closed bar is FINAL: the bucket is sealed
   * and must never be repainted by a client-side row for the same slot. The
   * client merge keys off this exact flag (a missing flag made the precedence
   * rule dead code, so client rows silently overwrote settled bars and the
   * chart repainted/"broke" closed candles).
   */
  isFinal: true;
}

type ClosedHandler = (candle: ServerClosedCandle) => void;

// ── Per-symbol, per-tf bucket state ──
interface Bucket {
  start: number; // bucket-start ms (broker clock grid)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tickCount: number;
  lastTickMs: number;
}

interface TfState {
  open: Bucket | null;
  closed: ServerClosedCandle[];
}

function floorBucket(tsMs: number, tfMs: number): number {
  return Math.floor(tsMs / tfMs) * tfMs;
}

/** One persisted 1-minute bar, as read back out of the AssetHistory store. */
export interface PersistedMinuteBar {
  bucketStartMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  tickCount: number;
}

/** Newest-N persisted 1m bars, oldest first. Injected so tests need no DB. */
export type PersistedBarLoader = (
  symbol: string,
  limit: number,
) => Promise<PersistedMinuteBar[]>;

/**
 * How many persisted 1m bars to request per symbol at boot. The aggregator
 * retains MAX_CLOSED_PER_TF (512) bars per timeframe, so 1,500 minutes of 1m
 * history is comfortably more than enough to fill M1..M30 and still leave a
 * usable M1 window. Deeper frames (H1/H4/D1) are limited by whatever the store
 * actually holds — we never invent minutes that were never observed.
 */
export const BACKFILL_1M_BAR_LIMIT = 1_500;

/**
 * Roll persisted 1m bars UP into one coarser timeframe.
 *
 * OHLC rollup is exact and lossy in the usual way: open = first bar's open,
 * high/low = extremes across the group, close = last bar's close, volume =
 * summed real volume (falling back to the summed REAL tick count when the feed
 * carries no size, matching closeBucket's own volume convention).
 *
 * Returns null when the target is not a whole multiple of one minute. Sub-minute
 * frames (S5/S10/S15/S30) are therefore NEVER backfilled — 1m bars cannot be
 * disaggregated downward without fabricating intra-bucket movement, which this
 * project does not do. Those frames stay empty until real sub-minute ticks land.
 */
export function aggregatePersistedBars(
  bars: PersistedMinuteBar[],
  tfMs: number,
): Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null {
  if (tfMs < HISTORY_MINUTE_MS || tfMs % HISTORY_MINUTE_MS !== 0) return null;
  if (bars.length === 0) return [];

  // Persisted rows are assumed ordered, but a defensive sort keeps the rollup
  // correct if a caller ever hands over an unsorted slice.
  const ordered = [...bars].sort((a, b) => a.bucketStartMs - b.bucketStartMs);
  const out: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  let cur: { timestamp: number; open: number; high: number; low: number; close: number; volume: number } | null = null;

  for (const b of ordered) {
    if (!Number.isFinite(b.bucketStartMs) || b.bucketStartMs <= 0) continue;
    if (![b.open, b.high, b.low, b.close].every(Number.isFinite)) continue;
    const start = floorBucket(b.bucketStartMs, tfMs);
    if (cur === null || cur.timestamp !== start) {
      if (cur) out.push(cur);
      cur = {
        timestamp: start,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume != null ? b.volume : b.tickCount,
      };
      continue;
    }
    cur.high = Math.max(cur.high, b.high);
    cur.low = Math.min(cur.low, b.low);
    cur.close = b.close;
    cur.volume += b.volume != null ? b.volume : b.tickCount;
  }
  if (cur) out.push(cur);
  return out;
}

export class RealtimeCandleAggregatorService {
  private static instance: RealtimeCandleAggregatorService;

  private readonly states = new Map<string, Map<number /*tfMs*/, TfState>>();
  private closedHandler: ClosedHandler | null = null;
  private parityHandler: ParityHandler | null = null;
  private readonly parity = new Map<string, SymbolParity>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private latestTsMs = 0;
  private clockOffsetMs = 0;

  private constructor() {}

  static getInstance(): RealtimeCandleAggregatorService {
    if (!RealtimeCandleAggregatorService.instance) {
      RealtimeCandleAggregatorService.instance =
        new RealtimeCandleAggregatorService();
    }
    return RealtimeCandleAggregatorService.instance;
  }

  // ── Callback registration (called once at startup from index.ts) ──
  setClosedHandler(handler: ClosedHandler): void {
    this.closedHandler = handler;
  }

  setParityHandler(handler: ParityHandler): void {
    this.parityHandler = handler;
  }

  // ── Lifecycle ──
  start(): void {
    this.stop();
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    logger.info("[CandleAggregator] Started", {
      timeframes: SERVER_CANDLE_TFS,
      sweepMs: SWEEP_INTERVAL_MS,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  destroy(): void {
    this.stop();
    this.states.clear();
    this.parity.clear();
    this.closedHandler = null;
    this.parityHandler = null;
    this.latestTsMs = 0;
    this.clockOffsetMs = 0;
  }

  removeSymbol(symbol: string): void {
    const norm = canonicalizeSymbol(symbol);
    if (!norm) return;
    this.states.delete(norm);
    this.parity.delete(norm);
  }

  // ── Tick ingestion (fed from websocketService.broadcastLiveTick) ──
  addTick(symbol: string, price: number, tsMs: number, volume = 0): void {
    if (!symbol) return;
    if (!Number.isFinite(price) || price <= 0) return;
    if (!Number.isFinite(tsMs) || tsMs <= 0) return;

    // Single canonical key — MUST equal the room key broadcastLiveTick emits
    // on, so a tick can never fork into a bucket the chart does not read.
    const norm = canonicalizeSymbol(symbol);
    if (!norm) return;

    // Advance the broker-clock anchor for the wall-clock sweep
    if (tsMs > this.latestTsMs) {
      this.latestTsMs = tsMs;
      this.clockOffsetMs = tsMs - Date.now();
    }

    const p = this.getSymbolParity(norm);
    p.ticks += 1;

    for (const tf of SERVER_CANDLE_TFS) {
      const tfMs = TF_MS[tf];
      const state = this.ensure(norm, tfMs);
      const bucket = floorBucket(tsMs, tfMs);

      if (state.open === null) {
        this.openBucket(state, norm, tf, bucket, price, tsMs, volume);
        this.parityRecord(norm, tf);
        continue;
      }

      if (bucket === state.open.start) {
        this.updateOpen(state.open, price, tsMs, volume);
        this.parityRecord(norm, tf);
        continue;
      }

      if (bucket > state.open.start) {
        // Bucket boundary crossed — close current, open new
        this.closeBucket(state, norm, tf);
        this.openBucket(state, norm, tf, bucket, price, tsMs, volume);
        this.parityRecord(norm, tf);
        continue;
      }

      // Late tick: bucket < open.start — possible reorder. Only adjust the
      // just-closed bucket when the tick is genuinely recent on the broker
      // clock (same REORDER_MS recency rule the client's adjustClosedRow
      // uses) — ancient packets are dropped as non-factual.
      if (state.closed.length > 0) {
        const last = state.closed[state.closed.length - 1];
        if (last.timestamp === bucket && this.latestTsMs - tsMs <= REORDER_MS) {
          this.adjustClosed(last, price, tsMs, volume);
          this.parityRecord(norm, tf);
          this.closedHandler?.({ ...last });
        }
      }
    }
  }

  // ── Timeframe resolution (server-side authoritative PO grid) ──
  /** True when the label resolves onto the server's PO multi-resolution grid. */
  isSupportedTimeframe(label: string): boolean {
    return this.canonicalTimeframe(label) !== null;
  }

  /** Canonical PO grid label for a requested timeframe (alias-aware). */
  canonicalTimeframe(label: string): AggregatedTimeframe | null {
    const raw = (label || "").trim();
    if (!raw) return null;
    // 1. Exact PO canonical code (case-insensitive): "S5", "m1", "H1" …
    const upper = raw.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(TF_MS, upper)) {
      return upper as AggregatedTimeframe;
    }
    // 2. Legacy shorthand alias: "5s", "1m", "1h" …
    return TF_ALIASES[raw.toLowerCase()] ?? null;
  }

  // ── History replay (on socket subscribe) ──
  /**
   * Authoritative CLOSED candles for EXACTLY ONE (symbol, timeframe) — the
   * resolution the subscribing client requested. Returns null when either the
   * symbol has no such bucket yet or the timeframe is off-grid.
   */
  getClosedHistory(
    symbol: string,
    timeframe: string,
  ): ServerClosedCandle[] | null {
    // Canonical key ONLY: the ingest path (addTick) keys buckets on
    // canonicalizeSymbol, so a raw "EUR-USD"/"EURUSD" lookup would miss the
    // bucket that actually holds the bars — the exact "chart is empty after
    // switching pair" failure.
    const norm = canonicalizeSymbol(symbol);
    const tf = this.canonicalTimeframe(timeframe);
    if (!norm || !tf) return null;

    const state = this.states.get(norm)?.get(TF_MS[tf]);
    if (!state || state.closed.length === 0) return null;
    return state.closed;
  }

  // ── BOOT BACKFILL FROM PERSISTED HISTORY ────────────────────────────────
  /**
   * Seed one (symbol, timeframe) closed array from rolled-up persisted bars.
   *
   * SEAM DISCIPLINE — this only ever writes the `closed` array, never `open`.
   * The bucket that is currently forming stays empty, so the first live tick
   * after a restart opens its own bucket exactly as it would have without a
   * backfill. `mergeSealedHistory` additionally collapses any timestamp that is
   * already present, and `closeBucket` now REPLACES a same-timestamp tail rather
   * than appending, so the persisted last minute and the first live-close can
   * never both end up in the series as two bars for one time window.
   */
  private mergeSealedHistory(
    symbol: string,
    tf: AggregatedTimeframe,
    tfMs: number,
    bars: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>,
  ): number {
    if (bars.length === 0) return 0;
    const state = this.ensure(symbol, tfMs);
    const byTs = new Map<number, ServerClosedCandle>();
    for (const c of state.closed) byTs.set(c.timestamp, c);
    for (const b of bars) {
      const existing = byTs.get(b.timestamp);
      // A live bar already sealed for this bucket WINS: it is the same minute
      // observed by this process, so it is at least as complete as the persisted
      // row and must not be overwritten by an older snapshot of itself.
      if (existing) {
        existing.high = Math.max(existing.high, b.high);
        existing.low = Math.min(existing.low, b.low);
        if (b.close !== existing.close) existing.close = b.close;
        continue;
      }
      byTs.set(b.timestamp, {
        symbol,
        timeframe: tf,
        timestamp: b.timestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume > 0 ? b.volume : 0,
        closed: true,
        // Persisted minutes are sealed by definition — same immutability
        // contract as a live close, which is what the client's merge keys on.
        isFinal: true,
      });
    }
    const merged = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
    state.closed = merged.slice(Math.max(0, merged.length - MAX_CLOSED_PER_TF));
    return bars.length;
  }

  /**
   * Backfill ONE symbol from persisted 1m history, across every timeframe the
   * store can honestly support. Same path for OTC, REAL and CRYPTO — there is no
   * per-asset-type branch anywhere in here; the only thing that varies is which
   * rows exist for the symbol, which is a fact about the feed, not the code.
   */
  public async backfillSymbolFromHistory(
    symbol: string,
    load: PersistedBarLoader,
    limit = BACKFILL_1M_BAR_LIMIT,
  ): Promise<{ symbol: string; barsLoaded: number; byTimeframe: Record<string, number> }> {
    const norm = canonicalizeSymbol(symbol);
    const empty = { symbol: norm, barsLoaded: 0, byTimeframe: {} as Record<string, number> };
    if (!norm) return empty;

    let bars: PersistedMinuteBar[];
    try {
      bars = await load(norm, limit);
    } catch (err) {
      logger.warn("[CandleAggregator] history backfill read failed", {
        symbol: norm,
        error: err instanceof Error ? err.message : String(err),
      });
      return empty;
    }
    if (!Array.isArray(bars) || bars.length === 0) return empty;

    const byTimeframe: Record<string, number> = {};
    for (const tf of SERVER_CANDLE_TFS) {
      const tfMs = TF_MS[tf];
      const rolled = aggregatePersistedBars(bars, tfMs);
      if (rolled === null) continue; // sub-minute: not derivable, skip honestly
      const seeded = this.mergeSealedHistory(norm, tf, tfMs, rolled);
      if (seeded > 0) byTimeframe[tf] = seeded;
    }
    return { symbol: norm, barsLoaded: bars.length, byTimeframe };
  }

  /**
   * Backfill the WHOLE universe in one pass. `symbols` is the full instrument
   * list (OTC + REAL + CRYPTO) supplied by the caller; each is read through the
   * identical path above. Failures are per-symbol and never abort the pass.
   */
  public async backfillAllFromHistory(
    symbols: string[],
    load: PersistedBarLoader,
    limit = BACKFILL_1M_BAR_LIMIT,
  ): Promise<{ symbols: number; seeded: number; byTimeframe: Record<string, number> }> {
    const merged: Record<string, number> = {};
    let seeded = 0;
    for (const symbol of symbols) {
      const res = await this.backfillSymbolFromHistory(symbol, load, limit);
      if (res.barsLoaded === 0) continue;
      seeded += 1;
      for (const [tf, n] of Object.entries(res.byTimeframe)) {
        merged[tf] = (merged[tf] ?? 0) + n;
      }
    }
    logger.info("[CandleAggregator] persisted-history backfill complete", {
      symbols_seeded: seeded,
      bars_by_timeframe: merged,
    });
    return { symbols: symbols.length, seeded, byTimeframe: merged };
  }

  // ── Wall-clock sweep: close stale open buckets ──
  private sweep(): void {
    if (this.latestTsMs <= 0) return;
    const now = Date.now() + this.clockOffsetMs;

    for (const [symbol, byTf] of this.states) {
      for (const [tfMs, state] of byTf) {
        if (state.open === null) continue;
        const bucketEnd = state.open.start + tfMs;
        if (now >= bucketEnd + REORDER_MS) {
          const label = TF_LABELS[tfMs] ?? String(tfMs);
          const tf = label as AggregatedTimeframe;
          this.closeBucket(state, symbol, tf);
          this.parityRecord(symbol, tf);
        }
      }
    }

    // CANDLE PARITY ASSERTION: any symbol receiving raw ticks while its bucket
    // rings do not advance for PARITY_BREACH_CYCLES sweeps is flat-lining — log
    // + broadcast so the breakdown surfaces instead of rendering silently dead.
    this.assertParity();
  }

  // ── Internal helpers ──

  private getSymbolParity(norm: string): SymbolParity {
    let p = this.parity.get(norm);
    if (!p) {
      p = {
        norm,
        ticks: 0,
        writes: 0,
        byTf: new Map(),
        seenTicks: 0,
        seenWrites: 0,
        seenByTf: new Map(),
        zeroCycles: 0,
        zeroByTf: new Map(),
        lastFlagAt: 0,
        lastFlagByTf: new Map(),
      };
      this.parity.set(norm, p);
    }
    return p;
  }

  private parityRecord(norm: string, tf: AggregatedTimeframe): void {
    const p = this.getSymbolParity(norm);
    p.writes += 1;
    if (TF_MS[tf] <= PARITY_TRACK_MAX_MS) {
      p.byTf.set(tf, (p.byTf.get(tf) ?? 0) + 1);
    }
  }

  private assertParity(): void {
    const now = Date.now();
    for (const p of this.parity.values()) {
      const tickDelta = p.ticks - p.seenTicks;
      const writeDelta = p.writes - p.seenWrites;

      p.zeroCycles = tickDelta > 0 && writeDelta === 0 ? p.zeroCycles + 1 : 0;
      if (
        p.zeroCycles >= PARITY_BREACH_CYCLES &&
        now - p.lastFlagAt >= PARITY_FLAG_COOLDOWN_MS
      ) {
        p.lastFlagAt = now;
        this.parityHandler?.({
          symbol: p.norm,
          timeframe: null,
          ticks: p.ticks,
          writes: p.writes,
          tickDelta,
          writeDelta,
        });
      }
      p.seenTicks = p.ticks;
      p.seenWrites = p.writes;

      for (const [tf, writes] of p.byTf) {
        const seen = p.seenByTf.get(tf) ?? 0;
        const wd = writes - seen;
        const next =
          tickDelta > 0 && wd === 0 ? (p.zeroByTf.get(tf) ?? 0) + 1 : 0;
        p.zeroByTf.set(tf, next);
        p.seenByTf.set(tf, writes);
        if (
          next >= PARITY_BREACH_CYCLES &&
          now - (p.lastFlagByTf.get(tf) ?? 0) >= PARITY_FLAG_COOLDOWN_MS
        ) {
          p.lastFlagByTf.set(tf, now);
          this.parityHandler?.({
            symbol: p.norm,
            timeframe: tf,
            ticks: p.ticks,
            writes,
            tickDelta,
            writeDelta: wd,
          });
        }
      }
    }
  }

  // ── Diagnostic surface (REST / tests / observability) ──
  getParityTelemetry(): Record<string, CandleParityTelemetry> {
    const out: Record<string, CandleParityTelemetry> = {};
    for (const p of this.parity.values()) {
      out[p.norm] = {
        symbol: p.norm,
        ticks: p.ticks,
        writes: p.writes,
        byTf: Object.fromEntries(p.byTf),
      };
    }
    return out;
  }

  resetParityTelemetry(): void {
    this.parity.clear();
  }

  private ensure(symbol: string, tfMs: number): TfState {
    let byTf = this.states.get(symbol);
    if (!byTf) {
      byTf = new Map();
      this.states.set(symbol, byTf);
    }
    let state = byTf.get(tfMs);
    if (!state) {
      state = { open: null, closed: [] };
      byTf.set(tfMs, state);
    }
    return state;
  }

  private openBucket(
    state: TfState,
    _symbol: string,
    _tf: AggregatedTimeframe,
    start: number,
    price: number,
    tsMs: number,
    volume: number,
  ): void {
    state.open = {
      start,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volume > 0 ? volume : 0,
      tickCount: 1,
      lastTickMs: tsMs,
    };
  }

  private updateOpen(
    bucket: Bucket,
    price: number,
    tsMs: number,
    volume: number,
  ): void {
    bucket.high = Math.max(bucket.high, price);
    bucket.low = Math.min(bucket.low, price);
    bucket.close = price;
    bucket.volume += volume > 0 ? volume : 0;
    bucket.tickCount += 1;
    bucket.lastTickMs = tsMs;
  }

  private adjustClosed(
    candle: ServerClosedCandle,
    price: number,
    tsMs: number,
    volume: number,
  ): void {
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
    candle.close = price;
    candle.volume += volume > 0 ? volume : 0;
  }

  private closeBucket(
    state: TfState,
    symbol: string,
    tf: AggregatedTimeframe,
  ): void {
    const b = state.open;
    if (!b) return;

    const candle: ServerClosedCandle = {
      symbol,
      timeframe: tf,
      timestamp: b.start,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume > 0 ? b.volume : b.tickCount, // tickCount as volume when all zeros
      closed: true,
      isFinal: true,
    };

    // SEAM GUARD (PART 32.3 [249]) — a boot backfill can already hold a sealed
    // bar for this exact bucket when the restart happened mid-minute: the
    // collector persisted the forming bucket, then the process died before it
    // closed. Appending here would leave TWO bars for one time window, which is
    // precisely the "duplicate/gap at the seam" failure. Merge into the existing
    // tail instead — the live observations are the fresher half of the same
    // minute, so they extend the persisted bar rather than duplicating it.
    const tail = state.closed.length > 0 ? state.closed[state.closed.length - 1] : null;
    if (tail && tail.timestamp === b.start) {
      tail.high = Math.max(tail.high, b.high);
      tail.low = Math.min(tail.low, b.low);
      tail.close = b.close;
      tail.volume = b.volume > 0 ? tail.volume + b.volume : tail.volume;
      state.open = null;
      return;
    }

    state.closed.push(candle);
    if (state.closed.length > MAX_CLOSED_PER_TF) {
      state.closed.splice(0, state.closed.length - MAX_CLOSED_PER_TF);
    }
    state.open = null;

    // Broadcast to subscribed clients via the registered handler
    try {
      this.closedHandler?.(candle);
    } catch (err) {
      logger.debug("[CandleAggregator] closedHandler error", {
        symbol,
        tf,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const realtimeCandleAggregatorService =
  RealtimeCandleAggregatorService.getInstance();
