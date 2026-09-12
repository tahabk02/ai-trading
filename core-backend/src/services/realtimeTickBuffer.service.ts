/**
 * realtimeTickBuffer.service.ts — STRICT REAL-TICK PRICE RING BUFFER
 *
 * 100% REAL DATA. ZERO SYNTHETIC FALLBACKS.
 *
 * A bounded, per-symbol ring of the most recent GENUINE live market ticks
 * observed by the tick ingestion engine. Every entry is a real price from a
 * real external feed — nothing is ever invented here.
 *
 * HIGH-FREQUENCY MICRO-FEATURES:
 *   In addition to the raw tick-price ring, this buffer computes and exposes
 *   the high-frequency micro-features required by the pure real-time AI
 *   pipeline (1m/5m):
 *
 *     • tickVelocity       — tokens-per-second rate of price change over the
 *                            trailing window (real price deltas / real time).
 *     • microMomentum      — signed impulse of the last N price deltas,
 *                            normalized to a [-1, 1] strength.
 *     • bidAskPressure     — signed spread-pressure proxy from real
 *                            bid/ask arms (buy-side dominance vs sell).
 *     • priceActionDelta   — immediate last bar's net delta (close-vs-open
 *                            displacement) computed from real ticks.
 *     • microDeltas        — array of consecutive real price deltas.
 *
 * These are derived STRICTLY from observed real prices and real timestamps —
 * there is zero fabrication, zero random walk, zero simulation noise.
 */

import { logger } from "../utils/logger";

// 10-BOOK WINDOW PRESERVATION — the ring must comfortably hold the live-quant
// scorer's full window (≥2 min of a 1Hz tape) so a strong momentum run never
// prunes the very bars that let the multiplicative confluence cross 96.5%.
// Deep ring = no dropped queue payloads at live cadence.
const MAX_TICKS_PER_SYMBOL = 2000;

/** Per-tick micro feature snapshot built from real observed ticks. */
export interface MicroTickFeatures {
  /** Tokens/second rate of price change over the trailing window. */
  tickVelocity: number;
  /** Signed impulse [-1, 1] of the last N price deltas. */
  microMomentum: number;
  /** Signed spread pressure [-1, 1]; +1 = heavy buy pressure. */
  bidAskPressure: number;
  /** Immediate last-bar displacement (close-vs-first) as signed fraction. */
  priceActionDelta: number;
  /** Array of the most recent real price deltas (tick-to-tick). */
  microDeltas: number[];
  /** Latest real observed price. */
  latestPrice: number;
  /** ISO timestamp of the newest tick. */
  lastTickAt: string;
  /** Acceleration of tick velocity — positive = momentum increasing. */
  tickVelocityAcceleration: number;
  /** Order flow imbalance: ratio of upward vs downward tick volumes. */
  orderFlowImbalance: number;
}

/** Internal per-symbol state: prices + their arrival timestamps (ms). */
interface TickEntry {
  price: number;
  tsMs: number;
  bid?: number;
  ask?: number;
}

/**
 * FIXED-SIZE O(1) CIRCULAR RING per symbol.
 *
 * The old implementation stored a plain array and pruned with
 * `arr.splice(0, arr.length - MAX)` on every push at cap — an O(n) front-shift
 * exactly when a hot symbol is loudest (100+ ticks/s), burning CPU that the
 * broadcast + feature path needs. This ring overwrites by index in constant
 * time: append never reallocates and never shifts; reads materialise an
 * ordered copy on demand (bounded to what the reader actually needs).
 * Oldest-entry eviction is preserved exactly as before — at cap a new push
 * overwrites the oldest slot and advances the head.
 */
class TickRing {
  private readonly buf: TickEntry[];
  private start = 0;
  private len = 0;

  constructor(size: number) {
    this.buf = new Array<TickEntry>(size);
  }

  /** Append one entry — O(1); evicts the oldest when full. */
  public push(entry: TickEntry): void {
    const idx = (this.start + this.len) % this.buf.length;
    this.buf[idx] = entry;
    if (this.len < this.buf.length) {
      this.len += 1;
    } else {
      this.start = (this.start + 1) % this.buf.length;
    }
  }

  /** Number of real entries held (0..size). */
  public get length(): number {
    return this.len;
  }

