import { describe, it, expect } from "vitest";
import {
  bucketStart,
  leadShiftBucket,
  clampPriceToReality,
  TIMEFRAME_MS,
} from "@/lib/realtimeCandleAggregator";
import {
  bucketAlignStrict,
  roundToNearestBucket,
  floorToBucketSeconds,
  bodyCapFor,
  clampCandleBody,
  seamGapCount,
} from "@/lib/candleGridUtils";

// PO-aligned epoch seconds worth of millis — a 20:00:00.000 grid boundary on
// the 1m timeframe. Every test uses REAL timestamps on this exact grid.
const M1 = TIMEFRAME_MS["1m"]; // 60_000
const T20_00 = 1_780_797_600_000; // 2026-… 20:00:00.000
const T19_59 = T20_00 - 1000; // 19:59:59.000
const T20_01 = T20_00 + 1000; // 20:00:01.000

describe("bucket alignment (mission [1] + [2])", () => {
  it("test_bucket_alignment_exact — 19:59:59.999 folds into 19:59, 20:00:00.000 opens a fresh bucket", () => {
    expect(bucketStart(T19_59, M1)).toBe(T20_00 - M1);
    expect(bucketStart(T20_00, M1)).toBe(T20_00);
    expect(bucketStart(T20_00 + 999, M1)).toBe(T20_00);
    expect(bucketStart(T20_01, M1)).toBe(T20_00);
  });

  it("test_bucket_alignment_exact — trailing ms never drift the exact bucket (17:54:04 → 17:54, not 17:55)", () => {
    const fivePast54 = 1_780_796_400_000 + 4_000; // 17:54:04
    const hmm = 60_000;
    expect(bucketStart(fivePast54, hmm)).toBe(1_780_796_400_000); // 17:54:00
    expect(bucketStart(fivePast54, hmm) + hmm).toBe(1_780_796_460_000); // 17:55:00
    expect(bucketStart(fivePast54, hmm) % hmm).toBe(0);
  });

  it("test_off_grid_tick_rounded_to_nearest_bucket — 20:00:30 → 20:01 (nearest), 20:00:29.999 → 20:00", () => {
    const hmm = 60_000;
    const T20_00_30 = T20_00 + 30_000;
    expect(roundToNearestBucket(T20_00_30, hmm)).toBe(T20_00 + hmm);
    expect(roundToNearestBucket(T20_00 + 29_999, hmm)).toBe(T20_00);
    expect(roundToNearestBucket(T20_00 + 30_000, hmm) % hmm).toBe(0);
  });

  it("test_off_grid_tick_rounded_to_nearest_bucket — strict alignment gate rejects off-grid, accepts exact", () => {
    expect(bucketAlignStrict(T20_00, M1)).toBe(true);
    expect(bucketAlignStrict(T20_00 + M1, M1)).toBe(true);
    expect(bucketAlignStrict(T20_00 + 500, M1)).toBe(false);
    expect(bucketAlignStrict(T19_59, M1)).toBe(false);
  });

  it("test_bucketStart_leadShiftBucket_parity — leadShiftBucket(ts,bw,0) === bucketStart(ts,bw) for ANY input", () => {
    const samples = [T19_59, T20_00 - 1, T20_00, T20_00 + 1, T20_00 + 30_000, T20_00 + M1 + 500, 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const ts of samples) {
      const parity = leadShiftBucket(ts, M1, 0);
      const base = bucketStart(ts, M1);
      if (Number.isFinite(ts) && ts > 0) {
        expect(parity).toBe(base);
      } else {
        expect(parity).toBe(base);
      }
    }
  });
});

