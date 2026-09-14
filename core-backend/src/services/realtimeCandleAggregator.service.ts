import { logger } from "../utils/logger";
import { canonicalizeSymbol } from "../utils/symbolFormat";

// ── Aggregated timeframes — the multi-resolution bucket grid ──
// The server computes this dynamic ladder for every live symbol and emits each
// close to EXACTLY the (symbol, timeframe) channel a client subscribed to, so a
// 10s (M10) client never sees 1h frames and vice versa. Sub-minute custom
// intervals (10s / 11s / 20s / 30s) are PO-parity bucket widths on the broker
// clock grid; higher standard frames (1m → 10d) form the settled chart ladder.
export type AggregatedTimeframe =
  | "1s"
  | "5s"
  | "10s"
  | "11s"
  | "20s"
  | "30s"
  | "1m"
  | "2m"
  | "3m"
  | "5m"
  | "10m"
  | "15m"
  | "20m"
  | "25m"
  | "30m"
  | "35m+"
  | "1h"
  | "4h"
  | "1d"
  | "2d"
  | "3d"
  | "5d"
  | "10d";

export const SERVER_CANDLE_TFS: AggregatedTimeframe[] = [
  "1s",
  "5s",
  "10s",
  "11s",
  "20s",
  "30s",
  "1m",
  "2m",
  "3m",
  "5m",
  "10m",
  "15m",
  "20m",
  "25m",
  "30m",
  "35m+",
  "1h",
  "4h",
  "1d",
  "2d",
  "3d",
  "5d",
  "10d",
];

const TF_MS: Record<AggregatedTimeframe, number> = {
  "1s": 1_000,
  "5s": 5_000,
  "10s": 10_000,
  "11s": 11_000,
  "20s": 20_000,
  "30s": 30_000,
  "1m": 60_000,
  "2m": 120_000,
  "3m": 180_000,
  "5m": 300_000,
  "10m": 600_000,
  "15m": 900_000,
  "20m": 1_200_000,
  "25m": 1_500_000,
  "30m": 1_800_000,
  "35m+": 2_100_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "2d": 172_800_000,
  "3d": 259_200_000,
  "5d": 432_000_000,
  "10d": 864_000_000,
};

const TF_LABELS: Record<number, string> = Object.fromEntries(
  Object.entries(TF_MS).map(([label, ms]) => [ms, label]),
);

const REORDER_MS = 2_000;
const SWEEP_INTERVAL_MS = 1_000;
const MAX_CLOSED_PER_TF = 512;
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

export class RealtimeCandleAggregatorService {
  private static instance: RealtimeCandleAggregatorService;

  private readonly states = new Map<
    string,
    Map<number /*tfMs*/, TfState>
  >();
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
        if (
          last.timestamp === bucket &&
          this.latestTsMs - tsMs <= REORDER_MS
        ) {
          this.adjustClosed(last, price, tsMs, volume);
          this.parityRecord(norm, tf);
          this.closedHandler?.({ ...last });
        }
      }
    }
  }

  // ── Timeframe resolution (server-side authoritative grid) ──
  /** True when the label is part of the server's multi-resolution grid. */
  isSupportedTimeframe(label: string): boolean {
    return Object.prototype.hasOwnProperty.call(
      TF_MS,
      (label || "").trim().toLowerCase(),
    );
  }

  /** Canonical grid label for a requested timeframe (alias-aware). */
  canonicalTimeframe(label: string): AggregatedTimeframe | null {
    const raw = (label || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(TF_MS, raw)) {
      return raw as AggregatedTimeframe;
    }
    if (raw === "35m") return "35m+";
    return null;
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
    const norm = (symbol || "").trim().toUpperCase();
    const tf = this.canonicalTimeframe(timeframe);
    if (!norm || !tf) return null;

    const state = this.states.get(norm)?.get(TF_MS[tf]);
    if (!state || state.closed.length === 0) return null;
    return state.closed;
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
        const next = tickDelta > 0 && wd === 0 ? (p.zeroByTf.get(tf) ?? 0) + 1 : 0;
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
    };

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