  /** The freshest entry, or undefined when empty. */
  public latest(): TickEntry | undefined {
    if (this.len === 0) return undefined;
    return this.buf[(this.start + this.len - 1) % this.buf.length];
  }

  /** Ordered (oldest → newest) copy of the trailing `maxCount` entries. */
  public tail(maxCount?: number): TickEntry[] {
    const n = maxCount != null ? Math.min(maxCount, this.len) : this.len;
    const out = new Array<TickEntry>(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[(this.start + this.len - n + i) % this.buf.length];
    }
    return out;
  }
}

class RealtimeTickBufferService {
  private static instance: RealtimeTickBufferService;
  /** Per-symbol circular ring of the most recent REAL tick prices —— O(1)
   *  append + eviction, the 2000-tick cap enforced by fixed allocation. */
  private ticks: Map<string, TickRing> = new Map();
  /** Per-symbol last tick ISO timestamp (for staleness diagnostics). */
  private lastTickAt: Map<string, string> = new Map();
  /**
   * Per-symbol LAST KNOWN GENUINE bid/ask arms (from any past tick). The
   * microstructure (Aldridge queue) payload must NEVER be dropped just because
   * the freshest print arrived without arms — a PO mid print between two real
   * quote ticks used to wipe the live book from getLatestSpread(), freezing the
   * queue factor at zero. This cache retains the most recent REAL spread so the
   * live-quant forwarder always sees a live book when one has been observed.
   */
  private lastKnownArms: Map<string, { bid?: number; ask?: number }> = new Map();

  private constructor() {}

  public static getInstance(): RealtimeTickBufferService {
    if (!RealtimeTickBufferService.instance) {
      RealtimeTickBufferService.instance = new RealtimeTickBufferService();
    }
    return RealtimeTickBufferService.instance;
  }

  /**
   * Append a REAL observed tick price (non-fatal: never throws).
   * Only finite positive prices are accepted; everything else is real-data
   * rejection, not a data transformation.
   */
  public append(
    symbol: string,
    price: number,
    opts?: { tsMs?: number; bid?: number; ask?: number },
  ): void {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm || !Number.isFinite(price) || price <= 0) return;

    const now = opts?.tsMs ?? Date.now();
    let ring = this.ticks.get(norm) ?? new TickRing(MAX_TICKS_PER_SYMBOL);
    ring.push({
      price,
      tsMs: now,
      bid: opts?.bid,
      ask: opts?.ask,
    });
    this.ticks.set(norm, ring);
    this.lastTickAt.set(norm, new Date(now).toISOString());

