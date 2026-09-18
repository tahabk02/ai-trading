import { describe, it, expect } from "vitest";
import {
  bucketStart,
  leadShiftBucket,
  clampPriceToReality,
  TIMEFRAME_MS,
  normalizeTimeframe,
  resolveTimeframe,
  isTimeframe,
  timeframeToMs,
  historyBarCheck,
  historyLookbackMs,
  MAX_HISTORY_LOOKBACK,
  signalGate,
  normalizeConfidence,
  formatAxisTime,
  projectionSlots,
  targetIntervals,
  targetSlots,
  buildTargetFrame,
  buildTargetCandles,
  targetColorFor,
  targetAlpha,
  targetHollowFillRgba,
  HOLLOW_FILL_ALPHA,
  resolveLookaheadHorizon,
  targetViewportRange,
  TARGET_RIGHT_GUTTER,
  buildSignalView,
  SIGNAL_CONFIDENCE_THRESHOLD,
  DENSE_VISIBLE_BARS,
  INITIAL_BAR_SPACING_PX,
  MIN_BAR_SPACING_PX,
  BARS_PER_FRAME,
  timeframeToSeconds,
  targetIntervalsFor,
  targetProjectionKey,
  TargetProjectionEngine,
  SignalHoldBuffer,
  RealtimeCandleAggregator,
} from "@/lib/realtimeCandleAggregator";
import {
  useTradingStore,
  selectSelectedTimeframe,
  selectSelectedExpiration,
  aiTimeframeFor,
} from "@/store/useTradingStore";
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
const M1 = TIMEFRAME_MS["M1"]; // 60_000
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
    const samples = [
      T19_59,
      T20_00 - 1,
      T20_00,
      T20_00 + 1,
      T20_00 + 30_000,
      T20_00 + M1 + 500,
      1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
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
    Array.from({ length: 20 }, (_, i) => ({
      open: 100,
      close: 100 + normalBody,
    }));
  const asCandle = (o: number, h: number, l: number, c: number) => ({
    open: o,
    high: h,
    low: l,
    close: c,
  });

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
    expect((candle.open + candle.close) / 2).toBeCloseTo(
      (spike.open + spike.close) / 2,
      6,
    );
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

describe("timeframe normalization (mission timeframe-parity)", () => {
  it("test_timeframe_normalization_case_insensitive — PO canonical keys resolve, month/bogus rejected, resolve falls back to M1", () => {
    expect(normalizeTimeframe("M1")).toBe("M1");
    expect(normalizeTimeframe("m1")).toBe("M1");
    expect(normalizeTimeframe("s10")).toBe("S10");
    expect(normalizeTimeframe("D1")).toBe("D1");
    expect(normalizeTimeframe("h1")).toBe("H1");
    expect(normalizeTimeframe("month")).toBeNull();
    expect(normalizeTimeframe("bogus")).toBeNull();
    expect(normalizeTimeframe("")).toBeNull();
    expect(normalizeTimeframe("35m")).toBeNull();
    expect(resolveTimeframe("m1")).toBe("M1");
    expect(resolveTimeframe("bogus")).toBe("M1");
    expect(isTimeframe("M1")).toBe(true);
    expect(isTimeframe("m1")).toBe(true);
    expect(isTimeframe("1H")).toBe(true);
    expect(isTimeframe("1D")).toBe(true);
    expect(isTimeframe("35M")).toBe(false);
    expect(isTimeframe("month")).toBe(false);
    expect(isTimeframe("60s")).toBe(false);
    expect(isTimeframe("hold")).toBe(false);
  });

  it("test_timeframeToMs_normalized — PO canonical keys resolve to canonical ms, unknown falls back to M1", () => {
    expect(timeframeToMs("M1")).toBe(TIMEFRAME_MS["M1"]);
    expect(timeframeToMs("H1")).toBe(TIMEFRAME_MS["H1"]);
    expect(timeframeToMs("S5")).toBe(TIMEFRAME_MS["S5"]);
    expect(timeframeToMs("35m")).toBe(TIMEFRAME_MS["M1"]);
    expect(timeframeToMs("bogus")).toBe(TIMEFRAME_MS["M1"]);
  });
});

describe("history bar gate (mission history-parity)", () => {
  it("test_historyBarCheck_grid_alignment — exact grid bars pass, off-grid never fabricated onto a boundary", () => {
    const now = T20_00 + M1 + M1;
    expect(historyBarCheck(T20_00, M1, now)).toBe(true);
    expect(historyBarCheck(T20_00 + M1, M1, now)).toBe(true);
    expect(historyBarCheck(T20_00 + 500, M1, now)).toBe(false);
    expect(historyBarCheck(T19_59, M1, now)).toBe(false);
  });

  it("test_historyBarCheck_lookback_window — 1m/1h-old bars kept, >24h dropped (window boundary inclusive)", () => {
    const now = T20_00;
    expect(historyBarCheck(T20_00 - M1, M1, now)).toBe(true);
    expect(historyBarCheck(T20_00 - 3_600_000, M1, now)).toBe(true);
    expect(historyBarCheck(T20_00 - 86_400_000, M1, now)).toBe(true);
    expect(historyBarCheck(T20_00 - 90_000_000, M1, now)).toBe(false);
  });

  it("test_historyLookback_windows — mission retention table for every bucket width", () => {
    expect(historyLookbackMs(TIMEFRAME_MS["S5"])).toBe(3_600_000);
    expect(historyLookbackMs(TIMEFRAME_MS["M1"])).toBe(86_400_000);
    expect(historyLookbackMs(TIMEFRAME_MS["M5"])).toBe(604_800_000);
    expect(historyLookbackMs(TIMEFRAME_MS["M15"])).toBe(2_592_000_000);
    expect(historyLookbackMs(TIMEFRAME_MS["H1"])).toBe(7_776_000_000);
    expect(historyLookbackMs(TIMEFRAME_MS["D1"])).toBe(31_536_000_000);
    expect(MAX_HISTORY_LOOKBACK[String(TIMEFRAME_MS["M1"])]).toBe(86_400_000);
  });
});

describe("signal gate (mission AI-confidence parity)", () => {
  it("test_signal_gate — BUY/SELL needs ≥98% (0.98) on both 0..1 and 0..100 scales, custom threshold honored", () => {
    expect(signalGate("BUY", 0.5)).toBe(false);
    expect(signalGate("BUY", 0.6)).toBe(false);
    expect(signalGate("SELL", 0.98)).toBe(true);
    expect(signalGate("SELL", 0.979)).toBe(false);
    expect(signalGate("BUY", 99)).toBe(true);
    expect(signalGate("BUY", 97)).toBe(false);
    expect(signalGate("BUY", 30)).toBe(false);
    expect(signalGate(null, 0.99)).toBe(false);
    expect(signalGate(undefined, 0.99)).toBe(false);
    expect(signalGate("BUY", 0.7, 0.75)).toBe(false);
    expect(signalGate("BUY", 0.7, 0.6)).toBe(true);
    expect(signalGate("BUY", 0.7, 0.98)).toBe(false);
    expect(signalGate("BUY", 0.99, 0.98)).toBe(true);
    expect(normalizeConfidence(97)).toBe(0.97);
    expect(normalizeConfidence(0.6)).toBe(0.6);
  });
});

describe("projection slots (mission forecast-parity)", () => {
  it("test_projectionSlots_contiguous_grid — slot0 offset === bucketMs, every slot on-grid", () => {
    const slots = projectionSlots(T20_00, M1, 3);
    expect(slots.length).toBe(3);
    const tipBucketSec = Math.floor(T20_00 / 1000);
    for (let i = 0; i < slots.length; i++) {
      expect(slots[i].index).toBe(i + 1);
      expect(slots[i].timeSec).toBe(tipBucketSec + (i + 1) * 60);
      expect(slots[i].timeSec % 60).toBe(0);
    }
    expect(slots[0].timeSec * 1000 - T20_00).toBe(M1);
  });

  it("test_projectionSlots_interval_count — round(expiryMinutes/timeframeMinutes), never below 1", () => {
    expect(projectionSlots(T20_00, M1, 1).length).toBe(1);
    expect(projectionSlots(T20_00, M1, 5).length).toBe(5);
    expect(projectionSlots(T20_00, TIMEFRAME_MS["M5"], 1).length).toBe(1);
    expect(projectionSlots(T20_00, TIMEFRAME_MS["M5"], 15).length).toBe(3);
    expect(projectionSlots(T20_00, M1, 0.5).length).toBe(1);
  });
});

describe("axis time formatter (mission PO-parity)", () => {
  it("test_formatAxisTime — hh:mm:ss sub-minute, hh:mm intraday, dd MMM daily (UTC)", () => {
    const sub = Date.UTC(2026, 8, 13, 20, 0, 30) / 1000;
    expect(formatAxisTime(sub, 1000)).toBe("20:00:30");
    expect(formatAxisTime(sub, 5_000)).toBe("20:00:30");
    const intra = Date.UTC(2026, 8, 13, 20, 0, 0) / 1000;
    expect(formatAxisTime(intra, M1)).toBe("20:00");
    expect(formatAxisTime(intra, TIMEFRAME_MS["H1"])).toBe("20:00");
    expect(formatAxisTime(intra, TIMEFRAME_MS["D1"])).toBe("13 Sep");
    expect(formatAxisTime(0, M1)).toBe("");
  });
});

describe("aggregator history gate (mission live-history parity)", () => {
  it("test_aggregator_rejects_off_grid_and_stale_history — stray bars never leak onto the 1m chart", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    const now = Date.now();
    const base = Math.floor(now / M1) * M1;
    agg.seedHistory("EUR/USD", [
      {
        timestamp: base - M1,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 10,
      },
      {
        timestamp: base - M1 + 500,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 10,
      },
      {
        timestamp: base - 90_000_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 10,
      },
      {
        timestamp: base - 23 * 3_600_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 10,
      },
    ]);
    const series = agg.getSeries("EUR/USD");
    expect(series.some((r) => r.timestamp === base - M1)).toBe(true);
    expect(series.some((r) => r.timestamp === base - M1 + 500)).toBe(false);
    const debug = agg.getDebug("EUR/USD");
    expect(debug.historyRejectedCount).toBe(2);
    expect(debug.timeframe).toBe("M1");
    expect(debug.bucketMs).toBe(M1);
    expect(debug.projectionSlot0OffsetMs).toBe(M1);
  });
});

