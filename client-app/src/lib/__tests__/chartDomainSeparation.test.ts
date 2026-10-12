/**
 * RAW vs DISPLAY DOMAIN SEPARATION.
 *
 * Regression cover for two production artefacts:
 *
 *  1. "Giant spikes / stretched candles" — a live RAW tick was merged straight
 *     into the already-Heikin-Ashi-folded display array, so the forming bar
 *     rendered with raw geometry while every earlier bar was HA. Two encodings
 *     on one price axis.
 *
 *  2. "TGT doesn't match the live feed" — the target trajectory was anchored on
 *     the DISPLAY close, which is a smoothed HA midpoint rather than a real
 *     price, and alternated raw/HA across rebuilds.
 *
 * Contract: `display` is always a pure fold of `raw`, and every predictive
 * anchor comes from `raw`.
 */
import { describe, expect, it } from "vitest";

import {
  buildTargetFrame,
  rawAnchorClose,
  syncRawDisplay,
  toHeikinAshiSeries,
  type Candle,
} from "@/lib/realtimeCandleAggregator";

const T0 = 1_700_000_000_000;

/** A realistic 1-minute FX ramp with a pullback — no synthetic extremes. */
function rawSeries(): Candle[] {
  const closes = [
    1.1000, 1.1012, 1.1005, 1.1021, 1.1030, 1.1018, 1.1009, 1.1024, 1.1040,
    1.1031, 1.1015, 1.1002, 1.1011, 1.1029, 1.1043, 1.1050,
  ];
  return closes.map((close, i) => {
    const open = i === 0 ? close - 0.0004 : closes[i - 1];
    const high = Math.max(open, close) + 0.0006;
    const low = Math.min(open, close) - 0.0005;
    return {
      timestamp: T0 + i * 60_000,
      open,
      high,
      low,
      close,
      volume: 100 + i,
    };
  });
}

describe("display series is a pure fold of raw", () => {
  it("folds every bar, including the tip, into Heikin-Ashi", () => {
    const raw = rawSeries();
    const { display } = syncRawDisplay(raw);

    expect(display).toHaveLength(raw.length);
    expect(display).toEqual(toHeikinAshiSeries(raw) as Candle[]);

    // The regression: if the tip were still raw, this would be identical.
    const rawTip = raw[raw.length - 1];
    const displayTip = display[display.length - 1];
    expect(displayTip.close).not.toBe(rawTip.close);
    expect(displayTip.timestamp).toBe(rawTip.timestamp);
    // Volume is NOT a Heikin-Ashi quantity and must pass through untouched.
    expect(displayTip.volume).toBe(rawTip.volume);
  });

  it("re-deriving after a live tick keeps the tip HA-encoded", () => {
    const raw = rawSeries();
    // A live tick mutates ONLY the raw array — never the display array.
    const live: Candle = {
      timestamp: T0 + 15 * 60_000,
      open: 1.1050,
      high: 1.1062,
      low: 1.1044,
      close: 1.1058,
      volume: 999,
    };
    raw.push(live);

    const { display } = syncRawDisplay(raw);
    const tip = display[display.length - 1];

    expect(tip.timestamp).toBe(live.timestamp);
    // HA identities, asserted exactly. Note HA_High = max(High, HA_Open,
    // HA_Close) — so the wick is NOT guaranteed to differ from the raw high;
    // HA_Close always does, and that is the discriminator that proves the
    // forming bar is HA-encoded rather than a raw row injected by mistake.
    const haClose = (live.open + live.high + live.low + live.close) / 4;
    expect(tip.close).toBeCloseTo(haClose, 12);
    expect(tip.close).not.toBe(live.close);
    expect(tip.high).toBe(Math.max(live.high, tip.open, tip.close));
    expect(tip.low).toBe(Math.min(live.low, tip.open, tip.close));
    expect(tip.volume).toBe(999);
  });

  it("never mutates the caller's raw array", () => {
    const raw = rawSeries();
    const snapshot = JSON.stringify(raw);
    syncRawDisplay(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it("HA bodies stay inside the raw price domain (no runaway spikes)", () => {
    const raw = rawSeries();
    const { display } = syncRawDisplay(raw);
    const rawLow = Math.min(...raw.map((c) => c.low));
    const rawHigh = Math.max(...raw.map((c) => c.high));

    for (const bar of display) {
      // A wick escaping the observed tape band is the visible "giant spike".
      expect(bar.high).toBeLessThanOrEqual(rawHigh + 1e-9);
      expect(bar.low).toBeGreaterThanOrEqual(rawLow - 1e-9);
      // OHLC ordering must always hold, or the candle geometry is invalid.
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
    }
  });
});

describe("predictive anchors come from the raw domain", () => {
  it("anchors on the real tape price, not the smoothed HA close", () => {
    const raw = rawSeries();
    const { display } = syncRawDisplay(raw);

    const anchor = rawAnchorClose(raw);
    const haClose = display[display.length - 1].close;

    expect(anchor).toBe(raw[raw.length - 1].close);
    // This divergence is exactly why anchoring on the display broke the TGT.
    expect(anchor).not.toBe(haClose);
  });

  it("returns 0 for an empty series so callers fall through safely", () => {
    expect(rawAnchorClose([])).toBe(0);
    expect(rawAnchorClose(null)).toBe(0);
    expect(rawAnchorClose(undefined)).toBe(0);
    expect(rawAnchorClose([{ close: 0 }])).toBe(0);
    expect(rawAnchorClose([{ close: Number.NaN }])).toBe(0);
  });
});

/**
 * The projection overlay shares the candle series' right price scale. When the
 * tape renders as Heikin-Ashi, anchoring the overlay on the REAL close left a
 * gap equal to the HA-vs-raw offset, so the TGT appeared detached from the last
 * candle. It now grows from the DISPLAYED close while still landing exactly on
 * the real target.
 */
describe("target projection attaches to the displayed candle", () => {
  const frame = (visualAnchor?: number) =>
    buildTargetFrame({
      liveTipBucketSec: T0 / 1000,
      timeframeSec: 60,
      intervals: 5,
      liveClose: 1.1058,
      visualAnchor,
      target: 1.12,
      atr: 0.0012,
      signal: "BUY",
    });

  it("starts at the displayed close when one is supplied", () => {
    const candles = frame(1.1031);
    expect(candles[0].open).toBe(1.1031);
  });

  it("still lands exactly on the real target at expiry", () => {
    for (const anchor of [1.1031, 1.1058, 1.1]) {
      const candles = frame(anchor);
      const last = candles[candles.length - 1];
      expect(last.close).toBeCloseTo(1.12, 12);
    }
  });

  it("falls back to the real close when no display baseline is given", () => {
    // Back-compat: SSR / callers with no series must behave exactly as before.
    expect(frame(undefined)[0].open).toBe(1.1058);
    expect(frame(0)[0].open).toBe(1.1058);
    expect(frame(Number.NaN)[0].open).toBe(1.1058);
  });

  it("produces contiguous bodies — no gap and no overlap between slots", () => {
    const candles = frame(1.1031);
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].open).toBe(candles[i - 1].close);
    }
    // Monotone path toward the target for a BUY.
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].close).toBeGreaterThan(candles[i - 1].close);
    }
  });

  it("keeps the safety cap and OHLC ordering valid on the display baseline", () => {
    const candles = frame(1.1031);
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(Number.isFinite(c.low)).toBe(true);
      expect(c.low).toBeGreaterThanOrEqual(0);
    }
  });
});
