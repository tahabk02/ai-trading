/**
 * expiryEngine.test.ts — deterministic expiry + strike/target vectors (PART 52).
 *
 * Asserts the backend derives REAL, non-null numeric endpoints from a real
 * tape, aligns expiries to timeframe boundaries, withholds (rather than mocks)
 * when the data is insufficient, and never fabricates a probability for a
 * zero-variance tape.
 */

import { describe, it, expect } from "vitest";
import {
  HORIZON_SECONDS,
  MIN_REGRESSION_SAMPLES,
  PROBABILITY_BASIS,
  alignExpiryMs,
  computePriceTargetVector,
  computeTargetStatus,
  computeTradeParameters,
  normalCdf,
  resolveHorizonSeconds,
  symbolPriceDigits,
} from "../expiryEngine";

const noisy = (
  n = 20,
  base = 1.1,
  step = 0.0001,
  amp = 0.00005,
): number[] =>
  Array.from({ length: n }, (_, i) => base + step * i + (i % 2 ? amp : -amp));

describe("horizon set + snapping", () => {
  it("is sub-minute capable", () => {
    expect([...HORIZON_SECONDS]).toEqual([5, 15, 30, 60, 300]);
  });

  it("accepts supported values and snaps others with floor bias", () => {
    for (const s of HORIZON_SECONDS) {
      expect(resolveHorizonSeconds(s)).toBe(s);
      expect(resolveHorizonSeconds(String(s))).toBe(s);
    }
    expect(resolveHorizonSeconds(45)).toBe(30);
    expect(resolveHorizonSeconds(4)).toBe(5);
    expect(resolveHorizonSeconds(0)).toBe(5);
    expect(resolveHorizonSeconds(null)).toBe(5);
    expect(resolveHorizonSeconds(400)).toBe(300);
  });
});

describe("expiry alignment", () => {
  it("preserves an entry already on a boundary", () => {
    expect(alignExpiryMs(0, 5)).toBe(5_000);
    expect(alignExpiryMs(5_000, 5)).toBe(10_000);
  });

  it("snaps forward to the next boundary", () => {
    expect(alignExpiryMs(1_000, 5)).toBe(10_000);
    expect(alignExpiryMs(59_000, 60)).toBe(120_000);
  });

  it("always lands on a horizon edge at/after entry + Δt", () => {
    for (const d of HORIZON_SECONDS) {
      for (const entry of [0, 1, 999, 1_234_567, 12_345_678]) {
        const exp = alignExpiryMs(entry, d);
        expect(exp % (d * 1000)).toBe(0);
        expect(exp).toBeGreaterThanOrEqual(entry + d * 1000);
      }
    }
  });

  it("rejects a non-positive delta", () => {
    expect(() => alignExpiryMs(0, 0)).toThrow(RangeError);
  });
});

describe("normalCdf", () => {
  it("is monotonic through the midpoint", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normalCdf(5)).toBeGreaterThan(normalCdf(1));
  });
});

describe("computePriceTargetVector", () => {
  it("returns real numeric endpoints from a real tape", () => {
    const closes = noisy();
    const v = computePriceTargetVector({
      closes,
      entryPrice: closes[closes.length - 1],
      horizonSeconds: 60,
      symbolDigits: 5,
    });
    expect(v.available).toBe(true);
    expect(typeof v.predictedEndPrice).toBe("number");
    expect(v.predictedEndPrice).not.toBe(v.entryPrice);
    expect(v.confidenceLower).toBeLessThan(v.confidenceUpper as number);
    expect(v.confidenceMargin).toBeGreaterThan(0);
    expect(v.holdProbability).toBeGreaterThanOrEqual(0);
    expect(v.holdProbability).toBeLessThanOrEqual(1);
    expect(v.probabilityBasis).toBe(PROBABILITY_BASIS);
    expect(v.samples).toBe(closes.length);
    expect(v.r2).toBeGreaterThan(0.9);
    expect(v.horizonSeconds).toBe(60);
  });

  it("honors an explicit direction", () => {
    const up = noisy();
    const sell = computePriceTargetVector({
      closes: up,
      entryPrice: up[up.length - 1],
      horizonSeconds: 30,
      direction: "SELL",
    });
    expect(sell.direction).toBe("SELL");
  });

  it("withholds (all-null) on a short tape", () => {
    const closes = [1.1, 1.1001, 1.1002];
    expect(closes.length).toBeLessThan(MIN_REGRESSION_SAMPLES);
    const v = computePriceTargetVector({
      closes,
      entryPrice: closes[closes.length - 1],
      horizonSeconds: 30,
    });
    expect(v.available).toBe(false);
    expect(v.reason).toBe("insufficient_history");
    expect(v.predictedEndPrice).toBeNull();
    expect(v.holdProbability).toBeNull();
    expect(v.probabilityBasis).toBeNull();
    expect(v.confidenceLower).toBeNull();
  });

  it("never fabricates a probability on a flat tape", () => {
    const v = computePriceTargetVector({
      closes: Array(20).fill(1.1),
      entryPrice: 1.1,
      horizonSeconds: 60,
    });
    expect(v.available).toBe(true);
    expect(v.predictedEndPrice).toBe(1.1);
    expect(v.holdProbability).toBeNull();
    expect(v.probabilityBasis).toBeNull();
  });

  it("withholds on an empty tape", () => {
    const v = computePriceTargetVector({ closes: [], horizonSeconds: 5 });
    expect(v.available).toBe(false);
    expect(v.samples).toBe(0);
    expect(v.predictedEndPrice).toBeNull();
  });
});