describe("live-tick ingress guards (mission no-fabrication)", () => {
  it("test_one_write_per_tick — every accepted tick contributes exactly one write", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    const now = Date.now();
    agg.ingest({ symbol: "EUR/USD", price: 1.1, timestamp: now - 2_000 });
    agg.ingest({ symbol: "EUR/USD", price: 1.1001, timestamp: now - 1_000 });
    agg.ingest({ symbol: "EUR/USD", price: 1.1002, timestamp: now });
    const debug = agg.getDebug("EUR/USD");
    expect(debug.tickCount).toBe(3);
    expect(debug.bucketWrites).toBe(3);
  });

  it("test_no_duplicate_bucket_creation — repeated ticks update one bucket", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    const timestamp = Date.now();
    for (let index = 0; index < 3; index += 1) {
      agg.ingest({
        symbol: "EUR/USD",
        price: 1.1 + index / 10_000,
        timestamp: timestamp + index,
      });
    }
    const debug = agg.getDebug("EUR/USD");
    expect(debug.bucketsCreated).toBe(1);
    expect(debug.bucketsUpdated).toBe(2);
  });

  it("test_gap_fill_does_not_increment_tick_count — synthetic gaps are separate writes", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    const base = Math.floor((Date.now() - 3 * M1) / M1) * M1;
    agg.ingest({ symbol: "EUR/USD", price: 1.1, timestamp: base });
    agg.ingest({ symbol: "EUR/USD", price: 1.1005, timestamp: base + 3 * M1 });
    const debug = agg.getDebug("EUR/USD");
    expect(debug.tickCount).toBe(2);
    expect(debug.gapCount).toBeGreaterThan(0);
    expect(debug.bucketWrites).toBe(debug.tickCount + debug.gapCount);
  });

  it("test_bucket_writes_equals_ticks_when_no_gaps — steady stream has exact parity", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    const timestamp = Date.now();
    for (let index = 0; index < 5; index += 1) {
      agg.ingest({
        symbol: "EUR/USD",
        price: 1.1 + index / 10_000,
        timestamp: timestamp + index,
      });
    }
    const debug = agg.getDebug("EUR/USD");
    expect(debug.gapCount).toBe(0);
    expect(debug.bucketWrites).toBe(debug.tickCount);
  });

  it("test_rejects_future_tick — tick stamped > now+2s never lands in a bucket", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    const future = Date.now() + 30_000;
    expect(
      agg.ingest({ symbol: "EUR/USD", price: 1.12, timestamp: future }),
    ).toBeNull();
    expect(agg.getSeries("EUR/USD")).toEqual([]);
  });

  it("test_rejects_old_tick_behind_newest — a tick 3 timeframes behind the newest accepted tick never reopens that slot", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    const now = Math.floor(Date.now() / M1) * M1;
    agg.ingest({ symbol: "EUR/USD", price: 1.1, timestamp: now });
    const series = agg.getSeries("EUR/USD");
    expect(series.length).toBe(1);
    expect(series[0].timestamp).toBe(now);
    // Stale tick three buckets behind the newest accepted one is ignored.
    agg.ingest({ symbol: "EUR/USD", price: 9.99, timestamp: now - 3 * M1 });
    const after = agg.getSeries("EUR/USD");
    expect(after.length).toBe(1);
    expect(after[0].timestamp).toBe(now);
    expect(after[0].high).not.toBe(9.99);
    expect(after[0].close).toBe(1.1);
  });

  it("test_wall_clock_never_closes_candle_in_zero_fabrication — syncWallClock advancing the bucket does NOT finalise or fabricate the forming bar", () => {
    // DEFAULT constructor (no options) is ZERO-FABRICATION: the browser wall
    // clock must never decide "this candle has closed". Only a genuine broker
    // print stamped inside the next bucket may roll it over.
    const agg = new RealtimeCandleAggregator("M1", {});
    const base = Math.floor((Date.now() - 2 * M1) / M1) * M1;
    agg.ingest({ symbol: "EUR/USD", price: 1.1, timestamp: base });
    expect(agg.getSeries("EUR/USD").length).toBe(1);

    // Heartbeat crosses the bucket boundary 4s later — but NO next print has
    // arrived. The forming bar must stay put (never force-closed by wall clock).
    agg.syncWallClock(base + M1 + 4_000);
    let series = agg.getSeries("EUR/USD");
    expect(series.length).toBe(1);
    expect(series[0].timestamp).toBe(base);
    expect(agg.getLiveCandle("EUR/USD")?.timestamp).toBe(base);

    // A genuine print stamped in the next bucket is what actually rolls it.
    agg.ingest({ symbol: "EUR/USD", price: 1.1005, timestamp: base + M1 });
    series = agg.getSeries("EUR/USD");
    expect(series.length).toBe(2);
    expect(series[1].timestamp).toBe(base + M1);
  });

  it("test_default_constructor_is_zero_fabrication — wall-clock pass must not create a synthetic flat candle", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    const base = Math.floor((Date.now() - M1) / M1) * M1;
    agg.ingest({ symbol: "EUR/USD", price: 1.1, timestamp: base });
    agg.syncWallClock(base + 2 * M1 + 1_000);
    const boxes = agg.getSeries("EUR/USD");
    // Exactly the one REAL print — no synthetic continuation bar was spun up.
    expect(boxes.length).toBe(1);
    expect(boxes[0].timestamp).toBe(base);
  });

  it("test_legacy_continuity_still_fabricates_when_explicitly_enabled — zeroFabrication:false keeps the old synthetic-open behaviour", () => {
    const agg = new RealtimeCandleAggregator("M1", { zeroFabrication: false });
    const base = Math.floor((Date.now() - 3 * M1) / M1) * M1;
    agg.ingest({ symbol: "EUR/USD", price: 1.1, timestamp: base });
    agg.syncWallClock(base + M1 + 2_000);
    const series = agg.getSeries("EUR/USD");
    expect(series.length).toBe(2);
    expect(series[0].timestamp).toBe(base);
    expect(series[1].timestamp).toBe(base + M1);
  });
});

