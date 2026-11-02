/**
 * marketSnapshot.service.ts - COALESCED REAL-TIME MARKET SNAPSHOTS
 *
 * Writes the newest REAL tick + closed-candle state for every active symbol
 * into Redis without blocking the synchronous tick hot path. Multiple ticks
 * that arrive inside one flush window collapse to a single write carrying the
 * latest bid/ask/spread/volume/timestamp metrics.
 */

import { logger } from "../utils/logger";
import { CacheService } from "./cache.service";

const TICK_KEY_PREFIX = "otc_forex_market_tick:";
const CANDLE_KEY_PREFIX = "otc_forex_market_candle:";
const TICK_TTL_SECONDS = 180;
const CANDLE_TTL_SECONDS = 900;
const DEFAULT_FLUSH_MS = 250;

export interface MarketTickSnapshotInput {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  volume?: number;
  tsMs?: number;
  source: string;
  assetType?: string;
}

export interface MarketTickSnapshot {
  symbol: string;
  price: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  volume: number | null;
  volumeTotal: number;
  tickCount: number;
  tickRate: number;
  source: string;
  assetType: string | null;
  tsMs: number;
  updatedAt: string;
}

export interface MarketCandleSnapshotInput {
  symbol: string;
  timeframe: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  closed?: boolean;
  assetType?: string;
}

export interface MarketCandleSnapshot {
  symbol: string;
  timeframe: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
  isFinal: boolean;
  assetType: string | null;
  updatedAt: string;
}

export interface MarketSnapshotMetrics {
  tickSymbols: number;
  candleSeries: number;
  pendingTickWrites: number;
  pendingCandleWrites: number;
  flushCount: number;
  writeCount: number;
  errorCount: number;
  lastFlushAt: string | null;
  lastErrorAt: string | null;
}

type SnapshotWriter = (
  key: string,
  value: unknown,
  ttlSeconds: number,
) => Promise<void>;

export const marketTickKey = (symbol: string): string =>
  `${TICK_KEY_PREFIX}${symbol.trim().toUpperCase()}`;

export const marketCandleKey = (symbol: string, timeframe: string): string =>
  `${CANDLE_KEY_PREFIX}${symbol.trim().toUpperCase()}:${timeframe
    .trim()
    .toUpperCase()}`;

const defaultWriter: SnapshotWriter = async (key, value, ttlSeconds) => {
  await CacheService.getInstance().set(key, value, ttlSeconds);
};

