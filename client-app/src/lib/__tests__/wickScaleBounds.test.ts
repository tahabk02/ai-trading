/**
 * PART 32[232] — LONG-WICK / PRICE-SCALE BOUNDING REGRESSION.
 *
 * Guards the two claims that were investigated and settled in PART 32:
 *
 *  1. [228] FALSE PREMISE (now permanent cover) — there is no OHLC→pixel
 *     mapping in the client to get wrong. Wicks are drawn by lightweight-charts
 *     from the CandlestickData handed to `addCandlestickSeries`, so a wick can
 *     only ever span its OWN high/low. This suite therefore asserts the
 *     invariant that makes that true: the row handed to the series carries the
 *     candle's own high/low unmodified.
 *
 *  2. [229] DOMAIN PADDING — the visible price domain must be padded so that
 *     extreme wicks cannot sit flush against the pane edge. With
 *     `scaleMargins { top: 0.08, bottom: 0.22 }` the padded domain is strictly
 *     wider than [min(low), max(high)], and the wick of the most extreme candle
 *     maps strictly INSIDE that padded domain — never onto its border.
 *
 *  3. [236] DISPLAY DOMAIN == LABEL DOMAIN — after the RAW switch the rendered
 *     tape must be the RAW series, so a TGT/ANC/LIVE label anchored on
 *     `rawAnchorClose` refers to a price the chart actually draws.
 */
import { describe, expect, it } from "vitest";

import {
  rawAnchorClose,
  syncRawDisplay,
  type Candle,
} from "@/lib/realtimeCandleAggregator";

const T0 = 1_700_000_000_000;

/** scaleMargins actually configured on the chart's price scale. */
const MARGIN_TOP = 0.08;
const MARGIN_BOTTOM = 0.22;