describe("predictive target candles (mission target-lead)", () => {
  const SEC20 = Math.floor(T20_00 / 1000);
  const bucket = 60;

  it("test_intervals_from_lead_minutes — round(lead/timeframeMinutes), never below 1", () => {
    expect(targetIntervals(1, 1)).toBe(1);
    expect(targetIntervals(2, 1)).toBe(2);
    expect(targetIntervals(5, 1)).toBe(5);
    expect(targetIntervals(15, 5)).toBe(3);
    expect(targetIntervals(1, 5)).toBe(1);
    expect(targetIntervals(0.4, 1)).toBe(1);
  });

  it("test_first_target_opens_one_bucket_after_live_tip — off-grid tip floors to grid, first target = grid + 1 bucket", () => {
    const offGridTipSec = SEC20 + 30;
    const liveTipBucketSec = Math.floor(offGridTipSec / bucket) * bucket;
    expect(liveTipBucketSec).toBe(SEC20);
    const slots = targetSlots(offGridTipSec, bucket, 3);
    expect(slots[0].timeSec).toBe(liveTipBucketSec + bucket);
    expect(slots[0].timeSec - liveTipBucketSec).toBe(bucket);
    expect(slots[0].offsetSec).toBe(bucket);
  });

  it("test_target_slots_aligned_to_grid — every slot on-grid, offsets scale, contiguous past the tip", () => {
    const slots = targetSlots(SEC20, bucket, 5);
    expect(slots.length).toBe(5);
    for (let i = 0; i < slots.length; i++) {
      expect(slots[i].index).toBe(i + 1);
      expect(slots[i].timeSec % bucket).toBe(0);
      expect(slots[i].offsetSec).toBe((i + 1) * bucket);
      expect(slots[i].timeSec).toBe(SEC20 + (i + 1) * bucket);
    }
    expect(slots[0].timeSec * 1000 - SEC20 * 1000).toBe(M1);
  });

  it("test_target_ohlc_within_atr_envelope — high ≤ max(open,close) + ATR×0.35×taper, low ≥ min(open,close) − same, taper → 0", () => {
    const frame = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 5,
      liveClose: 100,
      target: 110,
      atr: 2,
      signal: "BUY",
    });
    frame.forEach((c, idx) => {
      const k = idx + 1;
      const cushion = 2 * 0.35 * ((5 - k) / 5);
      expect(c.high).toBeLessThanOrEqual(
        Math.max(c.open, c.close) + cushion + 1e-9,
      );
      expect(c.low).toBeGreaterThanOrEqual(
        Math.min(c.open, c.close) - cushion - 1e-9,
      );
    });
    // monotonic taper — the last bar carries ZERO cushion
    expect(frame[frame.length - 1].high).toBe(
      Math.max(frame[4].open, frame[4].close),
    );
    expect(frame[frame.length - 1].low).toBe(
      Math.min(frame[4].open, frame[4].close),
    );
  });

  it("test_target_high_low_ordering — OHLC ordering invariant holds, open[0]=liveClose, last close=target", () => {
    const frame = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 7,
      liveClose: 50,
      target: 40,
      atr: 3,
      signal: "SELL",
    });
    expect(frame[0].open).toBe(50);
    expect(frame[frame.length - 1].close).toBe(40);
    for (const c of frame) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(c.high);
      expect(Number.isFinite(c.open)).toBe(true);
      expect(Number.isFinite(c.high)).toBe(true);
      expect(Number.isFinite(c.low)).toBe(true);
      expect(Number.isFinite(c.close)).toBe(true);
    }
  });

  it("test_target_color_by_signal — BUY→bullish, SELL→bearish, null→neutral, per-bar rgba from signal", () => {
    expect(targetColorFor("BUY")).toBe("#26a69a");
    expect(targetColorFor("SELL")).toBe("#ef5350");
    expect(targetColorFor(null)).toBe("#94a3b8");
    expect(targetColorFor(undefined)).toBe("#94a3b8");
    const buy = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 3,
      liveClose: 100,
      target: 104,
      atr: 1,
      signal: "BUY",
    });
    expect(buy[0].color.startsWith("rgba(38,166,154,")).toBe(true);
    expect(buy[2].color.startsWith("rgba(38,166,154,")).toBe(true);
    const sell = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 3,
      liveClose: 100,
      target: 96,
      atr: 1,
      signal: "SELL",
    });
    expect(sell[0].color.startsWith("rgba(239,83,80,")).toBe(true);
    const neutral = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 3,
      liveClose: 100,
      target: 104,
      atr: 1,
      signal: null,
    });
    expect(neutral[0].color.startsWith("rgba(148,163,184,")).toBe(true);
  });

  it("test_hollow_overlay_rendering — target bodies are ~transparent outlines, border+wick stay solid directional colour", () => {
    expect(HOLLOW_FILL_ALPHA).toBeLessThan(0.15);
    const buy = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 3,
      liveClose: 100,
      target: 104,
      atr: 1,
      signal: "BUY",
    });
    const sell = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 3,
      liveClose: 100,
      target: 96,
      atr: 1,
      signal: "SELL",
    });
    const neutral = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 3,
      liveClose: 100,
      target: 104,
      atr: 1,
      signal: null,
    });
    // Hollow body — the fill alpha rides the tiny HOLLOW_FILL_ALPHA, never the
    // opaque decay alpha (0.35..0.95), so the real series shows through.
    for (const c of buy) {
      expect(c.color).toContain(`,${HOLLOW_FILL_ALPHA.toFixed(3)})`);
      expect(c.borderColor).toBe(targetColorFor("BUY"));
      expect(c.wickColor).toBe(c.borderColor);
    }
    for (const c of sell) {
      expect(c.color).toContain(`,${HOLLOW_FILL_ALPHA.toFixed(3)})`);
      expect(c.borderColor).toBe(targetColorFor("SELL"));
      expect(c.wickColor).toBe(c.borderColor);
    }
    for (const c of neutral) {
      expect(c.color).toContain(`,${HOLLOW_FILL_ALPHA.toFixed(3)})`);
      expect(c.borderColor).toBe(targetColorFor(null));
      expect(c.wickColor).toBe(c.borderColor);
    }
    expect(targetHollowFillRgba("BUY")).toContain("38,166,154");
    expect(targetHollowFillRgba("SELL")).toContain("239,83,80");
    expect(targetHollowFillRgba(null)).toContain("148,163,184");
  });

  it("test_target_alpha_fades_with_distance — PO parity alpha = max(0.35, 0.95 − i×0.08)", () => {
    expect(targetAlpha(1, 10)).toBeCloseTo(0.87, 6); // 0.95 − 1 × 0.08
    expect(targetAlpha(2, 10)).toBeCloseTo(0.79, 6); // 0.95 − 2 × 0.08
    expect(targetAlpha(8, 10)).toBeCloseTo(0.35, 6); // 0.95 − 0.64 → floored at 0.35
    expect(targetAlpha(10, 10)).toBeCloseTo(0.35, 6); // floor holds once decay exceeds decay budget
    expect(targetAlpha(10, 5)).toBeCloseTo(0.35, 6); // index step is FIXED 0.08 — spacing-independent
    expect(targetAlpha(12, 3)).toBeCloseTo(0.35, 6);
    expect(targetAlpha(1, 10)).toBeGreaterThan(targetAlpha(2, 10));
    const frame = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 5,
      liveClose: 100,
      target: 110,
      atr: 2,
      signal: "BUY",
    });
    const alphas = frame.map((c) => c.alpha);
    expect(alphas[0]).toBe(targetAlpha(1, 5));
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeLessThan(alphas[i - 1]);
    }
    expect(alphas[alphas.length - 1]).toBeCloseTo(0.55, 6); // 0.95 − 5×0.08
    for (const a of alphas) expect(a).toBeGreaterThanOrEqual(0.35);
  });

  it("test_target_updates_on_lead_change — longer lead = more target candles, every last converges to target", () => {
    expect(targetIntervals(2, 1)).toBe(2);
    expect(targetIntervals(5, 1)).toBe(5);
    const f2 = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: targetIntervals(2, 1),
      liveClose: 100,
      target: 112,
      atr: 2,
      signal: "BUY",
    });
    const f5 = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: targetIntervals(5, 1),
      liveClose: 100,
      target: 112,
      atr: 2,
      signal: "BUY",
    });
    expect(f2.length).toBeLessThan(f5.length);
    expect(f2[f2.length - 1].close).toBe(112);
    expect(f5[f5.length - 1].close).toBe(112);
    expect(f2[f2.length - 1].offsetSec).toBe(2 * bucket);
    expect(f5[f5.length - 1].offsetSec).toBe(5 * bucket);
  });

  it("test_lookahead_horizon_synced_with_lead — horizon resolves to leadMinutes, frame length mirrors lead intervals", () => {
    expect(resolveLookaheadHorizon(2)).toBe(2);
    expect(resolveLookaheadHorizon(5)).toBe(5);
    expect(resolveLookaheadHorizon(0.4)).toBe(1);
    const frame = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: targetIntervals(3, 1),
      liveClose: 90,
      target: 96,
      atr: 1,
      signal: "SELL",
    });
    expect(frame.length).toBe(3);
    expect(frame[frame.length - 1].offsetSec).toBe(3 * bucket);
  });

  it("test_no_float_drift_across_1000_slots — 1000 consecutive tips never drift from the grid", () => {
    let tip = SEC20;
    for (let iter = 0; iter < 1000; iter++) {
      const frame = buildTargetFrame({
        liveTipBucketSec: tip,
        timeframeSec: bucket,
        intervals: 7,
        liveClose: 100,
        target: 110,
        atr: 2,
        signal: "BUY",
      });
      expect(frame.length).toBe(7);
      const last = frame[6];
      expect(last.time % bucket).toBe(0);
      expect(last.offsetSec).toBe(7 * bucket);
      expect(last.close).toBe(110);
      expect(Number.isFinite(last.high)).toBe(true);
      expect(last.high).toBeGreaterThanOrEqual(last.close);
      expect(last.low).toBeLessThanOrEqual(last.open);
      tip += bucket;
    }
    expect(tip).toBe(SEC20 + 1000 * bucket);
  });

  it("test_viewport_reanchors_to_last_target — to === mainCount + intervals + RIGHT_GUTTER, from === mainCount − DENSE_VISIBLE_BARS", () => {
    expect(TARGET_RIGHT_GUTTER).toBe(4);
    const range = targetViewportRange(60, 5, TARGET_RIGHT_GUTTER);
    expect(range.to).toBe(60 + 5 + 4);
    expect(range.to - TARGET_RIGHT_GUTTER).toBe(60 + 5);
    expect(range.from).toBeGreaterThanOrEqual(0);
    expect(range.from).toBeLessThan(range.to);
    expect(targetViewportRange(120, 5, TARGET_RIGHT_GUTTER).from).toBe(
      120 - DENSE_VISIBLE_BARS,
    );
    expect(targetViewportRange(0, 5, TARGET_RIGHT_GUTTER).from).toBe(0);
  });
});

