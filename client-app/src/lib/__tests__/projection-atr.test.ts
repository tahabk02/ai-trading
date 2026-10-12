/**
 * Contract for the projection ATR guard.
 *
 * The reported symptom was "broken target candles with vertical spikes shooting
 * up to the ceiling". `buildTargetFrame` clamps each wick to `safetyCap = 50% of
 * the price level`, so an out-of-scale ATR does not get suppressed â€” the clamp
 * itself draws the spike. These tests pin the boundary guard that makes that cap
 * unreachable for any plausible input.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeProjectionAtr,
  clampTargetToAnchor,
  MAX_ATR_FRACTION_OF_PRICE,
  MAX_TARGET_DEVIATION_FRACTION,
} from "@/lib/projectionAtr";
import { buildTargetFrame } from "@/lib/realtimeCandleAggregator";

const ANCHOR = 1.1; // EUR/USD-ish

describe("normalizeProjectionAtr", () => {
  it("passes a healthy short-horizon ATR through unchanged", () => {
    // 0.0011 == 0.1% of the anchor: typical for a short FX horizon.
    expect(normalizeProjectionAtr(0.0011, ANCHOR)).toBe(0.0011);
  });

  it("rejects ATR supplied in pips instead of price units", () => {
    // 30 pips == 0.0030 at this price, but the wire says 30. At 30 the raw wick
    // would be 30 * 0.35 = 10.5, which exceeds the 0.55 safetyCap and renders as
    // a 50%-of-price spike to the top of the chart.
    expect(normalizeProjectionAtr(30, ANCHOR)).toBe(0);
  });

  it("rejects ATR supplied as a percent instead of a fraction", () => {
    // 1.5 == 150% of price.
    expect(normalizeProjectionAtr(1.5, ANCHOR)).toBe(0);
  });

  it("accepts exactly the bound and rejects a hair above it", () => {
    const bound = ANCHOR * MAX_ATR_FRACTION_OF_PRICE;
    expect(normalizeProjectionAtr(bound, ANCHOR)).toBe(bound);
    expect(normalizeProjectionAtr(bound * 1.0001, ANCHOR)).toBe(0);
  });

  it("accepts the engine's own 1%-of-price fallback (signals.py:1057)", () => {
    // The AI engine substitutes `close * 0.01` when a candle's atr is missing.
    // That must still render an envelope rather than being rejected as bogus.
    const fallback = ANCHOR * 0.01;
    expect(fallback).toBeLessThan(ANCHOR * MAX_ATR_FRACTION_OF_PRICE);
    expect(normalizeProjectionAtr(fallback, ANCHOR)).toBe(fallback);
  });

  it("degrades to a flat line rather than fabricating geometry", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, ""]) {
      expect(normalizeProjectionAtr(bad, ANCHOR)).toBe(0);
    }
  });

  it("refuses to validate against a missing reference price", () => {
    // No reference == no way to know the units. Returning the raw value would
    // reintroduce exactly the bug the guard exists to stop.
    for (const badRef of [0, -1, Number.NaN, undefined, null]) {
      expect(normalizeProjectionAtr(0.0011, badRef)).toBe(0);
    }
  });
});

describe("the guard actually prevents the ceiling spike", () => {
  const frame = (atr: number) =>
    buildTargetFrame({
      liveTipBucketSec: 1_700_000_000,
      timeframeSec: 60,
      intervals: 3,
      liveClose: ANCHOR,
      target: ANCHOR * 1.002,
      atr,
      signal: "BUY",
      tier: "T2",
    });

  it("renders no wick above a sane fraction of price for a rejected ATR", () => {
    const safe = normalizeProjectionAtr(30, ANCHOR); // pips -> rejected
    const candles = frame(safe);
    expect(candles).toHaveLength(3);
    for (const c of candles) {
      // A flat line: high === low === the body's extreme.
      expect(c.high).toBeCloseTo(Math.max(c.open, c.close), 12);
      expect(c.low).toBeCloseTo(Math.min(c.open, c.close), 12);
    }
  });

  it("keeps a healthy ATR's wick well under the chart ceiling", () => {
    const candles = frame(normalizeProjectionAtr(0.0011, ANCHOR));
    const top = Math.max(...candles.map((c) => c.high));
    // Never within 25% of price of the top of the scale.
    expect(top).toBeLessThan(ANCHOR * 1.25);
  });

  it("still terminates exactly on the target at expiry", () => {
    // The guard must suppress the envelope, never the trajectory.
    const candles = frame(normalizeProjectionAtr(30, ANCHOR));
    expect(candles[candles.length - 1].close).toBeCloseTo(ANCHOR * 1.002, 10);
  });
});

describe("clampTargetToAnchor", () => {
  it("passes a plausible intraday target through unchanged", () => {
    // +0.2% on a 1.1 anchor — an ordinary short-horizon target.
    expect(clampTargetToAnchor(1.1022, ANCHOR)).toBeCloseTo(1.1022, 10);
  });

  it("rejects a stale target left over from another symbol", () => {
    // BTC-scale target against an FX anchor: the classic stale-payload spike.
    expect(clampTargetToAnchor(64000, ANCHOR)).toBe(0);
  });

  it("rejects a target beyond the deviation band in either direction", () => {
    const bound = ANCHOR * MAX_TARGET_DEVIATION_FRACTION;
    expect(clampTargetToAnchor(ANCHOR + bound * 1.01, ANCHOR)).toBe(0);
    expect(clampTargetToAnchor(ANCHOR - bound * 1.01, ANCHOR)).toBe(0);
    // exactly at the band edge is allowed
    expect(clampTargetToAnchor(ANCHOR + bound, ANCHOR)).toBeCloseTo(
      ANCHOR + bound,
      10,
    );
  });

  it("refuses to judge a target without a valid anchor", () => {
    for (const bad of [0, -1, Number.NaN, undefined, null]) {
      expect(clampTargetToAnchor(1.102, bad)).toBe(0);
    }
  });

  it("rejects a non-positive or non-finite target", () => {
    for (const bad of [0, -1.1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(clampTargetToAnchor(bad, ANCHOR)).toBe(0);
    }
  });

  it("draws NO projection for a runaway target, rather than a clipped spike", () => {
    // This is the reported defect: a target far off the tape's visible range is
    // DRAWN and CLIPPED at the container top because the series opts out of
    // autoscale. Rejecting it upstream means the corrupt geometry is never built.
    const target = clampTargetToAnchor(64000, ANCHOR);
    const candles = buildTargetFrame({
      liveTipBucketSec: 1_700_000_000,
      timeframeSec: 60,
      intervals: 3,
      liveClose: ANCHOR,
      target,
      atr: 0,
      signal: "BUY",
      tier: "T2",
    });
    expect(candles).toEqual([]);
  });

  it("still builds a real projection for a valid target", () => {
    const candles = buildTargetFrame({
      liveTipBucketSec: 1_700_000_000,
      timeframeSec: 60,
      intervals: 3,
      liveClose: ANCHOR,
      target: clampTargetToAnchor(ANCHOR * 1.002, ANCHOR),
      atr: 0,
      signal: "BUY",
      tier: "T2",
    });
    expect(candles).toHaveLength(3);
    for (const c of candles) {
      // Every projected value must stay in the neighbourhood of the anchor, or
      // it would be drawn off-scale and clipped.
      expect(c.high).toBeLessThan(ANCHOR * (1 + MAX_TARGET_DEVIATION_FRACTION));
      expect(c.low).toBeGreaterThan(ANCHOR * (1 - MAX_TARGET_DEVIATION_FRACTION));
    }
  });
});