describe("computeTargetStatus", () => {
  it("classifies above/below/at the strike", () => {
    expect(computeTargetStatus(1.1005, 1.1)).toBe("ABOVE");
    expect(computeTargetStatus(1.0995, 1.1)).toBe("BELOW");
    expect(computeTargetStatus(1.1, 1.1)).toBe("AT");
    expect(computeTargetStatus(null, 1.1)).toBeNull();
    expect(computeTargetStatus(1.1, null)).toBeNull();
  });
});

describe("computeTradeParameters", () => {
  const entryMs = Date.parse("2026-10-14T12:00:00.000Z");

  it("produces entry/expiry timestamps on a boundary + strike status", () => {
    const tp = computeTradeParameters({
      entryMs,
      entryPrice: 1.1,
      livePrice: 1.1002,
      horizonSeconds: 60,
      direction: "BUY",
      predictedTargetPrice: 1.105,
      holdProbability: 0.72,
      probabilityBasis: PROBABILITY_BASIS,
    });
    expect(tp.entryTimestamp).toBe("2026-10-14T12:00:00.000Z");
    expect(tp.entryPrice).toBe(1.1);
    expect(Date.parse(tp.expiryTimestamp as string)).toBe(
      alignExpiryMs(entryMs, 60),
    );
    expect(tp.predictedTargetPrice).toBe(1.105);
    expect(tp.targetStatus).toBe("ABOVE");
    expect(tp.horizonSeconds).toBe(60);
    expect(tp.predictionVectors).toEqual({
      start_price: 1.1,
      predicted_end_price: 1.105,
      probability_score: 0.72,
      probability_basis: PROBABILITY_BASIS,
      direction: "BUY",
      horizon_seconds: 60,
    });
  });

  it("reports BELOW for a PUT target under the strike", () => {
    const tp = computeTradeParameters({
      entryMs,
      entryPrice: 1.1,
      livePrice: 1.1,
      horizonSeconds: 30,
      direction: "SELL",
      predictedTargetPrice: 1.098,
    });
    expect(tp.targetStatus).toBe("BELOW");
  });

  it("keeps null endpoints null and still normalizes the horizon", () => {
    const tp = computeTradeParameters({
      entryMs,
      entryPrice: null,
      livePrice: null,
      horizonSeconds: 45,
      direction: null,
      predictedTargetPrice: null,
    });
    expect(tp.horizonSeconds).toBe(30);
    expect(tp.predictedTargetPrice).toBeNull();
    expect(tp.targetStatus).toBeNull();
    expect(tp.predictionVectors.probability_score).toBeNull();
    expect(tp.predictionVectors.probability_basis).toBeNull();
  });

  it("nulls the timestamps when the entry time is missing", () => {
    const tp = computeTradeParameters({
      entryMs: null,
      entryPrice: 1.1,
      livePrice: 1.1,
      horizonSeconds: 5,
      predictedTargetPrice: 1.1005,
    });
    expect(tp.entryTimestamp).toBeNull();
    expect(tp.expiryTimestamp).toBeNull();
  });
});

describe("symbolPriceDigits", () => {
  it("maps asset classes to precision", () => {
    expect(symbolPriceDigits("BTC/USD")).toBe(2);
    expect(symbolPriceDigits("EUR/JPY")).toBe(3);
    expect(symbolPriceDigits("EUR/USD")).toBe(5);
  });
});