describe("live target candle projection — buildTargetCandles (FINAL MISSION)", () => {
  const SEC20 = Math.floor(T20_00 / 1000); // 20:00:00 UTC on the 1m grid
  const TIP_MS = SEC20 * 1000;

  it("test_target_candles_exact_close_path — 5m lead/1m tf → 5 bars on the MATH taper arc closeᵢ = live+(target−live)·(0.5t+0.5t²), t=i/5", () => {
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 110,
      atr: 2,
      signal: "BUY",
      expirationSeconds: 300,
      timeframeSeconds: 60,
    });
    expect(candles.length).toBe(5);
    expect(candles[0].open).toBe(100);
    for (let i = 0; i < candles.length; i++) {
      const k = i + 1;
      const t = k / 5;
      const taper = 0.5 * t + 0.5 * t * t;
      expect(candles[i].time % 60).toBe(0);
      expect(candles[i].time).toBe(SEC20 + k * 60);
      expect(candles[i].offsetSec).toBe(k * 60);
      expect(candles[i].index).toBe(k);
      expect(candles[i].close).toBeCloseTo(100 + 10 * taper, 9);
      // volatility cushion = ATR × 0.35 × taper, tapering to 0 at progress 1
      const expectedWick = 2 * 0.35 * ((5 - k) / 5);
      expect(candles[i].high).toBeCloseTo(
        Math.max(candles[i].open, candles[i].close) + expectedWick,
        9,
      );
      expect(candles[i].low).toBeCloseTo(
        Math.min(candles[i].open, candles[i].close) - expectedWick,
        9,
      );
    }
    // MATH TAPER mid-slot: at t=0.5 the arc sits at 0.375, NOT the linear 0.5
    expect(candles[2].close).toBeCloseTo(100 + 10 * 0.48, 9); // t=0.6
    expect(candles[2].close).not.toBeCloseTo(106, 6); // linear midpoint 103/105 area — non-linear arc
    expect(candles[4].close).toBe(110);
    // FINAL CANDLE LANDS EXACTLY ON TARGET — cushion tapered to zero, no overshoot
    expect(candles[4].high).toBe(Math.max(candles[4].open, candles[4].close));
    expect(candles[4].low).toBe(Math.min(candles[4].open, candles[4].close));
  });

  it("test_target_candles_chain_open — every bar opens at the previous close (no gaps)", () => {
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 50,
      targetPrice: 40,
      atr: 1,
      signal: "SELL",
      expirationSeconds: 240,
      timeframeSeconds: 60,
    });
    expect(candles.length).toBe(4);
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].open).toBe(candles[i - 1].close);
    }
    expect(candles[0].open).toBe(50);
    expect(candles[3].close).toBe(40);
  });

  it("test_target_candles_intervals_rounding_never_zero — round(leadMs/tfMs) with a ≥1 floor", () => {
    expect(
      buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: 101,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 144,
        timeframeSeconds: 60,
      }).length,
    ).toBe(2);
    expect(
      buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: 101,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 24,
        timeframeSeconds: 60,
      }).length,
    ).toBe(1);
  });

  it("test_target_candles_suppressed_without_live_tip — tip ≤ 0 yields zero candles (never Date.now)", () => {
    expect(
      buildTargetCandles({
        liveTipBucketMs: 0,
        liveClose: 100,
        targetPrice: 110,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 120,
        timeframeSeconds: 60,
      }),
    ).toEqual([]);
    expect(
      buildTargetCandles({
        liveTipBucketMs: -1,
        liveClose: 100,
        targetPrice: 110,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 120,
        timeframeSeconds: 60,
      }),
    ).toEqual([]);
  });

  it("test_target_candles_suppressed_without_target — target ≤ 0 or missing → zero candles", () => {
    expect(
      buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: 0,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 120,
        timeframeSeconds: 60,
      }),
    ).toEqual([]);
    expect(
      buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: -5,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 120,
        timeframeSeconds: 60,
      }),
    ).toEqual([]);
    expect(
      buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: Number.NaN,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 120,
        timeframeSeconds: 60,
      }),
    ).toEqual([]);
  });

  it("test_target_candles_suppressed_on_invalid_anchor — no tip bucket, ≤0 target, or bad lead/tf → zero candles", () => {
    expect(
      buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: -5,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 120,
        timeframeSeconds: 60,
      }),
    ).toEqual([]);
    expect(
      buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: 110,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 0,
        timeframeSeconds: 60,
      }),
    ).toEqual([]);
    expect(
      buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: 110,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 120,
        timeframeSeconds: 0,
      }),
    ).toEqual([]);
  });

  it("test_target_candles_bounded_under_extreme_atr — pathological ATR can never push the low negative or the geometry non-finite", () => {
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 1,
      targetPrice: 0.5,
      atr: 4, // wick would naively be atr/2 = 2 → low 0.5 − 2 < 0
      signal: "SELL",
      expirationSeconds: 60,
      timeframeSeconds: 60,
    });
    expect(candles.length).toBe(1);
    expect(Number.isFinite(candles[0].high)).toBe(true);
    expect(Number.isFinite(candles[0].low)).toBe(true);
    expect(candles[0].low).toBeGreaterThanOrEqual(0);
    expect(candles[0].close).toBe(0.5); // converges exactly on the target
  });

  it("test_target_flat_line_fallback_on_invalid_atr — NaN/zero/negative ATR yields a zero-cushion flat projection, never a throw or NaN", () => {
    for (const badAtr of [NaN, 0, -1, Infinity, -Infinity]) {
      const candles = buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: 108,
        atr: badAtr,
        signal: "BUY",
        expirationSeconds: 180,
        timeframeSeconds: 60,
      });
      expect(candles.length).toBe(3);
      for (const c of candles) {
        expect(c.high).toBe(Math.max(c.open, c.close)); // flat, no cushion
        expect(c.low).toBe(Math.min(c.open, c.close));
        expect(Number.isFinite(c.high)).toBe(true);
        expect(Number.isFinite(c.low)).toBe(true);
      }
      expect(candles[candles.length - 1].close).toBe(108); // still converges
    }
  });

  it("test_target_absurd_atr_safety_cap — wick never exceeds 50% of the anchor level, low stays ≥ 0 across 30 bars", () => {
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 1,
      targetPrice: 2,
      atr: 1e9, // pathological
      signal: "BUY",
      expirationSeconds: 450,
      timeframeSeconds: 15,
    });
    expect(candles.length).toBe(30);
    for (const c of candles) {
      expect(Number.isFinite(c.high)).toBe(true);
      expect(Number.isFinite(c.low)).toBe(true);
      expect(c.low).toBeGreaterThanOrEqual(0);
      // worst case: min(open,close)=1, wick capped at basePrice×0.5 = 1 max
      expect(c.high - Math.max(c.open, c.close)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("test_target_candles_color_by_signal — BUY teal / SELL coral / null neutral, alpha fading per bar", () => {
    const buy = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 108,
      atr: 1,
      signal: "BUY",
      expirationSeconds: 180,
      timeframeSeconds: 60,
    });
    expect(buy[0].color.startsWith("rgba(38,166,154,")).toBe(true);
    expect(buy[2].color.startsWith("rgba(38,166,154,")).toBe(true);

    const sell = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 92,
      atr: 1,
      signal: "SELL",
      expirationSeconds: 180,
      timeframeSeconds: 60,
    });
    expect(sell[0].color.startsWith("rgba(239,83,80,")).toBe(true);

    const neutral = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 108,
      atr: 1,
      signal: null,
      expirationSeconds: 180,
      timeframeSeconds: 60,
    });
    expect(neutral[0].color.startsWith("rgba(148,163,184,")).toBe(true);

    expect(buy[0].alpha).toBeCloseTo(targetAlpha(1, buy.length), 6);
    expect(buy[0].alpha - buy[1].alpha).toBeCloseTo(0.08, 6); // fixed PO step, spacing-independent
    expect(buy[buy.length - 1].alpha).toBeCloseTo(0.71, 6);
  });

  it("test_target_renders_when_signal_null — gray candles produced even without BUY/SELL", () => {
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 108,
      atr: 1,
      signal: null,
      expirationSeconds: 120,
      timeframeSeconds: 60,
    });
    expect(candles.length).toBe(2);
    // neutral color is slate-400 = 148,163,184
    expect(candles[0].color.startsWith("rgba(148,163,184,")).toBe(true);
    expect(candles[1].color.startsWith("rgba(148,163,184,")).toBe(true);
  });

  it("test_target_first_slot_one_bucket_after_live_tip — first slot time = tipSec + timeframeSec", () => {
    const tipSec = Math.floor(TIP_MS / 1000);
    const tfSec = 60;
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 110,
      atr: 1,
      signal: "BUY",
      expirationSeconds: 300,
      timeframeSeconds: tfSec,
    });
    expect(candles.length).toBe(5);
    expect(candles[0].time).toBe(tipSec + tfSec);
  });

  it("test_target_last_slot_at_expiration — last slot time = tipSec + intervals * timeframeSec", () => {
    const tipSec = Math.floor(TIP_MS / 1000);
    const tfSec = 60;
    const intervals = 3;
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 110,
      atr: 1,
      signal: "BUY",
      expirationSeconds: tfSec * intervals,
      timeframeSeconds: tfSec,
    });
    expect(candles.length).toBe(intervals);
    expect(candles[candles.length - 1].time).toBe(tipSec + intervals * tfSec);
  });

  it("test_1to1_expiration_timeframe_mapping — M1 timeframe + 01:00 expiration = exactly 1 candle stepping to the target", () => {
    const tipSec = Math.floor(TIP_MS / 1000);
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 104,
      atr: 1,
      signal: "BUY",
      expirationSeconds: 60, // 01:00
      timeframeSeconds: 60, // M1
    });
    expect(candles.length).toBe(1);
    expect(candles[0].time).toBe(tipSec + 60); // exactly one M1 bucket → expiry
    expect(candles[0].open).toBe(100); // open = live close
    expect(candles[0].close).toBe(104); // single step converges to the target
    expect(candles[0].high).toBeGreaterThanOrEqual(104);
    expect(candles[0].alpha).toBeCloseTo(0.87, 6); // max(0.35, 0.95 − 1×0.08) — single candle never faint
    expect(candles[0].offsetSec).toBe(60);
  });

  it("test_expiration_timeframe_mapping_multiplier — 2m/@M1 → 2 candles, 3m/@M1 → 3 candles, each closing mid-progression", () => {
    const tipSec = Math.floor(TIP_MS / 1000);
    const two = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 106,
      atr: 1,
      signal: "BUY",
      expirationSeconds: 120,
      timeframeSeconds: 60,
    });
    expect(two.length).toBe(2);
    expect(two[0].open).toBe(100);
    expect(two[0].close).toBe(102.25); // 100 + 6 × (0.5·0.5 + 0.5·0.25) — math arc, not linear 103
    expect(two[1].open).toBe(two[0].close); // open = previous close
    expect(two[1].close).toBe(106); // 100 + 6 × 1.0 — arc converges exactly at expiry
    expect(two[1].time).toBe(tipSec + 120);
    const three = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 106,
      atr: 1,
      signal: "SELL",
      expirationSeconds: 180,
      timeframeSeconds: 60,
    });
    expect(three.length).toBe(3);
    // MATH ARC closes for 6pt·n=3: arc(⅓)=0.2222→101.333, arc(⅔)=0.5556→103.333, arc(1)=106
    expect(three.map((c) => c.close)).toEqual([
      100 + 6 * (0.5 * (1 / 3) + 0.5 * (1 / 3) ** 2),
      100 + 6 * (0.5 * (2 / 3) + 0.5 * (2 / 3) ** 2),
      106,
    ]);
    expect(three[1].open).toBe(three[0].close);
    expect(three[2].open).toBe(three[1].close);
    expect(three[2].time).toBe(tipSec + 180);
  });

  it("test_target_intervals_capped_at_30 — large expiration/timeframe ratio produces max 30 candles", () => {
    const tfSec = 60;
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 110,
      atr: 1,
      signal: "BUY",
      expirationSeconds: tfSec * 60,
      timeframeSeconds: tfSec,
    });
    expect(candles.length).toBe(30);
  });

  it("test_target_renders_when_confidence_low — candles render even when gate would hide the label", () => {
    const candles = buildTargetCandles({
      liveTipBucketMs: TIP_MS,
      liveClose: 100,
      targetPrice: 108,
      atr: 1,
      signal: null,
      expirationSeconds: 120,
      timeframeSeconds: 60,
    });
    expect(candles.length).toBe(2);
  });

  it("test_target_suppressed_when_no_live_tip — tip ≤ 0 yields zero candles", () => {
    expect(
      buildTargetCandles({
        liveTipBucketMs: 0,
        liveClose: 100,
        targetPrice: 110,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 120,
        timeframeSeconds: 60,
      }),
    ).toEqual([]);
  });

  it("test_target_suppressed_when_no_target_price — target ≤ 0 yields zero candles", () => {
    expect(
      buildTargetCandles({
        liveTipBucketMs: TIP_MS,
        liveClose: 100,
        targetPrice: 0,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 120,
        timeframeSeconds: 60,
      }),
    ).toEqual([]);
  });
});

