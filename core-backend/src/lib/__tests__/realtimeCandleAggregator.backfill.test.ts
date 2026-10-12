/**
 * PART 32.3 [251] — RESTART-SEAM REGRESSION FOR THE BOOT BACKFILL.
 *
 * Simulates exactly the production sequence the backfill exists for:
 *
 *   1. A previous process observed N real minutes and persisted them to the
 *      AssetHistory store (the fixture bars below stand in for those rows).
 *   2. The process RESTARTS. The in-memory aggregator is empty; it backfills
 *      from the store.
 *   3. The first live tick after the restart arrives — possibly inside the very
 *      bucket that was already persisted (restart mid-minute).
 *
 * The invariant under test is the SEAM: after all three steps the series must
 * hold each time window EXACTLY once, with no duplicate and no gap. A backfill
 * that appends its last bar and then also closes the same bucket live produces
 * two bars for one window; one that re-opens the persisted minute produces a
 * gap-then-restart.
 *
 * Pure service-level: the loader is injected, so this needs no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregatePersistedBars,
  realtimeCandleAggregatorService,
  type PersistedBarLoader,
  type PersistedMinuteBar,
} from "../../services/realtimeCandleAggregator.service";

const MIN = 60_000;
/** A fixed 1-minute-aligned grid so every bucket math is exact. */
const T0 = Math.floor(1_800_000_000_000 / MIN) * MIN;

/** `count` consecutive real minutes ending (exclusive) at `endBucket`. */
function fixtureMinutes(count: number, endBucket: number): PersistedMinuteBar[] {
  const out: PersistedMinuteBar[] = [];
  for (let i = count; i >= 1; i--) {
    const bucketStartMs = endBucket - i * MIN;
    // A gentle ramp with per-minute range, so high/low differ from open/close
    // and a rollup has real extremes to combine.
    const open = 1.1 + i * 0.0001;
    out.push({
      bucketStartMs,
      open,
      high: open + 0.0004,
      low: open - 0.0003,
      close: open + 0.0002,
      volume: null,
      tickCount: 3 + i,
    });
  }
  return out;
}

/** Injects the fixture as the persisted store for every symbol. */
function loaderFor(rows: PersistedMinuteBar[]): PersistedBarLoader {
  return async () => rows;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  realtimeCandleAggregatorService.destroy();
});

afterEach(() => {
  realtimeCandleAggregatorService.destroy();
  vi.useRealTimers();
});

/** Timestamps of the current closed series — the shape the client reads. */
function closedTimestamps(symbol: string, tf: string): number[] {
  return (
    realtimeCandleAggregatorService.getClosedHistory(symbol, tf)?.map(
      (c) => c.timestamp,
    ) ?? []
  );
}

/** No duplicate and no gap: strictly increasing, each step one whole bucket. */
function expectContiguous(timestamps: number[], tfMs: number): void {
  for (let i = 1; i < timestamps.length; i++) {
    expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    expect(timestamps[i] - timestamps[i - 1]).toBe(tfMs);
  }
}

