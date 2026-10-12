import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forexDataService } from "../../services/forexData.service";
import { normalizeOhlc } from "../ohlcNormalizer";

/**
 * Reproduces the PRODUCTION OTC shape end to end through the real service.
 *
 * The reported symptom was "flat red blocks" on the OTC chart. Root cause: the
 * poller reads a price every 10s while the aggregator maintains a 1s bucket, so
 * every tick opened a BRAND-NEW single-tick bucket — and a single-tick bucket
 * was stored as open=high=low=close, a zero-height body that renders as a
 * horizontal line (or a red slab when the next tick printed lower).
 *
 * `appendTick` reads `Date.now()` internally, so the clock is faked and
 * advanced 10s per tick to reproduce the real cadence exactly.
 *
 * A unique symbol per test keeps these independent of the shared singleton
 * buffer and of each other.
 */

const T0 = 1_700_000_000_000;
let seq = 0;
const nextSymbol = () => `OTC_TEST_${++seq}`;

/** Must mirror the service's own timeframeToMs, incl. the fixed "1s" entry. */
const TF_MS = { "1s": 1_000, "1m": 60_000 } as const;
function bucketTs(time: number, tf: keyof typeof TF_MS): number {
  return time - (time % TF_MS[tf]);
}

/** Feed a price every 10s, exactly as the live poller does. */
function feed10s(symbol: string, prices: number[]): void {
  prices.forEach((p, i) => {
    vi.setSystemTime(T0 + i * 10_000);
    forexDataService.appendTick(symbol, p);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OTC tick aggregation — 10s poll feeding a 1s bucket", () => {
  it("produces NO flat (zero-height) 1s bars for a moving price", () => {
    const sym = nextSymbol();
    feed10s(sym, [
      1.1, 1.1005, 1.101, 1.1015, 1.102, 1.1015, 1.101, 1.1005, 1.1, 1.1005, 1.101, 1.1015,
    ]);

    const bars = forexDataService.getLiveCandles(sym, "1s");
    // 12 ticks 10s apart => 12 distinct 1s buckets.
    expect(bars.length).toBe(12);

    // THE REGRESSION: pre-fix, EVERY bucket was open=high=low=close.
    //
    // The first bucket is legitimately flat — there is no prior close to open
    // from, and inventing one would be fabrication. Every bucket after it
    // must carry a real body.
    expect(bars[0].high - bars[0].low).toBe(0);
    const flat = bars.slice(1).filter((b) => b.high - b.low === 0);
    expect(flat).toHaveLength(0);

    for (const b of bars) {
      expect(normalizeOhlc(b)).not.toBeNull();
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
    }
  });

  it("chains each bucket open to the previous close (continuity)", () => {
    const sym = nextSymbol();
    feed10s(sym, [1.1, 1.11, 1.12]);
    const bars = forexDataService.getLiveCandles(sym, "1s");
    for (let i = 1; i < bars.length; i++) {
      // open[i] is seeded from close[i-1] — real bodies, zero fabrication.
      expect(bars[i].open).toBeCloseTo(bars[i - 1].close, 10);
    }
  });

  it("renders a falling market as real bodies, not red slabs", () => {
    const sym = nextSymbol();
    feed10s(sym, [1.12, 1.11, 1.1, 1.09]);
    const bars = forexDataService.getLiveCandles(sym, "1s");
    // First bar is flat by necessity (no prior close); the rest are real bodies.
    for (const b of bars.slice(1)) {
      expect(b.high - b.low).toBeGreaterThan(0);
      expect(b.close).toBeLessThanOrEqual(b.open);
    }
  });

  it("aggregates many ticks in ONE bucket into a single wide bar", () => {
    const sym = nextSymbol();
    // 10 ticks 100ms apart all land in the same 1s bucket.
    [1.1, 1.101, 1.102, 1.103, 1.104, 1.105, 1.106, 1.107, 1.108, 1.109].forEach(
      (p, i) => {
        vi.setSystemTime(T0 + i * 100);
        forexDataService.appendTick(sym, p);
      },
    );
    const bars = forexDataService.getLiveCandles(sym, "1s");
    expect(bars).toHaveLength(1);
    expect(bars[0].open).toBe(1.1);
    expect(bars[0].close).toBe(1.109);
    expect(bars[0].high).toBe(1.109);
    expect(bars[0].low).toBe(1.1);
    expect(bars[0].volume).toBe(10);
  });

  it("never emits a non-finite or zero-price bar after a bad tick", () => {
    const sym = nextSymbol();
    feed10s(sym, [1.1, NaN, 0, Infinity, 1.1005]);
    const bars = forexDataService.getLiveCandles(sym, "1s");
    for (const b of bars) {
      for (const v of [b.open, b.high, b.low, b.close]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  it("1m bucket stays consistent under the same feed", () => {
    const sym = nextSymbol();
    feed10s(sym, [1.1, 1.1005, 1.101, 1.1015, 1.102, 1.1015, 1.101, 1.1005, 1.1, 1.1005, 1.101, 1.1015]);
    const bars = forexDataService.getLiveCandles(sym, "1m");
    expect(bars.length).toBeGreaterThanOrEqual(1);
    for (const b of bars) {
      expect(normalizeOhlc(b)).not.toBeNull();
    }
  });
});

describe("timeframe resolution", () => {
  it("resolves EVERY aggregate timeframe to its own real resolution", () => {
    // Guards the silent `|| 60_000` fallback: a timeframe listed in
    // AGGREGATE_TIMEFRAMES but missing from the map resolved to 1m, so the
    // "1s" buffer was a byte-for-byte duplicate of "1m" and any "1s" request
    // was answered with 1m-aligned buckets.
    const svc = forexDataService as unknown as {
      timeframeToMs(tf: string): number;
    };
    // "1s" and "1m" mirror AGGREGATE_TIMEFRAMES.
    expect(svc.timeframeToMs("1s")).toBe(1_000);
    expect(svc.timeframeToMs("1m")).toBe(60_000);
    // Neighbours must not collapse together.
    const widths = ["1s", "5s", "20s", "30s", "1m", "2m", "5m", "1h", "1d"].map((t) =>
      svc.timeframeToMs(t),
    );
    expect(new Set(widths).size).toBe(widths.length);
  });

  it("does not silently alias a known timeframe to the 1m default", () => {
    const svc = forexDataService as unknown as { timeframeToMs(tf: string): number };
    expect(svc.timeframeToMs("1s")).not.toBe(svc.timeframeToMs("1m"));
  });
});

describe("Pocket Option bridge candle ingestion", () => {
  const PO_T = 1_700_000_000_000;

  it("rejects a zero or non-finite OHLC payload instead of storing it", () => {
    const sym = nextSymbol();
    expect(
      forexDataService.ingestPoCandle(sym, PO_T, { open: 0, high: 0, low: 0, close: 0 }),
    ).toBeNull();
    expect(
      forexDataService.ingestPoCandle(sym, PO_T, {
        open: 1.1,
        high: 1.2,
        low: 1,
        close: NaN,
      }),
    ).toBeNull();
  });

  it("accepts a valid PO candle and stores it at the timeframe bucket", () => {
    const sym = nextSymbol();
    const ok = forexDataService.ingestPoCandle(
      sym,
      PO_T,
      { open: 1.1, high: 1.105, low: 1.095, close: 1.1 },
      true,
      "otc",
    );
    expect(ok).not.toBeNull();

    for (const tf of ["1m", "1s"] as const) {
      const series = forexDataService.getLiveCandles(sym, tf);
      const found = series.find((b) => b.timestamp === bucketTs(PO_T, tf));
      expect(found).toBeDefined();
      expect(found!.high).toBeGreaterThanOrEqual(Math.max(found!.open, found!.close));
      expect(found!.low).toBeLessThanOrEqual(Math.min(found!.open, found!.close));
    }
  });

  it("widens an under-reported PO envelope rather than rendering a broken body", () => {
    const sym = nextSymbol();
    // high is BELOW the close — pre-fix this produced a body outside its wick.
    const r = forexDataService.ingestPoCandle(sym, PO_T, {
      open: 1.1,
      high: 1.101,
      low: 1.095,
      close: 1.12,
    });
    expect(r).not.toBeNull();
    expect(r!.high).toBe(1.12);
  });
});