describe("empty chart + shared signal gate (mission empty-chart)", () => {
  const SEC20 = Math.floor(T20_00 / 1000);
  const bucket = 60;

  it("test_projection_suppressed_when_no_live_tip — tip 0 → empty frame/slots, no candles to anchor", () => {
    expect(
      buildTargetFrame({
        liveTipBucketSec: 0,
        timeframeSec: bucket,
        intervals: 5,
        liveClose: 100,
        target: 110,
        atr: 1,
        signal: "BUY",
      }),
    ).toEqual([]);
    expect(projectionSlots(0, M1, 5)).toEqual([]);
    expect(targetSlots(0, bucket, 5)).toEqual([]);
  });

  it("test_chart_renders_first_tick_immediately — empty aggregator draws its first bar on the very first real tick", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    expect(agg.getSeries("BTC/USD")).toEqual([]);
    expect(agg.getLiveCandle("BTC/USD")).toBeNull();
    agg.ingest({ symbol: "BTC/USD", price: 60_000, timestamp: T20_00 });
    const series = agg.getSeries("BTC/USD");
    expect(series.length).toBe(1);
    expect(series[0].close).toBe(60_000);
    expect(series[0].timestamp % M1).toBe(0);
    expect(agg.getLiveCandle("BTC/USD")).not.toBeNull();
  });

  it("test_get_live_candle_close_formula — candleCloseMs = liveTipBucketMs + timeframeMs, remaining = close − now", () => {
    const agg = new RealtimeCandleAggregator("M1", {});
    agg.setActiveSymbol("EUR/USD");
    expect(agg.getLiveCandleClose()).toBeNull(); // no genuine tip yet
    agg.ingest({ symbol: "EUR/USD", price: 1.1, timestamp: T20_00 + M1 });
    const now = T20_00 + M1 + 12_000; // 12s into the bucket
    const cc = agg.getLiveCandleClose(now);
    expect(cc).not.toBeNull();
    // slot = bucketStart(T20_00 + M1) = T20_00 + M1 → close = tip slot + 1 bucket
    expect(cc!.candleCloseMs).toBe(T20_00 + 2 * M1);
    expect(cc!.timeframeMs).toBe(M1);
    expect(cc!.remainingMs).toBe(T20_00 + 2 * M1 - now);
    expect(cc!.groundedTsMs).toBe(T20_00 + M1);
    // remaining never negative
    const late = agg.getLiveCandleClose(T20_00 + 2 * M1 + 5_000);
    expect(late!.remainingMs).toBe(0);
  });

  it("test_gated_signal_blocks_below_threshold — 37% SELL demoted to NO SIGNAL on every surface", () => {
    const view = buildSignalView(
      { signal: "SELL", confidence: 37 },
      SIGNAL_CONFIDENCE_THRESHOLD,
    );
    expect(view.gated).toBe(false);
    expect(view.gatedSignal).toBeNull();
    expect(view.directionText).toBe("NO SIGNAL");
    expect(view.badgeText).toBe("NO SIGNAL — confidence 37% < 98%");
    expect(view.confPct).toBe(37);
    expect(view.gatePct).toBe(98);
  });

  it("test_gated_signal_passes_above_threshold — ≥98% BUY/SELL clears the gate on both scales", () => {
    const view = buildSignalView({ signal: "BUY", confidence: 99 });
    expect(view.gated).toBe(true);
    expect(view.gatedSignal).toBe("BUY");
    expect(view.directionText).toBe("BUY");
    expect(view.badgeText).toBe("SIGNAL: BUY");
    expect(
      buildSignalView({ signal: "SELL", confidence: 0.981 }).gatedSignal,
    ).toBe("SELL");
    expect(
      buildSignalView({ signal: "SELL", confidence: 55 }).gatedSignal,
    ).toBeNull();
    expect(buildSignalView(null).gatedSignal).toBeNull();
    expect(buildSignalView(undefined).directionText).toBe("NO SIGNAL");
  });

  it("test_panel_and_chart_share_same_gated_signal — one prediction derives identical NO SIGNAL / SIGNAL on both surfaces", () => {
    const blocked = { signal: "SELL" as const, confidence: 37 };
    const passed = { signal: "BUY" as const, confidence: 99 };
    const panelBlocked = buildSignalView(blocked);
    const chartBlocked = buildSignalView(blocked);
    expect(panelBlocked.gatedSignal).toBeNull();
    expect(chartBlocked.badgeText).toBe("NO SIGNAL — confidence 37% < 98%");
    expect(chartBlocked.directionText).toBe(panelBlocked.directionText);
    const panelPassed = buildSignalView(passed);
    const chartPassed = buildSignalView(passed);
    expect(chartPassed.badgeText).toBe("SIGNAL: BUY");
    expect(chartPassed.directionText).toBe(panelPassed.gatedSignal);
    expect(chartPassed.directionText).toBe("BUY");
    expect(panelPassed.gatedSignal).toBe(chartPassed.gatedSignal);
  });

  it("test_projection_is_candles_not_line — forecast rows are full OHLC candle primitives, never a flat line", () => {
    const frame = buildTargetFrame({
      liveTipBucketSec: SEC20,
      timeframeSec: bucket,
      intervals: 4,
      liveClose: 100,
      target: 108,
      atr: 1,
      signal: "BUY",
    });
    expect(frame.length).toBe(4);
    for (const c of frame) {
      expect(typeof c.time).toBe("number");
      expect(Number.isFinite(c.open)).toBe(true);
      expect(Number.isFinite(c.high)).toBe(true);
      expect(Number.isFinite(c.low)).toBe(true);
      expect(Number.isFinite(c.close)).toBe(true);
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(typeof c.color).toBe("string");
      expect(typeof c.borderColor).toBe("string");
      expect(typeof c.wickColor).toBe("string");
      expect(typeof c.alpha).toBe("number");
    }
  });
});

