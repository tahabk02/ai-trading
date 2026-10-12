import { describe, expect, it } from "vitest";
import {
  applyPrintToBar,
  isUsablePrice,
  normalizeOhlc,
  normalizeOhlcDetailed,
  normalizeSeries,
  openBucket,
} from "../ohlcNormalizer";

/**
 * Contract tests for the single OHLC authority.
 *
 * These lock in the two real defects the OTC chart was showing:
 *   1. single-tick buckets stored as open=high=low=close ("flat red blocks")
 *   2. a non-finite tick permanently poisoning a bucket's high/low forever
 * and the zero-price artifact (a 0/NaN close) that renders as a full-height
 * slab and poisons every downstream aggregate.
 */

const T = 1_700_000_000_000;
const bar = (o: unknown, h: unknown, l: unknown, c: unknown) => ({
  timestamp: T,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1,
});

describe("normalizeOhlcDetailed — rejection", () => {
  it("rejects a non-object", () => {
    expect(normalizeOhlcDetailed(null)).toEqual({ ok: false, reason: "missing" });
    expect(normalizeOhlcDetailed(42)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a non-finite timestamp", () => {
    expect(normalizeOhlcDetailed({ ...bar(1, 1, 1, 1), timestamp: NaN })).toEqual({
      ok: false,
      reason: "bad_timestamp",
    });
  });

  it("rejects NaN with a non_finite reason, NOT non_positive", () => {
    // Regression: `NaN > 0` is false, so a combined positivity check reports
    // the wrong cause and hides NaN poisoning at the source.
    const r = normalizeOhlcDetailed(bar(1, 1, 1, NaN));
    expect(r).toEqual({ ok: false, reason: "non_finite" });
  });

  it("rejects null-mapped fields that coerce to 0", () => {
    // `Number(null) === 0` slips past a naive `> 0` guard elsewhere.
    expect(normalizeOhlcDetailed(bar(1, 1, 1, null))).toEqual({
      ok: false,
      reason: "non_positive",
    });
  });

  it("rejects the zero-price artifact", () => {
    expect(normalizeOhlc(bar(0, 0, 0, 0))).toBeNull();
    expect(normalizeOhlc(bar(1, 1, 1, 0))).toBeNull();
    expect(normalizeOhlc(bar(1, 1, 1, -1))).toBeNull();
  });
});

describe("normalizeOhlcDetailed — envelope invariants", () => {
  it("accepts a well-formed bar unchanged", () => {
    const r = normalizeOhlcDetailed(bar(100, 110, 90, 105));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(false);
      expect(r.candle).toEqual({
        timestamp: T,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 1,
      });
    }
  });

  it("widens a high that does not cover the body", () => {
    // An under-reported high renders as a body poking outside its own wick.
    const r = normalizeOhlcDetailed(bar(100, 101, 90, 105));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.candle.high).toBe(105);
      expect(r.candle.low).toBe(90);
    }
  });

  it("widens a low that does not cover the body", () => {
    const r = normalizeOhlcDetailed(bar(100, 110, 99, 95));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candle.low).toBe(95);
  });

  it("keeps a flat bar (genuinely no movement) rather than rejecting it", () => {
    // Flat is VALID data — it is only a flat *single-tick bucket* that is a
    // defect. Rejecting real flat bars would delete legitimate quiet markets.
    const r = normalizeOhlc(bar(100, 100, 100, 100));
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ high: 100, low: 100 });
  });

  it("never narrows the observed range", () => {
    const r = normalizeOhlc(bar(100, 120, 80, 105));
    expect(r).toMatchObject({ high: 120, low: 80 });
  });

  it("coerces an invalid volume to 0 instead of NaN", () => {
    const r = normalizeOhlc({ ...bar(1, 1, 1, 1), volume: NaN });
    expect(r).toMatchObject({ volume: 0 });
  });
});