const finitePositive = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const finiteNonNegative = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export class MarketSnapshotService {
  private readonly tickSnapshots = new Map<string, MarketTickSnapshot>();
  private readonly candleSnapshots = new Map<string, MarketCandleSnapshot>();
  private readonly dirtyTicks = new Set<string>();
  private readonly dirtyCandles = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private flushCount = 0;
  private writeCount = 0;
  private errorCount = 0;
  private lastFlushAt: string | null = null;
  private lastErrorAt: string | null = null;

  constructor(
    private readonly writer: SnapshotWriter = defaultWriter,
    private readonly flushMs: number = DEFAULT_FLUSH_MS,
  ) {}

  public recordTick(input: MarketTickSnapshotInput): void {
    const symbol = (input.symbol || "").trim().toUpperCase();
    const price = finitePositive(input.price);
    if (!symbol || price === null) return;

    const tsMs =
      Number.isFinite(input.tsMs) && (input.tsMs as number) > 0
        ? (input.tsMs as number)
        : Date.now();
    const previous = this.tickSnapshots.get(symbol);

    let bid = finitePositive(input.bid);
    let ask = finitePositive(input.ask);
    if (bid === null || ask === null || ask < bid) {
      if (bid !== null && ask !== null) {
        bid = null;
        ask = null;
      }
    }

    const volume = finiteNonNegative(input.volume);
    const tickCount = (previous?.tickCount ?? 0) + 1;
    const volumeTotal = (previous?.volumeTotal ?? 0) + (volume ?? 0);

    let tickRate = previous?.tickRate ?? 0;
    if (previous) {
      const deltaMs = tsMs - previous.tsMs;
      if (deltaMs > 0 && deltaMs <= 10_000) {
        const instantRate = 1_000 / deltaMs;
        tickRate =
          tickRate > 0 ? tickRate * 0.8 + instantRate * 0.2 : instantRate;
      }
    }

    const snapshot: MarketTickSnapshot = {
      symbol,
      price,
      bid,
      ask,
      spread: bid !== null && ask !== null && ask >= bid ? ask - bid : null,
      volume,
      volumeTotal,
      tickCount,
      tickRate: Number(tickRate.toFixed(3)),
      source: input.source || "unknown",
      assetType: input.assetType ?? previous?.assetType ?? null,
      tsMs,
      updatedAt: new Date().toISOString(),
    };

    this.tickSnapshots.set(symbol, snapshot);
    this.dirtyTicks.add(symbol);
    this.schedule();
  }

  public recordCandle(input: MarketCandleSnapshotInput): void {
    const symbol = (input.symbol || "").trim().toUpperCase();
    const timeframe = (input.timeframe || "").trim().toUpperCase();
    const open = finitePositive(input.open);
    const high = finitePositive(input.high);
    const low = finitePositive(input.low);
    const close = finitePositive(input.close);
    const timestamp =
      Number.isFinite(input.timestamp) && input.timestamp > 0
        ? input.timestamp
        : null;
    if (
      !symbol ||
      !timeframe ||
      timestamp === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      high < low
    ) {
      return;
    }

    const snapshot: MarketCandleSnapshot = {
      symbol,
      timeframe,
      timestamp,
      open,
      high,
      low,
      close,
      volume: finiteNonNegative(input.volume) ?? 0,
      closed: input.closed === true,
      isFinal: input.closed === true,
      assetType: input.assetType ?? null,
      updatedAt: new Date().toISOString(),
    };

    const key = `${symbol}:${timeframe}`;
    this.candleSnapshots.set(key, snapshot);
    this.dirtyCandles.add(key);
    this.schedule();
  }

  public getTickSnapshot(symbol: string): MarketTickSnapshot | undefined {
    return this.tickSnapshots.get((symbol || "").trim().toUpperCase());
  }

  public getCandleSnapshot(
    symbol: string,
    timeframe: string,
  ): MarketCandleSnapshot | undefined {
    return this.candleSnapshots.get(
      `${(symbol || "").trim().toUpperCase()}:${timeframe
        .trim()
        .toUpperCase()}`,
    );
  }

  public getMetrics(): MarketSnapshotMetrics {
    return {
      tickSymbols: this.tickSnapshots.size,
      candleSeries: this.candleSnapshots.size,
      pendingTickWrites: this.dirtyTicks.size,
      pendingCandleWrites: this.dirtyCandles.size,
      flushCount: this.flushCount,
      writeCount: this.writeCount,
      errorCount: this.errorCount,
      lastFlushAt: this.lastFlushAt,
      lastErrorAt: this.lastErrorAt,
    };
  }

  public clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tickSnapshots.clear();
    this.candleSnapshots.clear();
    this.dirtyTicks.clear();
    this.dirtyCandles.clear();
  }

  public async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private schedule(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      return;
    }
    this.flushing = this.flushBatch();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
      if (this.dirtyTicks.size > 0 || this.dirtyCandles.size > 0) {
        this.schedule();
      }
    }
  }

  private async flushBatch(): Promise<void> {
    const tickSymbols = Array.from(this.dirtyTicks);
    const candleKeys = Array.from(this.dirtyCandles);
    this.dirtyTicks.clear();
    this.dirtyCandles.clear();
    if (tickSymbols.length === 0 && candleKeys.length === 0) return;

    const writes: Array<{
      key: string;
      value: unknown;
      ttlSeconds: number;
    }> = [];
    for (const symbol of tickSymbols) {
      const snapshot = this.tickSnapshots.get(symbol);
      if (snapshot) {
        writes.push({
          key: marketTickKey(symbol),
          value: snapshot,
          ttlSeconds: TICK_TTL_SECONDS,
        });
      }
    }
    for (const key of candleKeys) {
      const snapshot = this.candleSnapshots.get(key);
      if (snapshot) {
        writes.push({
          key: marketCandleKey(snapshot.symbol, snapshot.timeframe),
          value: snapshot,
          ttlSeconds: CANDLE_TTL_SECONDS,
        });
      }
    }

    const results = await Promise.allSettled(
      writes.map((write) =>
        this.writer(write.key, write.value, write.ttlSeconds),
      ),
    );
    let failed = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        this.writeCount += 1;
      } else {
        failed += 1;
        const write = writes[i];
        if (write.key.startsWith(TICK_KEY_PREFIX)) {
          this.dirtyTicks.add(write.key.slice(TICK_KEY_PREFIX.length));
        } else {
          this.dirtyCandles.add(
            write.key.slice(CANDLE_KEY_PREFIX.length),
          );
        }
      }
    }

    this.flushCount += 1;
    this.lastFlushAt = new Date().toISOString();
    if (failed > 0) {
      this.errorCount += failed;
      this.lastErrorAt = this.lastFlushAt;
      logger.debug("[MarketSnapshot] Redis snapshot batch had failures", {
        failed,
        written: writes.length - failed,
      });
    }
  }
}

export const marketSnapshotService = new MarketSnapshotService();
export default marketSnapshotService;