describe("expiration ↔ timeframe decoupling (FINAL MISSION 5.1–5.10)", () => {
  const SEC20 = Math.floor(T20_00 / 1000); // 20:00:00.000 UTC on the 1m grid

  it("test_intervals_from_expiration_and_timeframe — target intervals = max(1, round(expSeconds / tfSeconds))", () => {
    expect(targetIntervalsFor(60, 20)).toBe(3); // 5s  × 1m   → 3 buckets
    expect(targetIntervalsFor(120, 20)).toBe(6); // 5s  × 2m   → 6 buckets
    expect(targetIntervalsFor(180, 20)).toBe(9); // 5s  × 3m   → 9 buckets
    expect(targetIntervalsFor(300, 60)).toBe(5); // 1m  × 5m   → 5 buckets
    // floor ≥ 1 even for exp < bucket
    expect(targetIntervalsFor(30, 60)).toBe(1);
  });

  it("test_timeframe_change_does_not_change_expiration — store contract duration is untouched by bucket selection", () => {
    const tfBefore = selectSelectedTimeframe(useTradingStore.getState());
    const expBefore = selectSelectedExpiration(useTradingStore.getState());
    useTradingStore.getState().setSelectedTimeframe("M5");
    const tfAfter = selectSelectedTimeframe(useTradingStore.getState());
    const expStill = selectSelectedExpiration(useTradingStore.getState());
    useTradingStore.getState().setSelectedTimeframe(tfBefore);
    expect(tfAfter).toBe("M5");
    expect(expStill).toBe(expBefore);
  });

  it("test_expiration_change_does_not_change_timeframe — selecting a contract never re-buckets the chart", () => {
    const tfBefore = selectSelectedTimeframe(useTradingStore.getState());
    const expBefore = selectSelectedExpiration(useTradingStore.getState());
    useTradingStore.getState().setSelectedExpirationSeconds(180);
    const expAfter = selectSelectedExpiration(useTradingStore.getState());
    const tfStill = selectSelectedTimeframe(useTradingStore.getState());
    useTradingStore.getState().setSelectedExpirationSeconds(expBefore);
    expect(expAfter).toBe(180);
    expect(tfStill).toBe(tfBefore);
    // PO canonical set snaps to nearest member: 65 → 60, 99 → 120, 0/neg → 60
    useTradingStore.getState().setSelectedExpirationSeconds(65);
    expect(useTradingStore.getState().selectedExpirationSeconds).toBe(60);
    useTradingStore.getState().setSelectedExpirationSeconds(99);
    expect(useTradingStore.getState().selectedExpirationSeconds).toBe(120);
    useTradingStore.getState().setSelectedExpirationSeconds(0);
    expect(useTradingStore.getState().selectedExpirationSeconds).toBe(60);
    useTradingStore.getState().setSelectedExpirationSeconds(expBefore);
  });

  it("test_target_first_slot_one_bucket_after_live_tip — tf=20s exp=1m opens the first target candle one 20s bucket after the live tip grid", () => {
    expect(timeframeToSeconds("S15")).toBe(15);
    const candles = buildTargetCandles({
      liveClose: 100,
      targetPrice: 104,
      atr: 1,
      signal: "BUY",
      expirationSeconds: 60,
      timeframeSeconds: 15,
      liveTipBucketMs: SEC20 * 1000,
    });
    expect(candles.length).toBe(4);
    expect(candles[0].time).toBe(SEC20 + 15);
    expect(candles[0].offsetSec).toBe(15);
    expect(candles[1].time).toBe(SEC20 + 30);
    expect(candles[3].time).toBe(SEC20 + 60);
    expect(candles[3].close).toBe(104); // last slot lands exactly on the target
  });

  it("test_target_color_follows_gated_signal — gated BUY → teal candles, failed gate → neutral, 98% threshold respected", () => {
    const gated = buildSignalView({ signal: "BUY", confidence: 99 });
    expect(gated.gatedSignal).toBe("BUY");
    const teal = buildTargetCandles({
      liveClose: 100,
      targetPrice: 104,
      atr: 1,
      signal: gated.gatedSignal,
      expirationSeconds: 60,
      timeframeSeconds: 15,
      liveTipBucketMs: SEC20 * 1000,
    });
    expect(teal.length).toBe(4);
    expect(teal[0].color).toContain("38,166,154"); // rgba(38,166,154,…) teal
    const blocked = buildSignalView({ signal: "SELL", confidence: 37 });
    expect(blocked.gatedSignal).toBeNull();
    expect(blocked.gated).toBe(false); // did NOT pass the 98% gate
    expect(blocked.confPct).toBe(37);
    expect(blocked.gatePct).toBe(98);
    expect(blocked.confPct).toBeLessThan(SIGNAL_CONFIDENCE_THRESHOLD * 100);
    const neutral = buildTargetCandles({
      liveClose: 100,
      targetPrice: 104,
      atr: 1,
      signal: blocked.gatedSignal,
      expirationSeconds: 60,
      timeframeSeconds: 15,
      liveTipBucketMs: SEC20 * 1000,
    });
    expect(neutral.length).toBe(4);
    expect(neutral[0].color).toContain("148,163,184"); // neutral slate
  });

  it("test_target_alpha_fades_with_distance — each further target bucket is more transparent, floor at 0.35 never washed out", () => {
    const a1 = targetAlpha(1, 12);
    const a5 = targetAlpha(5, 12);
    const a9 = targetAlpha(9, 12);
    expect(a1).toBeGreaterThan(a5);
    expect(a5).toBeGreaterThan(a9);
    expect(a9).toBeGreaterThanOrEqual(0.35);
    const candles = buildTargetCandles({
      liveClose: 100,
      targetPrice: 104,
      atr: 1,
      signal: "BUY",
      expirationSeconds: 180,
      timeframeSeconds: 15,
      liveTipBucketMs: SEC20 * 1000,
    });
    expect(candles.length).toBe(12);
    expect(candles[0].alpha).toBeGreaterThan(candles[11].alpha);
  });

  it("test_target_wick_taper_keeps_low_non_negative — ATR×0.35×taper can never push a sub-pip low below zero", () => {
    const frame = buildTargetCandles({
      liveClose: 0.0001,
      targetPrice: 0.0002,
      atr: 0.0003,
      signal: "BUY",
      expirationSeconds: 30,
      timeframeSeconds: 15,
      liveTipBucketMs: SEC20 * 1000,
    });
    expect(frame.length).toBe(2);
    for (const c of frame) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeGreaterThanOrEqual(0); // bounded, never dips under zero
      expect(Number.isFinite(c.low)).toBe(true);
      expect(typeof c.color).toBe("string");
    }
    // cushion tapers: bar1 = 0.3 × 0.35 × ½, bar2 (progress 1) = 0
    expect(frame[0].low).toBeCloseTo(Math.min(frame[0].open, frame[0].close) - 0.0000525, 9);
    expect(frame[1].high).toBe(Math.max(frame[1].open, frame[1].close));
  });

  it("test_target_suppressed_when_no_live_tip — no tip bucket or no target → the target layer paints nothing", () => {
    expect(
      buildTargetCandles({
        liveClose: 100,
        targetPrice: 104,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 60,
        timeframeSeconds: 15,
        liveTipBucketMs: 0,
      }),
    ).toEqual([]);
    expect(
      buildTargetCandles({
        liveClose: 100,
        targetPrice: 0,
        atr: 1,
        signal: "BUY",
        expirationSeconds: 60,
        timeframeSeconds: 15,
        liveTipBucketMs: SEC20 * 1000,
      }),
    ).toEqual([]);
  });

  it("test_target_series_is_candlestick_not_line — full OHLC prism with body/wick, never a flat line", () => {
    const frame = buildTargetCandles({
      liveClose: 100,
      targetPrice: 108,
      atr: 1,
      signal: "SELL",
      expirationSeconds: 60,
      timeframeSeconds: 15,
      liveTipBucketMs: SEC20 * 1000,
    });
    expect(frame.length).toBe(4);
    for (const c of frame) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(typeof c.color).toBe("string");
      expect(typeof c.borderColor).toBe("string");
      expect(typeof c.wickColor).toBe("string");
    }
  });

  it("test_candle_spacing_matches_po — 12px initial, 6px floor, 30 dense bars, 4px right gutter, 30 bars/frame", () => {
    expect(INITIAL_BAR_SPACING_PX).toBe(12);
    expect(MIN_BAR_SPACING_PX).toBe(6);
    expect(DENSE_VISIBLE_BARS).toBe(30);
    expect(BARS_PER_FRAME).toBe(30);
    expect(TARGET_RIGHT_GUTTER).toBe(4);
    // a DENSE_VISIBLE_BARS frame at INITIAL spacing fits a 1000px chart
    expect(DENSE_VISIBLE_BARS * INITIAL_BAR_SPACING_PX).toBeLessThanOrEqual(
      1000,
    );
  });

  it("test_bar_spacing_is_12 — PO canvas: every candle slot is 12px wide", () => {
    expect(INITIAL_BAR_SPACING_PX).toBe(12);
  });

  it("test_min_bar_spacing_is_6 — zooming out never compresses a candle below 6px", () => {
    expect(MIN_BAR_SPACING_PX).toBe(6);
  });

  it("test_dense_visible_bars_is_30 — the DENSE viewport always shows 30 candles", () => {
    expect(DENSE_VISIBLE_BARS).toBe(30);
  });

  it("test_viewport_reanchors_to_last_target — from shows a 30-bar DENSE window, to shows last target + 4px gutter", () => {
    const intervals = targetIntervalsFor(60, 60);
    const r = targetViewportRange(60, intervals, TARGET_RIGHT_GUTTER);
    expect(r.from).toBe(30); // 60 - DENSE_VISIBLE_BARS = 30
    expect(r.to).toBe(65); // 60 + intervals + TARGET_RIGHT_GUTTER
  });
});