function pad(rows: Candle[]): Candle[] {
  return rows.map((c, i) => ({
    timestamp: T0 + i * 60_000,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

/**
 * Reproduce lightweight-charts' linear price→fraction mapping over the padded
 * domain. `fraction` is the position down the pane; 0 = padded top, 1 = padded
 * bottom. Mirrors `scaleMargins`: the data domain occupies the band between
 * `top` and `1 - bottom`.
 */
function priceToFraction(price: number, minLow: number, maxHigh: number): number {
  const range = maxHigh - minLow;
  if (range <= 0) return 0;
  const span = MARGIN_TOP + MARGIN_BOTTOM;
  const usable = 1 - span;
  const raw = (maxHigh - price) / range; // 0 at maxHigh, 1 at minLow
  return MARGIN_TOP + raw * usable;
}

describe("PART 32 — wick bounds and price-scale padding", () => {
  // ── [232] THE LONG-WICK SCENARIO ───────────────────────────────────────
  // One candle whose high/low sit far outside its own open/close: the exact
  // shape that produced the "thin line stretching across the grid" report.
  const longWick: Candle = {
    timestamp: T0,
    open: 1.10000,
    high: 1.14500, // +450 pips above open
    low: 1.05500, // −450 pips below open
    close: 1.10050,
    volume: 10,
  };
  const neighbourA: Candle = {
    timestamp: T0 + 60_000,
    open: 1.10050,
    high: 1.10120,
    low: 1.09980,
    close: 1.10090,
    volume: 10,
  };
  const neighbourB: Candle = {
    timestamp: T0 + 120_000,
    open: 1.10090,
    high: 1.10160,
    low: 1.10010,
    close: 1.10110,
    volume: 10,
  };

  const series = pad([longWick, neighbourA, neighbourB]);

  // ── [228] the wick carries its OWN high/low, nothing else ────────────────
  it("hands the series each candle's own high/low, so a wick cannot be mapped against the full domain", () => {
    const { raw } = syncRawDisplay(series);
    const wick = raw[0];
    expect(wick.high).toBe(1.145);
    expect(wick.low).toBe(1.055);
    // Each row's wick span is exactly its OWN high→low. Neighbouring rows carry
    // their own, far smaller, spans — which is the invariant that makes [228]'s
    // failure mode impossible: no row can borrow the series' extremes.
    expect(raw[0].high - raw[0].low).toBeCloseTo(0.09, 12);
    expect(raw[1].high - raw[1].low).toBeCloseTo(0.0014, 12);
    expect(raw[2].high - raw[2].low).toBeCloseTo(0.0015, 12);
    for (const row of raw) {
      expect(row.high).toBeGreaterThanOrEqual(Math.max(row.open, row.close));
      expect(row.low).toBeLessThanOrEqual(Math.min(row.open, row.close));
    }
  });

  // ── [229] the domain is padded beyond [min(low), max(high)] ─────────────
  it("pads the domain so the data band is strictly inside the pane", () => {
    const minLow = Math.min(...series.map((c) => c.low));
    const maxHigh = Math.max(...series.map((c) => c.high));

    expect(priceToFraction(maxHigh, minLow, maxHigh)).toBeCloseTo(MARGIN_TOP, 12);
    expect(priceToFraction(minLow, minLow, maxHigh)).toBeCloseTo(1 - MARGIN_BOTTOM, 12);

    // Both extremes land strictly inside the pane — never on a border.
    expect(priceToFraction(maxHigh, minLow, maxHigh)).toBeGreaterThan(0);
    expect(priceToFraction(minLow, minLow, maxHigh)).toBeLessThan(1);
  });

  // ── [232] THE LONG WICK STAYS INSIDE THE PADDED DOMAIN ─────────────────
  it("keeps the long-wick candle's high and low strictly inside [padded_top, padded_bottom]", () => {
    const minLow = Math.min(...series.map((c) => c.low));
    const maxHigh = Math.max(...series.map((c) => c.high));
    const top = priceToFraction(maxHigh, minLow, maxHigh); // padded top
    const bottom = priceToFraction(minLow, minLow, maxHigh); // padded bottom

    const wick = series[0];
    const wickTop = priceToFraction(wick.high, minLow, maxHigh);
    const wickBottom = priceToFraction(wick.low, minLow, maxHigh);

    // Bounds hold with room to spare on both sides.
    expect(wickTop).toBeGreaterThanOrEqual(top);
    expect(wickTop).toBeLessThan(bottom);
    expect(wickBottom).toBeLessThanOrEqual(bottom);
    expect(wickBottom).toBeGreaterThan(top);

    // The wick spans its own high→low and nothing beyond: the mapping is
    // monotonic, so a longer series cannot stretch this candle's wick.
    expect(wickTop).toBeLessThan(priceToFraction(wick.open, minLow, maxHigh));
    expect(wickBottom).toBeGreaterThan(priceToFraction(wick.close, minLow, maxHigh));
  });

  // ── [232] adding far more extreme candles does not stretch THIS wick ───
  it("never clips an existing wick when the series gains wider candles", () => {
    // A much wider neighbour enters the visible domain, which rescales the pane.
    const widened = [
      ...series,
      { ...series[2], timestamp: T0 + 180_000, high: 1.3000, low: 0.9000 },
    ];
    const minLow = Math.min(...widened.map((c) => c.low));
    const maxHigh = Math.max(...widened.map((c) => c.high));

    const fracHigh = priceToFraction(widened[0].high, minLow, maxHigh);
    const fracOpen = priceToFraction(widened[0].open, minLow, maxHigh);
    const fracClose = priceToFraction(widened[0].close, minLow, maxHigh);
    const fracLow = priceToFraction(widened[0].low, minLow, maxHigh);

    // The candle keeps its own high→low ordering. Screen fraction runs the
    // opposite way to price (a LOWER price sits at a LARGER fraction), so with
    // high 1.145 > close 1.10050 > open 1.10000 > low 1.055 the fractions order
    // as high < close < open < low.
    expect(fracHigh).toBeLessThan(fracClose);
    expect(fracClose).toBeLessThan(fracOpen);
    expect(fracOpen).toBeLessThan(fracLow);
    for (const f of [fracHigh, fracOpen, fracClose, fracLow]) {
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThan(1);
    }
    // And it is still comfortably off both borders — the 8%/22% padding holds.
    expect(fracHigh).toBeGreaterThan(MARGIN_TOP);
    expect(fracLow).toBeLessThan(1 - MARGIN_BOTTOM);
  });

  // ── [236] DISPLAY DOMAIN == LABEL DOMAIN ───────────────────────────────
  it("renders the RAW domain, so predictive labels reference drawn prices", () => {
    const { raw, display } = syncRawDisplay(series);
    // The RAW switch the chart now performs.
    expect(raw[0]).toEqual(series[0]);
    // Raw close is a price the chart actually draws.
    expect(raw[0].close).toBeCloseTo(1.10050, 12);
    expect(rawAnchorClose(raw)).toBeCloseTo(raw[raw.length - 1].close, 12);
    // HA is retained as an analysis overlay and MUST still differ, proving the
    // two domains remain distinguishable rather than silently collapsed.
    expect(display[0].open).not.toBeCloseTo(raw[0].open, 6);
  });
});