    // ── LAST-KNOWN-ARMS CACHE (never drop a genuine book payload) ──
    // Only genuine quoted arms are retained (ask > bid, both finite positive).
    // A quoted-spread tick updates the cache so a subsequent arm-less print
    // still exposes the most recent REAL book to the live-quant pipeline.
    const bid = opts?.bid;
    const ask = opts?.ask;
    if (
      bid != null && ask != null &&
      Number.isFinite(bid) && Number.isFinite(ask) &&
      ask > bid && bid > 0
    ) {
      this.lastKnownArms.set(norm, { bid, ask });
    }
  }

  /**
   * Read the trailing real tick prices for a symbol (copy, newest last).
   * Returns [] when no genuine ticks have been observed yet.
   */
  public getRecentPrices(symbol: string, maxCount = MAX_TICKS_PER_SYMBOL): number[] {
    const norm = (symbol || "").trim().toUpperCase();
    const ring = this.ticks.get(norm);
    if (!ring || ring.length === 0) return [];
    return ring.tail(Math.max(2, maxCount)).map((t) => t.price);
  }

  /**
   * The most recent REAL bid/ask arms for a symbol.
   *
   * PREFERS the freshest tick's own arms; when the freshest print is an
   * arm-less mid tick, falls back to the LAST KNOWN GENUINE spread (the
   * microstructure queue payload must survive a mid-tick gap — dropping it
   * between quote prints is what froze the live book at zero).
   */
  public getLatestSpread(symbol: string): { bid?: number; ask?: number } {
    const norm = (symbol || "").trim().toUpperCase();
    const ring = this.ticks.get(norm);
    if (!ring || ring.length === 0) return this.lastKnownArms.get(norm) ?? {};
    const last = ring.latest();
    if (!last) return this.lastKnownArms.get(norm) ?? {};
    if (
      last.bid != null && last.ask != null &&
      Number.isFinite(last.bid) && Number.isFinite(last.ask) &&
      last.bid > 0 && last.ask > last.bid
    ) {
      return { bid: last.bid, ask: last.ask };
    }
    return this.lastKnownArms.get(norm) ?? {};
  }

  /**
   * Read the trailing REAL tick entries (price + tsMs + optional bid/ask,
   * copy, newest last) with their own timestamps — the exact window fed to
   * the live-quant `/tick-signal` scorer so momentum + queue factors run on
   * the real tape. Returns [] when no genuine ticks exist yet.
   */
  public getRecentWindow(
    symbol: string,
    maxCount = 60,
  ): Array<{ price: number; tsMs: number; bid?: number; ask?: number }> {
    const norm = (symbol || "").trim().toUpperCase();
    const ring = this.ticks.get(norm);
    if (!ring || ring.length === 0) return [];
    return ring.tail(Math.max(2, maxCount)).map((t) => ({
      price: t.price,
      tsMs: t.tsMs,
      bid: t.bid,
      ask: t.ask,
    }));
  }

  /** The freshest REAL observed tick price for a symbol, or undefined. */
  public getLatest(symbol: string): number | undefined {
    const norm = (symbol || "").trim().toUpperCase();
    const ring = this.ticks.get(norm);
    const last = ring?.latest();
    return last ? last.price : undefined;
  }

  /** ISO timestamp of the last genuine tick for a symbol, or undefined. */
  public getLastTickAt(symbol: string): string | undefined {
    return this.lastTickAt.get((symbol || "").trim().toUpperCase());
  }

  /**
   * The freshest REAL observed tick as { price, tsMs }, or undefined when no
   * genuine tick exists yet. `tsMs` is the tick's own (server-side or PO)
   * timestamp so freshness checks never measure against anything but the
   * real tape.
   */
  public getLatestEntry(symbol: string): { price: number; tsMs: number } | undefined {
    const norm = (symbol || "").trim().toUpperCase();
    const ring = this.ticks.get(norm);
    const last = ring?.latest();
    if (!last) return undefined;
    return { price: last.price, tsMs: last.tsMs };
  }

  /**
   * Age in milliseconds of the freshest real tick since its own timestamp,
   * or null when no genuine tick has been observed yet.
   */
  public getLatestAgeMs(symbol: string): number | null {
    const entry = this.getLatestEntry(symbol);
    return entry != null ? Math.max(0, Date.now() - entry.tsMs) : null;
  }

  /** Drop the buffer for one symbol (symbol switch hygiene). */
  public clearSymbol(symbol: string): void {
    const norm = (symbol || "").trim().toUpperCase();
    this.ticks.delete(norm);
    this.lastTickAt.delete(norm);
    this.lastKnownArms.delete(norm);
  }

  // ════════════════════════════════════════════════════════════════════
  //  HIGH-FREQUENCY MICRO-FEATURE ENGINE
  //  ── PURE REAL-TIME · ZERO SIMULATION NOISE ──
  // ════════════════════════════════════════════════════════════════════

  /**
   * Compute the high-frequency micro features for a symbol from the REAL
   * observed tick tape.
   *
   * All values are derived strictly from real prices and real timestamps.
   * If fewer than 2 real ticks exist, the returned features are neutral
   * (zeros) — there is NO fabrication on insufficient data.
   */
  public getMicroFeatures(
    symbol: string,
    opts?: {
      /** Number of trailing ticks to use for velocity/momentum. Default 60. */
      window?: number;
      /** Bid and ask arms for spread pressure, if known. */
      bid?: number;
      ask?: number;
    },
  ): MicroTickFeatures | null {
    const norm = (symbol || "").trim().toUpperCase();
    const ring = this.ticks.get(norm);
    if (!ring || ring.length < 2) {
      const latest = this.getLatest(norm);
      if (latest == null) return null;
      return {
        tickVelocity: 0,
        microMomentum: 0,
        bidAskPressure: 0,
        priceActionDelta: 0,
        microDeltas: [],
        latestPrice: latest,
        lastTickAt: this.lastTickAt.get(norm) ?? new Date().toISOString(),
        tickVelocityAcceleration: 0,
        orderFlowImbalance: 0,
      };
    }

    const window = Math.max(2, opts?.window ?? 60);
    const tail = ring.tail(window);

    // ── Tick velocity: (last price - first price) / elapsed real time ──
    const first = tail[0];
    const last = tail[tail.length - 1];
    const elapsedSec = Math.max((last.tsMs - first.tsMs) / 1000, 1e-9);
    const velocity = (last.price - first.price) / elapsedSec;

    // ── Micro momentum: signed impulse of consecutive deltas, in [-1, 1] ──
    const deltas: number[] = [];
    for (let i = 1; i < tail.length; i++) {
      deltas.push(tail[i].price - tail[i - 1].price);
    }
    const sumDeltas = deltas.reduce((a, b) => a + b, 0);
    const absDeltas = deltas.map(Math.abs).reduce((a, b) => a + b, 0);
    const microMomentum =
      absDeltas > 1e-12 ? sumDeltas / absDeltas : 0;

    // ── Bid-ask spread pressure (review proxy from real quoted arms) ──
    let bidAskPressure = 0;
    const lastEntry = tail[tail.length - 1];
    const effBid = opts?.bid ?? lastEntry.bid;
    const effAsk = opts?.ask ?? lastEntry.ask;
    if (effBid != null && effAsk != null) {
      const bid = effBid;
      const ask = effAsk;
      if (Number.isFinite(bid) && Number.isFinite(ask) && ask > bid) {
        const mid = (bid + ask) / 2;
        const halfSpread = (ask - bid) / 2;
        const positionFromMid = (last.price - mid) / halfSpread;
        bidAskPressure = Math.max(-1, Math.min(1, positionFromMid));
      }
    }

    // ── Immediate price-action delta (last bar displacement) ──
    const windowStart = tail[0].price;
    const priceActionDelta =
      Math.abs(windowStart) > 1e-12
        ? (last.price - windowStart) / Math.abs(windowStart)
        : 0;

    // ── Tick velocity acceleration: compare recent half vs older half velocity ──
    const midIdx = Math.max(1, Math.floor(tail.length / 2));
    const olderHalf = tail.slice(0, midIdx);
    const newerHalf = tail.slice(midIdx);
    let olderVelocity = 0;
    let newerVelocity = 0;
    if (olderHalf.length >= 2) {
      const olderElapsed = Math.max(
        (olderHalf[olderHalf.length - 1].tsMs - olderHalf[0].tsMs) / 1000,
        1e-9,
      );
      olderVelocity =
        (olderHalf[olderHalf.length - 1].price - olderHalf[0].price) / olderElapsed;
    }
    if (newerHalf.length >= 2) {
      const newerElapsed = Math.max(
        (newerHalf[newerHalf.length - 1].tsMs - newerHalf[0].tsMs) / 1000,
        1e-9,
      );
      newerVelocity =
        (newerHalf[newerHalf.length - 1].price - newerHalf[0].price) / newerElapsed;
    }
    const maxVelocity = Math.max(Math.abs(olderVelocity), Math.abs(newerVelocity), 1e-12);
    const tickVelocityAcceleration = Math.max(
      -1,
      Math.min(1, (newerVelocity - olderVelocity) / maxVelocity),
    );

    // ── Order flow imbalance: ratio of upward vs downward ticks ──
    let upTicks = 0;
    let downTicks = 0;
    let flatTicks = 0;
    for (const d of deltas) {
      if (d > 1e-15) upTicks++;
      else if (d < -1e-15) downTicks++;
      else flatTicks++;
    }
    const totalDirectional = upTicks + downTicks;
    const orderFlowImbalance =
      totalDirectional > 0
        ? Math.max(-1, Math.min(1, (upTicks - downTicks) / totalDirectional))
        : 0;

    return {
      tickVelocity: velocity,
      microMomentum,
      bidAskPressure,
      priceActionDelta,
      microDeltas: deltas,
      latestPrice: last.price,
      lastTickAt: this.lastTickAt.get(norm) ?? new Date().toISOString(),
      tickVelocityAcceleration,
      orderFlowImbalance,
    };
  }

  /**
   * Feed micro features into the PO snapshot path — pick the freshest
   * REAL observed price and optionally seed bid/ask if streamed.
   */
  public appendWithSpread(
    symbol: string,
    price: number,
    bid?: number,
    ask?: number,
  ): void {
    this.append(symbol, price, { bid, ask });
  }
}

export const realtimeTickBuffer = RealtimeTickBufferService.getInstance();
export default realtimeTickBuffer;