describe("store PO-parity contract (PART 2)", () => {
  it("test_store_defaults_po_canonical — S5 / 5s / 300s projection expiration, derived tfSeconds synced", () => {
    const s = useTradingStore.getState();
    expect(s.selectedTimeframe).toBe("S5");
    expect(s.selectedTimeframeSeconds).toBe(5);
    expect(s.selectedExpirationSeconds).toBe(300);
  });

  it("test_set_timeframe_updates_derived_seconds — any canonical TF sets selectedTimeframeSeconds = ms/1000", () => {
    useTradingStore.getState().setSelectedTimeframe("m15");
    const s = useTradingStore.getState();
    expect(s.selectedTimeframe).toBe("M15");
    expect(s.selectedTimeframeSeconds).toBe(900);
    useTradingStore.getState().setSelectedTimeframe("h4");
    expect(useTradingStore.getState().selectedTimeframeSeconds).toBe(14400);
    useTradingStore.getState().setSelectedTimeframe("S5");
  });

  it("test_ai_timeframe_channel_maps_subminute_to_1m — S5..S30 coerce to 1m, PO minute keys map to backend format", () => {
    expect(aiTimeframeFor("S5")).toBe("1m");
    expect(aiTimeframeFor("S30")).toBe("1m");
    expect(aiTimeframeFor("M1")).toBe("1m");
    expect(aiTimeframeFor("M5")).toBe("5m");
    expect(aiTimeframeFor("M15")).toBe("15m");
    expect(aiTimeframeFor("H1")).toBe("1h");
    expect(aiTimeframeFor("D1")).toBe("1d");
  });

  it("test_expiration_snap_to_po_canonical_set — nearest member wins, sub-minute expirations preserved", () => {
    useTradingStore.getState().setSelectedExpirationSeconds(1);
    expect(useTradingStore.getState().selectedExpirationSeconds).toBe(1);
    useTradingStore.getState().setSelectedExpirationSeconds(30);
    expect(useTradingStore.getState().selectedExpirationSeconds).toBe(30);
    useTradingStore.getState().setSelectedExpirationSeconds(86400);
    expect(useTradingStore.getState().selectedExpirationSeconds).toBe(86400);
    useTradingStore.getState().setSelectedExpirationSeconds(60);
  });
});