describe("openBucket — the flat-candle fix", () => {
  it("opens at the first tick when there is no prior bar", () => {
    const b = openBucket(T, 100, null);
    expect(b).toMatchObject({ timestamp: T, open: 100, high: 100, low: 100, close: 100 });
  });

  it("OPENS AT THE PREVIOUS CLOSE, producing a real body", () => {
    // The defect: a bucket holding one tick was open=high=low=close, i.e. a
    // zero-height block. Carrying the prior close makes the body real using
    // only the previous bar's own close — no fabricated price action.
    const b = openBucket(T, 100, 95);
    expect(b).toMatchObject({ timestamp: T, open: 95, close: 100 });
    expect(b!.high).toBe(100);
    expect(b!.low).toBe(95);
    expect(b!.high).toBeGreaterThan(b!.low);
  });

  it("makes a rising single-tick bucket render a non-flat body", () => {
    const b = openBucket(T, 101, 100)!;
    expect(b.high - b.low).toBeGreaterThan(0);
  });

  it("makes a falling single-tick bucket render a non-flat body", () => {
    const b = openBucket(T, 99, 100)!;
    expect(b.high - b.low).toBeGreaterThan(0);
    expect(b.open).toBe(100);
    expect(b.close).toBe(99);
  });

  it("refuses a non-finite price", () => {
    expect(openBucket(T, NaN, 100)).toBeNull();
    expect(openBucket(T, 0, 100)).toBeNull();
  });
});

describe("applyPrintToBar — NaN poisoning immunity", () => {
  it("updates extremes and close", () => {
    const b = openBucket(T, 100, null)!;
    const next = applyPrintToBar(b, 105)!;
    expect(next).toMatchObject({ high: 105, low: 100, close: 105, volume: 2 });
    expect(applyPrintToBar(next, 95)!).toMatchObject({ high: 105, low: 95, volume: 3 });
  });

  it("does not let a bad print mutate the bar at all", () => {
    const b = openBucket(T, 100, null)!;
    expect(applyPrintToBar(b, NaN)).toBeNull();
    expect(applyPrintToBar(b, 0)).toBeNull();
    expect(b).toMatchObject({ high: 100, low: 100, close: 100 });
  });

  it("HEALS a legacy NaN-poisoned bar instead of propagating it", () => {
    // The original bug: `Math.max(x, NaN) === NaN` destroyed high/low forever.
    const poisoned = { timestamp: T, open: 100, high: NaN, low: NaN, close: 100, volume: 3 };
    const healed = applyPrintToBar(poisoned, 101)!;
    expect(Number.isFinite(healed.high)).toBe(true);
    expect(Number.isFinite(healed.low)).toBe(true);
    expect(healed.high).toBe(101);
    expect(healed.low).toBe(100);
  });

  it("never mutates its input", () => {
    const b = openBucket(T, 100, null)!;
    const snapshot = { ...b };
    applyPrintToBar(b, 50);
    expect(b).toEqual(snapshot);
  });
});

describe("isUsablePrice", () => {
  it("accepts only finite positive numbers", () => {
    expect(isUsablePrice(1)).toBe(true);
    expect(isUsablePrice(0.00001)).toBe(true);
    expect(isUsablePrice(0)).toBe(false);
    expect(isUsablePrice(-1)).toBe(false);
    expect(isUsablePrice(NaN)).toBe(false);
    expect(isUsablePrice(Infinity)).toBe(false);
    expect(isUsablePrice("100")).toBe(false);
    expect(isUsablePrice(null)).toBe(false);
    expect(isUsablePrice(undefined)).toBe(false);
  });
});

describe("normalizeSeries — read boundary", () => {
  it("drops malformed bars rather than shrinking the series silently", () => {
    const out = normalizeSeries([
      { timestamp: T, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      { timestamp: T + 1, open: 1, high: 2, low: 0.5, close: NaN, volume: 1 },
      { timestamp: T + 2, open: 1, high: 2, low: 0.5, close: 0, volume: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe(T);
  });

  it("sorts ascending and collapses duplicate timestamps (last wins)", () => {
    const out = normalizeSeries([
      { timestamp: T + 2, open: 3, high: 3, low: 3, close: 3, volume: 1 },
      { timestamp: T, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: T + 2, open: 9, high: 9, low: 9, close: 9, volume: 1 },
    ]);
    expect(out.map((b) => b.timestamp)).toEqual([T, T + 2]);
    expect(out[1].close).toBe(9);
  });

  it("honours the limit tail", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      timestamp: T + i,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    }));
    const out = normalizeSeries(many, { limit: 3 });
    expect(out.map((b) => b.timestamp)).toEqual([T + 7, T + 8, T + 9]);
  });

  it("returns [] for non-arrays", () => {
    expect(normalizeSeries(null)).toEqual([]);
    expect(normalizeSeries(undefined)).toEqual([]);
    expect(normalizeSeries("bars")).toEqual([]);
  });
});