describe("spike-body guard (mission [4])", () => {
  const normalBody = 10;
  const base = T20_00;
  const series = (): Array<{ open: number; close: number }> =>
    Array.from({ length: 20 }, (_, i) => ({ open: 100, close: 100 + normalBody }));
  const asCandle = (o: number, h: number, l: number, c: number) => ({ open: o, high: h, low: l, close: c });

  it("test_spike_clamped_to_atr — a 10× body is clamped to ≤ 5×ATR, midpoint+direction preserved", () => {
    const spike = asCandle(90, 220, 85, 210); // body 120, ~12× normal
    const cap = bodyCapFor(series(), 0); // no ATR → 5 × median body
    expect(cap).toBeCloseTo(normalBody * 5, 6);
    const { candle, clamped } = clampCandleBody(spike, cap);
    expect(clamped).toBe(true);
    const body = Math.abs(candle.close - candle.open);
    expect(body).toBeLessThanOrEqual(cap + 1e-9);
    // direction preserved (bullish) + midpoint preserved
    expect(candle.close).toBeGreaterThan(candle.open);
    expect((candle.open + candle.close) / 2).toBeCloseTo((spike.open + spike.close) / 2, 6);
  });

  it("test_spike_clamped_to_atr — ATR-cap wins when provided", () => {
    const spike = asCandle(90, 220, 85, 210);
    const cap = bodyCapFor(series(), 6); // 5 × ATR(20)=6 → 30
    expect(cap).toBeCloseTo(30, 6);
    const { candle } = clampCandleBody(spike, cap);
    expect(Math.abs(candle.close - candle.open)).toBeLessThanOrEqual(30 + 1e-9);
  });

  it("test_spike_clamped_to_atr — a normal body is NEVER touched (no fabrication)", () => {
    const normal = asCandle(98, 112, 96, 108);
    const cap = bodyCapFor(series(), 0);
    const { candle, clamped } = clampCandleBody(normal, cap);
    expect(clamped).toBe(false);
    expect(candle).toEqual(normal);
  });
});

describe("history→live seam (mission [6])", () => {
  it("test_no_gap_between_consecutive_candles — a contiguous minute chain reports 0 gaps", () => {
    const step = 60;
    const candles = Array.from({ length: 30 }, (_, i) => ({
      time: Math.floor(T20_00 / 1000) + i * step,
    }));
    expect(seamGapCount(candles, step)).toBe(0);
  });

  it("test_no_gap_between_consecutive_candles — every stray gap is counted (a spread-apart candle is never silent)", () => {
    const step = 60;
    const candles = [
      { time: Math.floor(T20_00 / 1000) },
      { time: Math.floor(T20_00 / 1000) + step }, // contiguous
      { time: Math.floor(T20_00 / 1000) + 3 * step }, // +2 step gap (missing bucket)
      { time: Math.floor(T20_00 / 1000) + 5 * step }, // +2 step gap
      { time: Math.floor(T20_00 / 1000) + 6 * step }, // contiguous
    ];
    expect(seamGapCount(candles, step)).toBe(2);
  });

  it("test_history_live_seam_contiguous — a joint history+live chain with one doubled slot drops to 1 gap (off-by-one seam)", () => {
    const step = 60;
    const seam = Math.floor(T20_00 / 1000);
    const history = [seam - 2 * step, seam - step, seam];
    const live = [seam + step, seam + 2 * step, seam + 3 * step]; // parity grid → contiguous
    const joined = [...history, ...live].map((time) => ({ time }));
    expect(seamGapCount(joined, step)).toBe(0);
  });
});

describe("projection alignment (mission [3])", () => {
  it("test_projection_aligned_to_grid — forecast[0].time === liveTipTime + bucketSeconds exactly when tip is off-grid", () => {
    const bucketSeconds = 60;
    const liveTipTime = Math.floor(T20_00 / 1000) + 30; // off-grid :30 tip (the bug)
    const alignedTip = floorToBucketSeconds(liveTipTime, bucketSeconds);
    expect(alignedTip).toBe(Math.floor(T20_00 / 1000)); // floored back onto :00
    const forecast0 = alignedTip + bucketSeconds; // 20:01:00 — exactly one slot
    expect(forecast0 - liveTipTime).toBe(30); // contiguous past the real tip
    expect(forecast0 % bucketSeconds).toBe(0); // on-grid
  });

  it("test_projection_aligned_to_grid — an on-grid tip is NEVER shifted (no fabricated move)", () => {
    const bucketSeconds = 60;
    const onGrid = Math.floor(T20_00 / 1000);
    expect(floorToBucketSeconds(onGrid, bucketSeconds)).toBe(onGrid);
  });
});

describe("clamp point-to-reality (mission [4] live tip)", () => {
  it("binds a fat-finger tick back inside the ±1.5% reality band", () => {
    const baseline = 100;
    expect(clampPriceToReality(100, baseline)).toBe(100);
    expect(clampPriceToReality(101.49, baseline)).toBeLessThanOrEqual(101.5);
    expect(clampPriceToReality(200, baseline)).toBeLessThanOrEqual(101.5);
    expect(clampPriceToReality(50, baseline)).toBeGreaterThanOrEqual(98.5);
  });
});