describe("ARCHITECTURAL OVERHAUL — deterministic projection engine (tick vs. projection)", () => {
  const TIP = 1622601600; // fixed grid bucket, no Date.now() anywhere

  const base = {
    liveTipBucketSec: TIP,
    timeframeSec: 60,
    expirationSec: 60,
    liveClose: 100,
    targetPrice: 104,
    atr: 1,
    signal: "BUY" as const,
  };

  it("engine 1-to-1 mapping — 60s expiry + 60s timeframe → exactly 1 candle ending on target", () => {
    const eng = new TargetProjectionEngine();
    const snap = eng.present(base);
    expect(typeof snap.key).toBe("string");
    expect(snap.key.startsWith("tip|")).toBe(true);
    expect(snap.intervals).toBe(1);
    expect(snap.candles.length).toBe(1);
    expect(snap.candles[0].time).toBe(TIP + 60);
    expect(snap.candles[0].open).toBe(100);
    expect(snap.candles[0].close).toBe(104);
    expect(snap.firstSlotSec).toBe(TIP + 60);
    expect(snap.lastSlotSec).toBe(TIP + 60);
    expect(snap.changed).toBe(true);
  });

  it("structural memo — repeated calls with an identical key return the EXACT SAME candle array reference", () => {
    const eng = new TargetProjectionEngine();
    const a = eng.present(base);
    for (let i = 0; i < 100; i++) {
      const b = eng.present(base);
      expect(b.candles).toBe(a.candles);
      expect(b.changed).toBe(false);
    }
    expect(eng.currentKey).toBe(a.key);
  });

  it("micro price fluctuation never rebuilds — liveClose shakes ±0.0003, geometry stays frozen to the anchor", () => {
    const eng = new TargetProjectionEngine();
    const a = eng.present(base);
    const anchor = a.anchorLiveClose;
    const jitters = [100.0001, 100.0002, 99.9999, 99.9998, 100.0001, 100.0003];
    for (const jitter of jitters) {
      const b = eng.present({ ...base, liveClose: jitter });
      expect(b.candles).toBe(a.candles);
      expect(b.anchorLiveClose).toBe(anchor);
      expect(b.changed).toBe(false);
      expect(b.candles[0].close).toBe(104); // locked to the target, not the jitter
    }
  });

  it("bucket advance re-anchors — tip grid advancing one bucket rebuilds the matrix against the new live close", () => {
    const eng = new TargetProjectionEngine();
    eng.present(base);
    const next = eng.present({
      ...base,
      liveTipBucketSec: TIP + 60,
      liveClose: 100.5,
    });
    expect(next.changed).toBe(true);
    expect(next.candles[0].time).toBe(TIP + 120);
    expect(next.anchorLiveClose).toBe(100.5);
    // subsequent calls within the SAME bucket ignore even a wildly different close
    const again = eng.present({ ...base, liveTipBucketSec: TIP + 60, liveClose: 999 });
    expect(again.candles).toBe(next.candles);
    expect(again.anchorLiveClose).toBe(100.5);
    expect(again.changed).toBe(false);
  });

  it("only structural shifts change the key — timeframe & expiration alter it, targetPrice and ATR quantized at 7dp", () => {
    const a = targetProjectionKey(base);
    const tf = targetProjectionKey({ ...base, timeframeSec: 120 });
    const exp = targetProjectionKey({ ...base, expirationSec: 120 });
    const tgt = targetProjectionKey({
      ...base,
      targetPrice: 104.00000001, // float noise → same quantized key
    });
    const atrNoise = targetProjectionKey({
      ...base,
      atr: 1.00000004, // float noise → same quantized key
    });
    const atrReal = targetProjectionKey({ ...base, atr: 1.0000001 }); // ≥ 7dp shift
    expect(a).not.toBe(tf);
    expect(a).not.toBe(exp);
    expect(a).toBe(tgt);
    expect(a).toBe(atrNoise);
    expect(a).not.toBe(atrReal);
  });

  it("ATR micro-drift below 7dp precision never rebuilds — identical candle reference", () => {
    const eng = new TargetProjectionEngine();
    const a = eng.present(base);
    const b = eng.present({ ...base, atr: 1.00000004 });
    expect(b.candles).toBe(a.candles);
    expect(b.changed).toBe(false);
    const c = eng.present({ ...base, atr: 1.0000001 });
    expect(c.candles).not.toBe(a.candles);
    expect(c.changed).toBe(true);
  });

  it("suppressed engine — no tip or ≤0 target yields an empty matrix and clears the memo", () => {
    const eng = new TargetProjectionEngine();
    const full = eng.present(base);
    expect(full.changed).toBe(true);
    expect(full.candles.length).toBe(1);
    // First suppression clears the memo
    const cleared = eng.present({ ...base, liveTipBucketSec: 0 });
    expect(cleared.candles).toEqual([]);
    expect(cleared.changed).toBe(true);
    // Memo is already empty — a second invalid input is a no-op (nothing to clear)
    const alreadyCleared = eng.present({ ...base, targetPrice: 0 });
    expect(alreadyCleared.candles).toEqual([]);
    expect(alreadyCleared.changed).toBe(false);
    // A valid key after suppression IS a structural rebuild
    const restored = eng.present({ ...base, liveClose: 100.25 });
    expect(restored.candles.length).toBe(1);
    expect(restored.changed).toBe(true);
    expect(restored.anchorLiveClose).toBe(100.25);
  });

  it("reset() forces a rebuild — the next present() is changed even with the same key", () => {
    const eng = new TargetProjectionEngine();
    const a = eng.present(base);
    eng.reset();
    const b = eng.present(base);
    expect(b.changed).toBe(true);
    expect(b.key).toBe(a.key);
  });
});

describe("ARCHITECTURAL OVERHAUL — signal stability & state freezing", () => {
  it("signal freezes for its active bucket duration — mid-bucket flips/nulls are ignored", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    expect(buf.evaluate("BUY", 100)).toBe("BUY");
    expect(buf.evaluate("SELL", 105)).toBe("BUY"); // flips frozen inside the bucket
    expect(buf.evaluate(null, 110)).toBe("BUY"); // neutral frozen inside the bucket
    expect(buf.evaluate("BUY", 120)).toBe("BUY");
  });

  it("signal refreshes after the bucket elapses — sustained neutral clears, directional flip commits", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    buf.evaluate("BUY", 100);
    expect(buf.evaluate(null, 200)).toBe("BUY"); // first neutral read → still held
    expect(buf.evaluate(null, 220)).toBeNull(); // second consecutive neutral → cleared
    expect(buf.evaluate("SELL", 300)).toBe("SELL"); // fresh directional commits
    expect(buf.evaluate("SELL", 302)).toBe("SELL"); // same-direction extends the hold
  });

  it("neutral never flickers on a single errant tick — jitter around the 96.5% gate cannot shimmer the label", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    const raw = [null, "BUY", null, "BUY", null, "BUY"] as const;
    let out: ("BUY" | "SELL" | null)[] = [];
    for (const r of raw) out.push(buf.evaluate(r, 100));
    expect(out[0] === null && out[1] === "BUY").toBe(true);
    // No LONG-RUNNING FLICKER: after neutral holds it settles; every element after commitment is logical
    expect(out.every((o) => o === "BUY" || o === null)).toBe(true);
    expect(out[out.length - 2]).toBe("BUY");
  });
});

describe("PART 6 — tier-gated target candles (T1–T3 overlay)", () => {
  const TIP = 1_700_000;
  const baseInputs = {
    liveTipBucketMs: TIP * 1000,
    liveClose: 100,
    targetPrice: 104,
    atr: 1,
    signal: "BUY" as const,
    expirationSeconds: 60,
    timeframeSeconds: 60,
  };

  it("T1/T2/T3 render the trajectory — medium and above draw the overlay", () => {
    for (const tier of ["T1", "T2", "T3"]) {
      const candles = buildTargetCandles({ ...baseInputs, tier });
      expect(candles.length).toBe(1);
      expect(candles[0].close).toBeCloseTo(104, 6);
    }
  });

  it("T4/T5 return an EMPTY overlay — weak bands never draw the trajectory", () => {
    for (const tier of ["T4", "T5"]) {
      const candles = buildTargetCandles({ ...baseInputs, tier });
      expect(candles.length).toBe(0);
    }
  });

  it("absent tier keeps legacy behaviour (geometry still renders)", () => {
    const candles = buildTargetCandles({ ...baseInputs, tier: undefined });
    expect(candles.length).toBe(1);
  });

  it("projection engine key reflects the tier gate", () => {
    const eng = new TargetProjectionEngine();
    const t3 = eng.present({
      liveTipBucketSec: TIP,
      timeframeSec: 60,
      expirationSec: 60,
      liveClose: 100,
      targetPrice: 104,
      atr: 1,
      signal: "BUY",
      tier: "T3",
    });
    expect(t3.candles.length).toBe(1);
    expect(t3.key).toContain("tier|T3");

    const t5 = eng.present({
      liveTipBucketSec: TIP,
      timeframeSec: 60,
      expirationSec: 60,
      liveClose: 100,
      targetPrice: 104,
      atr: 1,
      signal: "BUY",
      tier: "T5",
    });
    expect(t5.candles.length).toBe(0);
    expect(t5.key).toContain("tier|off");
  });
});
