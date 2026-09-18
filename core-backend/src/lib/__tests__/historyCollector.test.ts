/**
 * historyCollector.test.ts — 30-MINUTE HISTORICAL DATA LAYER (Alpha.5 Pro,
 * Part 3). Pure-helper math + collector flow + health proof, DB mocked.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findMany: vi.fn(),
  tickFindMany: vi.fn(),
  createMany: vi.fn(),
  count: vi.fn(),
  getRecentWindow: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    assetHistory = {
      upsert: mocks.upsert,
      findMany: mocks.findMany,
    };
    tickHistory = {
      createMany: mocks.createMany,
      count: mocks.count,
      findMany: mocks.tickFindMany,
    };
  },
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    getRecentWindow: mocks.getRecentWindow,
  },
}));

import {
  minuteBucket,
  buildMinuteBars,
  HistoryBar,
  historyCollector,
  HISTORY_WINDOW_MINUTES,
  HISTORY_BUCKET_MS,
} from "../../services/historyCollector.service";

const MIN = 60_000;

describe("minuteBucket", () => {
  it("floors any tsMs to its 1-minute boundary", () => {
    expect(minuteBucket(0)).toBe(0);
    expect(minuteBucket(59_999)).toBe(0);
    expect(minuteBucket(60_000)).toBe(60_000);
    expect(minuteBucket(119_999)).toBe(60_000);
    expect(minuteBucket(30 * MIN + 1234)).toBe(30 * MIN);
  });
});

describe("buildMinuteBars", () => {
  it("rolls a single bucket OHLC + tick count from real ticks", () => {
    const bars = buildMinuteBars([
      { price: 1.1, tsMs: 100 },
      { price: 1.05, tsMs: 1_000 },
      { price: 1.2, tsMs: 59_000 },
      { price: 1.12, tsMs: 59_999 },
    ]);
    expect(bars).toHaveLength(1);
    const [bar] = bars;
    expect(bar.bucket_start_ms).toBe(0);
    expect(bar.open).toBe(1.1);
    expect(bar.high).toBe(1.2);
    expect(bar.low).toBe(1.05);
    expect(bar.close).toBe(1.12);
    expect(bar.tick_count).toBe(4);
    expect(bar.volume).toBeNull();
  });

  it("splits ticks across minute buckets oldest-first", () => {
    const bars = buildMinuteBars([
      { price: 1.0, tsMs: 10 },
      { price: 2.0, tsMs: MIN + 10 },
      { price: 3.0, tsMs: 2 * MIN + 10 },
    ]);
    expect(bars.map((b: HistoryBar) => b.bucket_start_ms)).toEqual([0, MIN, 2 * MIN]);
    expect(bars.map((b: HistoryBar) => b.open)).toEqual([1.0, 2.0, 3.0]);
  });

  it("accumulates REAL volume only (null when tape carries none)", () => {
    const [bar] = buildMinuteBars([
      { price: 1.0, tsMs: 5, volume: 100 },
      { price: 1.1, tsMs: 10, volume: 50 },
      { price: 1.2, tsMs: 15 },
    ]);
    expect(bar.volume).toBe(150);
    expect(bar.tick_count).toBe(3);
  });

  it("rejects non-finite / non-positive prices (never fabricated)", () => {
    const bars = buildMinuteBars([
      { price: 1.0, tsMs: 5 },
      { price: NaN, tsMs: 10 },
      { price: -2, tsMs: 15 },
      { price: Infinity, tsMs: 20 },
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0].tick_count).toBe(1);
  });
});

describe("historyCollector.collectForSymbol", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.createMany.mockReset();
    mocks.tickFindMany.mockReset();
    mocks.tickFindMany.mockResolvedValue([]);
    mocks.createMany.mockResolvedValue({ count: 3 });
  });

  it("upserts minute buckets + persists ticks from the REAL window", async () => {
    const now = Date.now();
    const ticks = [
      { price: 1.0, tsMs: now - 10 * MIN },
      { price: 1.01, tsMs: now - 10 * MIN + 500 },
      { price: 1.02, tsMs: now - 9 * MIN },
    ];
    mocks.getRecentWindow.mockReturnValue(ticks);
    mocks.upsert.mockResolvedValue({ id: "x" });

    const res = await historyCollector.collectForSymbol("EURUSD", now);
    expect(res.bars).toBe(2);
    expect(res.ticksInserted).toBe(3);
    expect(res.barsFound).toBe(2);
    expect(res.ticksInWindow).toBe(3);

    // Minute-bucket upsert carries the real OHLC + tickCount.
    const firstUpsert = mocks.upsert.mock.calls[0][0];
    expect(firstUpsert.where.symbol_timeframe_bucketStartMs.bucketStartMs).toBe(
      BigInt(minuteBucket(now - 10 * MIN)),
    );
    expect(firstUpsert.create.close).toBe(1.01);
    expect(firstUpsert.create.tickCount).toBe(2);

    const createMany = mocks.createMany.mock.calls[0][0];
    expect(createMany.data).toHaveLength(3);
  });

  it("is idempotent: never re-inserts ticks already persisted", async () => {
    const now = Date.now();
    const tsA = now - 10 * MIN;
    const tsB = now - 9 * MIN;
    const ticks = [
      { price: 1.0, tsMs: tsA },
      { price: 1.02, tsMs: tsB },
    ];
    mocks.getRecentWindow.mockReturnValue(ticks);
    mocks.upsert.mockResolvedValue({ id: "x" });
    mocks.tickFindMany.mockResolvedValue([{ tsMs: BigInt(tsA) }]);
    mocks.createMany.mockResolvedValue({ count: 1 });

    const res = await historyCollector.collectForSymbol("EURUSD", now);
    expect(res.ticksInWindow).toBe(2);
    expect(res.ticksInserted).toBe(1); // only the tsB print is NEW
    const data = mocks.createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(1);
    expect(data[0].tsMs.toString()).toBe(String(tsB));
  });

  it("drops ticks older than the 30-minute window (ring keeps 2000)", async () => {
    const now = Date.now();
    const ticks = [
      { price: 1.0, tsMs: now - 31 * MIN },
      { price: 1.0, tsMs: now - 5 * MIN },
    ];
    mocks.getRecentWindow.mockReturnValue(ticks);
    const res = await historyCollector.collectForSymbol("GBPUSD", now);
    expect(res.ticksInWindow).toBe(1);
    expect(res.bars).toBe(1);
    expect(mocks.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("returns zeros for a symbol with no genuine ticks (honest empty)", async () => {
    mocks.getRecentWindow.mockReturnValue([]);
    const res = await historyCollector.collectForSymbol("XEMPTY", Date.now());
    expect(res).toEqual({ bars: 0, ticksInserted: 0, barsFound: 0, ticksInWindow: 0 });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.createMany).not.toHaveBeenCalled();
  });
});

describe("historyCollector.getHistoryHealth (window_complete)", () => {
  it("declares a full 30-minute window when 30 bars span 29+ minutes", async () => {
    const now = Date.now();
    const bars = Array.from({ length: 30 }, (_, i) => {
      const bucket = now - (29 - i) * MIN;
      return {
        bucketStartMs: BigInt(minuteBucket(bucket)),
        open: 1.0,
        high: 1.02,
        low: 0.99,
        close: 1.01,
        volume: null,
        tickCount: 60,
      };
    });
    mocks.findMany.mockResolvedValue(bars);
    mocks.count.mockResolvedValue(1800);
    const health = await historyCollector.getHistoryHealth("EURUSD", now);
    expect(health.bars_30m).toBe(30);
    expect(health.ticks_30m).toBe(1800);
    expect(health.window_complete).toBe(true);
    expect(health.min_bucket_ms).toBe(minuteBucket(now - 29 * MIN));
    expect(health.max_bucket_ms).toBeDefined();
  });

  it("flags an incomplete window when fewer than 30 bars persisted", async () => {
    const now = Date.now();
    const bars = Array.from({ length: 10 }, (_, i) => ({
      bucketStartMs: BigInt(minuteBucket(now - (9 - i) * MIN)),
      open: 1.0,
      high: 1.0,
      low: 1.0,
      close: 1.0,
      volume: null,
      tickCount: 60,
    }));
    mocks.findMany.mockResolvedValue(bars);
    mocks.count.mockResolvedValue(600);
    const health = await historyCollector.getHistoryHealth("EURUSD", now);
    expect(health.window_complete).toBe(false);
    expect(health.bars_30m).toBe(10);
  });
});

describe("historyCollector.window constants", () => {
  it("matches the mission's 30-minute window @ 1-minute buckets", () => {
    expect(HISTORY_WINDOW_MINUTES).toBe(30);
    expect(HISTORY_BUCKET_MS).toBe(60_000);
  });
});

describe("historyCollector.upsertBars (Alpha.5 Pro, Part 6.3 ingest)", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({ id: "x" });
  });

  it("upserts one idempotent (symbol, timeframe, bucket) row per real bar", async () => {
    const bucket = minuteBucket(Date.now());
    const n = await historyCollector.upsertBars("EUR/USD", "1m", [
      { bucketStartMs: bucket, open: 1.085, high: 1.085, low: 1.085, close: 1.085, tickCount: 1 },
      { bucketStartMs: bucket - MIN, open: 1.084, high: 1.084, low: 1.084, close: 1.084, tickCount: 1 },
    ]);
    expect(n).toBe(2);
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    const first = mocks.upsert.mock.calls[0][0];
    expect(first.where.symbol_timeframe_bucketStartMs).toEqual({
      symbol: "EUR/USD",
      timeframe: "1m",
      bucketStartMs: BigInt(bucket),
    });
    expect(first.create.close).toBe(1.085);
    expect(first.create.tickCount).toBe(1);
    expect(first.update.close).toBe(1.085);
  });

  it("normalises symbol + timeframe; rejects non-finite bars", async () => {
    const bucket = minuteBucket(Date.now());
    const n = await historyCollector.upsertBars(" eur/usd ", " 1M ", [
      { bucketStartMs: bucket, open: 1.085, high: Number.NaN, low: 1.085, close: 1.085 },
      { bucketStartMs: bucket, open: 1.085, high: 1.086, low: 1.085, close: 1.085 },
    ]);
    expect(n).toBe(1);
    const call = mocks.upsert.mock.calls[0][0];
    expect(call.where.symbol_timeframe_bucketStartMs.symbol).toBe("EUR/USD");
    expect(call.where.symbol_timeframe_bucketStartMs.timeframe).toBe("1M");
  });

  it("returns 0 and never calls the store for empty input", async () => {
    expect(await historyCollector.upsertBars("EURUSD", "1m", [])).toBe(0);
    expect(await historyCollector.upsertBars("", "1m", [{ bucketStartMs: 1, open: 1, high: 1, low: 1, close: 1 }])).toBe(0);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});