describe("PART 32.3 — boot backfill from persisted history", () => {
  it("[248] seeds the in-memory M1 series from persisted 1m rows", async () => {
    // 10 persisted minutes, the newest of which is the minute BEFORE now.
    const rows = fixtureMinutes(10, T0);
    const res = await realtimeCandleAggregatorService.backfillSymbolFromHistory(
      "EUR/USD",
      loaderFor(rows),
    );

    expect(res.barsLoaded).toBe(10);
    expect(res.byTimeframe.M1).toBe(10);
    // Persisted rows are sealed by definition.
    const series = realtimeCandleAggregatorService.getClosedHistory("EUR/USD", "M1") ?? [];
    expect(series).toHaveLength(10);
    expect(series.every((c) => c.isFinal === true)).toBe(true);
    expect(series.map((c) => c.timestamp)).toEqual(rows.map((r) => r.bucketStartMs));
  });

  it("[250] uses ONE code path for OTC, REAL and CRYPTO alike", async () => {
    // Deliberately different price magnitudes, including a low-magnitude pair.
    const cases: Array<[string, number]> = [
      ["EUR/USD", 1.1],       // OTC
      ["EUR/HUF", 367.25],    // REAL
      ["BTC/USD", 83_945],    // CRYPTO
    ];
    for (const [symbol, base] of cases) {
      const rows = fixtureMinutes(6, T0).map((r) => ({
        ...r,
        open: base + (r.open - 1.1),
        high: base + (r.high - 1.1),
        low: base + (r.low - 1.1),
        close: base + (r.close - 1.1),
      }));
      await realtimeCandleAggregatorService.backfillSymbolFromHistory(
        symbol,
        loaderFor(rows),
      );
      expect(closedTimestamps(symbol, "M1"), symbol).toHaveLength(6);
    }
  });

  it("[249] does NOT duplicate the last persisted minute when the first live tick lands on a later bucket", async () => {
    const rows = fixtureMinutes(5, T0); // newest persisted minute = T0 − 1m
    await realtimeCandleAggregatorService.backfillSymbolFromHistory(
      "EUR/USD",
      loaderFor(rows),
    );
    expect(closedTimestamps("EUR/USD", "M1")).toHaveLength(5);

    // Live tick inside the CURRENT minute opens a bucket; nothing closes yet.
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.2, T0 + 1_000);
    expect(closedTimestamps("EUR/USD", "M1")).toHaveLength(5);

    // The next minute's first tick closes it exactly once.
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.21, T0 + MIN + 1_000);

    const ts = closedTimestamps("EUR/USD", "M1");
    expect(ts).toHaveLength(6);
    expect(new Set(ts).size).toBe(ts.length); // no duplicate window
    expectContiguous(ts, MIN); // and no gap
  });

  it("[249] MERGES (never duplicates) when the restart happened mid-minute and the live bucket is already persisted", async () => {
    // The persisted store already holds a row for the CURRENT minute — the
    // collector ran before the process died, so the bucket was persisted but
    // never closed in RAM.
    const rows = [
      ...fixtureMinutes(4, T0),
      {
        bucketStartMs: T0,
        open: 1.5,
        high: 1.5,
        low: 1.5,
        close: 1.5,
        volume: null,
        tickCount: 1,
      },
    ];
    await realtimeCandleAggregatorService.backfillSymbolFromHistory(
      "EUR/USD",
      loaderFor(rows),
    );
    expect(closedTimestamps("EUR/USD", "M1")).toHaveLength(5);

    // Live ticks continue INSIDE the same persisted minute, moving the price.
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.51, T0 + 1_000);
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.49, T0 + 2_000);
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.55, T0 + 3_000);

    // Crossing into the next minute closes the persisted minute. It must MERGE
    // with the persisted row — one bar carrying both halves. The crossing tick
    // then OPENS the next minute as the forming bar, so it is deliberately NOT
    // in `closed` yet.
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.56, T0 + MIN + 1_000);

    let series = realtimeCandleAggregatorService.getClosedHistory("EUR/USD", "M1") ?? [];
    let ts = series.map((c) => c.timestamp);
    expect(new Set(ts).size).toBe(ts.length); // no duplicate window
    expectContiguous(ts, MIN);
    expect(ts).toHaveLength(5);

    // The merged minute carries BOTH halves: the persisted open (1.5) plus the
    // live ticks observed inside it (1.51 / 1.49 / 1.55). The 1.56 crossing
    // tick belongs to the NEXT minute, so it must not leak into this bar.
    const merged = series.find((c) => c.timestamp === T0)!;
    expect(merged.open).toBe(1.5);
    expect(merged.high).toBe(1.55);
    expect(merged.low).toBe(1.49);
    expect(merged.close).toBe(1.55);

    // The crossing tick was NOT swallowed by the merge — it survives as the next
    // forming bucket, keeps taking ticks inside that minute, and lands as its
    // own bar on the following close.
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.60, T0 + MIN + 30_000);
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.62, T0 + 2 * MIN + 1_000);
    series = realtimeCandleAggregatorService.getClosedHistory("EUR/USD", "M1") ?? [];
    ts = series.map((c) => c.timestamp);
    expect(new Set(ts).size).toBe(ts.length);
    expectContiguous(ts, MIN);
    expect(ts).toHaveLength(6);
    const formed = series.find((c) => c.timestamp === T0 + MIN)!;
    expect(formed.open).toBe(1.56);
    expect(formed.close).toBe(1.6);
  });

  it("[249] backfilling twice is idempotent (restart twice, same store)", async () => {
    const rows = fixtureMinutes(7, T0);
    const load = loaderFor(rows);
    await realtimeCandleAggregatorService.backfillSymbolFromHistory("GBP/JPY", load);
    await realtimeCandleAggregatorService.backfillSymbolFromHistory("GBP/JPY", load);

    const ts = closedTimestamps("GBP/JPY", "M1");
    expect(ts).toHaveLength(7);
    expect(new Set(ts).size).toBe(7);
    expectContiguous(ts, MIN);
  });

  it("rolls persisted 1m bars up into coarser frames with exact OHLC", () => {
    const rows = fixtureMinutes(10, T0);
    const m5 = aggregatePersistedBars(rows, 5 * MIN)!;
    expect(m5).toHaveLength(2);

    const first = m5[0];
    const group = rows.filter(
      (r) => r.bucketStartMs >= first.timestamp && r.bucketStartMs < first.timestamp + 5 * MIN,
    );
    expect(first.open).toBe(group[0].open);
    expect(first.close).toBe(group[group.length - 1].close);
    expect(first.high).toBe(Math.max(...group.map((r) => r.high)));
    expect(first.low).toBe(Math.min(...group.map((r) => r.low)));
  });

  it("NEVER backfills sub-minute frames — 1m bars cannot be split downward", () => {
    const rows = fixtureMinutes(5, T0);
    // Fabricating S5/S10/S15/S30 from 1m rows would invent intra-bucket
    // movement, so the rollup refuses and those frames stay empty.
    for (const tfMs of [5_000, 10_000, 15_000, 30_000]) {
      expect(aggregatePersistedBars(rows, tfMs)).toBeNull();
    }
  });

  it("seeds coarser frames at boot and keeps the live close contiguous", async () => {
    const rows = fixtureMinutes(20, T0); // 20 real minutes = 4 complete M5 bars
    const res = await realtimeCandleAggregatorService.backfillSymbolFromHistory(
      "EUR/USD",
      loaderFor(rows),
    );
    expect(res.byTimeframe.M1).toBe(20);
    expect(res.byTimeframe.M5).toBe(4);

    const m5 = closedTimestamps("EUR/USD", "M5");
    expect(m5).toHaveLength(4);
    expectContiguous(m5, 5 * MIN);

    // Live ticks advance the M5 grid; the sealed tail is replaced, not doubled.
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.3, T0 + 1_000);
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.4, T0 + 5 * MIN + 1_000);
    const after = closedTimestamps("EUR/USD", "M5");
    expect(new Set(after).size).toBe(after.length);
    expectContiguous(after, 5 * MIN);
  });

  it("is resilient when the store has no rows for a symbol", async () => {
    const res = await realtimeCandleAggregatorService.backfillSymbolFromHistory(
      "ZZZ/QQQ",
      loaderFor([]),
    );
    expect(res.barsLoaded).toBe(0);
    expect(realtimeCandleAggregatorService.getClosedHistory("ZZZ/QQQ", "M1")).toBeNull();
  });

  it("survives a loader failure without seeding anything", async () => {
    const boom: PersistedBarLoader = async () => {
      throw new Error("db down");
    };
    const res = await realtimeCandleAggregatorService.backfillSymbolFromHistory(
      "EUR/USD",
      boom,
    );
    expect(res.barsLoaded).toBe(0);
    expect(realtimeCandleAggregatorService.getClosedHistory("EUR/USD", "M1")).toBeNull();
  });

  it("backfills the whole universe in one pass and tallies per timeframe", async () => {
    const rows = fixtureMinutes(6, T0);
    const res = await realtimeCandleAggregatorService.backfillAllFromHistory(
      ["EUR/USD", "eur/usd", "BTC/USD"],
      loaderFor(rows),
    );
    // "EUR/USD" and "eur/usd" canonicalise to the SAME state, so two distinct
    // symbols are seeded — proof the pass is keyed canonically.
    expect(res.symbols).toBe(3);
    expect(res.seeded).toBe(3);
    expect(res.byTimeframe.M1).toBe(18);
    expect(closedTimestamps("EUR/USD", "M1")).toHaveLength(6);
    expect(closedTimestamps("BTC/USD", "M1")).toHaveLength(6);
  });
});