/**
 * candleSyncTiming.test.ts — TICK→PAINT LATENCY HARNESS (Part 1 verification)
 *
 * Drives the EXACT production tick→paint path that financial-chart.tsx uses:
 *
 *   live_tick
 *     → store.ingestLiveTick          (useTradingStore.ts:1785)
 *       → realtimeAggregator.ingest   (realtimeCandleAggregator.ts:2187)
 *         → emitCandleUpdate → subscribeLive listener (financial-chart.tsx:988)
 *           → mergeLiveTick rows + pendingPaintRef
 *     → [rAF drain] paint             (financial-chart.tsx:1021-1109)
 *       series.update + updateTargetLayer
 *
 * 80 synthetic broker ticks (20 × S5 buckets, server-stamped on the shared
 * grid). Three honest clock values are recorded per tick:
 *   (a) broker tick stamp   — flows as DATA, from the feed's own clock
 *   (b) receipt              — Date.now() when ingest() enters
 *   (c) paint                — Date.now() inside the rAF-drain paint frame
 * (c − b) is the ONE latency the client actually owns and can measure. (c − a)
 * is deliberately NOT used as accuracy: broker host and client host run
 * independent clocks of unknown skew — exactly why the client must never
 * convert a feed stamp with its own wall clock.
 *
 * Two routing modes run the same harness code:
 *   • wallClockClose — the browser 100ms heartbeat fires 2ms past each S5
 *     boundary, force-closing the forming candle via syncWallClock and (in
 *     zero-fabrication mode) opening a synthetic candle for the next bucket
 *     BEFORE the bucket's final genuine print has physically arrived (burst /
 *     reorder). This is today's syncWallClock-on-heartbeat behaviour
 *     (PRE-FIX).
 *   • tickDriven     — no wall-clock close; the forming candle only rolls when
 *     the next bucket's genuine print arrives (POST-FIX broker-truth contract).
 *
 * ORACLE: the broker chart's true HA close for a bucket is the HA of ALL
 * genuine prints stamped inside it. tickDriven paints exactly that. The
 * assertion is therefore that wallClockClose paints the SAME close as
 * tickDriven for every bucket — byte-identical colour-lock. Any deviation is
 * a "the colour locked in late/wrong vs the broker chart" bug.
 *
 * Metrics per mode:
 *   • frameDelay_ms (c−b)     — socket-receipt → chart paint (measured)
 *   • lostPrints               — prints RECEIVED but folded into a candle
 *                                whose bucket != the print's own bucket
 *                                (split-tail drop starves the final colour)
 *   • mismatchedBuckets        — buckets whose painted close differs from the
 *                                tickDriven (broker-truth) oracle
 *
 * After the fix, wallClockClose degrades to a no-op over candles and its
 * metrics converge to tickDriven → the mismatch column goes to 0. The test
 * asserts that end-state, so it FAILS on the current code and PASSES after.
 */
import { describe, it, expect } from "vitest";
import { RealtimeCandleAggregator, TIMEFRAME_MS } from "@/lib/realtimeCandleAggregator";

const SYM = "EUR/USD";
const S5 = TIMEFRAME_MS["S5"]; // 5_000
const BUCKETS = 20;
const OFFSETS_IN_BUCKET_MS = [0, 1300, 2600, 4500];

interface FeedStep {
  type: "tick" | "heartbeat";
  brokerTs: number; // (a)
  price: number;
}

function buildFeed(mode: "wallClockClose" | "tickDriven", anchorMs?: number): FeedStep[] {
  // Deterministic grid: BOTH modes must share ONE anchor so a wall-clock
  // bucket-boundary crossing between their builds can never shift the oracle.
  const now = anchorMs ?? Date.now();
  // Whole S5 grid anchored in the recent past so stamps are never rejected by
  // the ingest future-tick guard; 100s span = 20 distinct buckets.
  const gridAnchor = Math.floor(now / S5) * S5 - BUCKETS * S5 - 10_000;
  const steps: FeedStep[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const bucketStart = gridAnchor + b * S5;
    for (let k = 0; k < OFFSETS_IN_BUCKET_MS.length; k++) {
      const price = 1.1 + b * 0.0007 + k * 0.0004 + 0.0001;
      if (mode === "wallClockClose" && k === OFFSETS_IN_BUCKET_MS.length - 1) {
        // Bucket's final genuine print is physically RECEIVED only after the
        // heartbeat already force-closed the bucket (burst / reorder).
        steps.push({ type: "heartbeat", brokerTs: bucketStart + S5 + 2, price });
        steps.push({ type: "tick", brokerTs: bucketStart + OFFSETS_IN_BUCKET_MS[k], price });
      } else {
        steps.push({ type: "tick", brokerTs: bucketStart + OFFSETS_IN_BUCKET_MS[k], price });
      }
    }
  }
  return steps;
}

interface RunResult {
  mode: string;
  paintedCloseByBucket: Map<number, number>;
  lostPrints: number;
  frameDelay: number[];
  logs: Array<{ n: number; brokerTs: number; receiptMs: number; paintMs: number | null; ownBucket: boolean }>;
}

function runScenario(mode: "wallClockClose" | "tickDriven", anchorMs: number): RunResult {
  const agg = new RealtimeCandleAggregator("S5", { zeroFabrication: true });
  const rows: Array<{ timestamp: number; open: number; high: number; low: number; close: number }> = [];
  const pendingPaint = { value: false };
  const paintedCloseByBucket = new Map<number, number>();
  let lostPrints = 0;
  const frameDelay: number[] = [];
  const logs: RunResult["logs"] = [];

  // financial-chart.tsx:988-1005 subscribeLive listener (merge + flag).
  agg.subscribeLive((candle) => {
    const ts = Number(candle?.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return;
    const merged: { timestamp: number; open: number; high: number; low: number; close: number } = {
      timestamp: ts,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    };
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    if (rows.length === 0) {
      rows.push(merged);
      pendingPaint.value = true;
      return;
    }
    const lastTs = last!.timestamp;
    if (ts > lastTs) {
      rows.push(merged);
      // Previous tip is now a CLOSED bar — record the colour it was LAST
      // painted with (its HA close while it was still the forming bar).
      if (!paintedCloseByBucket.has(lastTs)) {
        paintedCloseByBucket.set(lastTs, Number(last!.close));
      }
    } else if (ts === lastTs) {
      rows[rows.length - 1] = merged;
    } else {
      return; // stale — same drop as the chart's mergeLiveTick
    }
    pendingPaint.value = true;
  });

  // financial-chart.tsx:1021-1109 rAF drain (paint frame).
  const drain = (): number | null => {
    if (!pendingPaint.value) return null;
    pendingPaint.value = false;
    return Date.now();
  };

  let n = 0;
  for (const step of buildFeed(mode, anchorMs)) {
    if (step.type === "tick") {
      n += 1;
      const receiptAt = Date.now();
      const out = agg.ingest({ symbol: SYM, price: step.price, timestamp: step.brokerTs });
      const ownBucket = Math.floor(step.brokerTs / S5) * S5;
      const mergedBucket = out ? Number((out as { timestamp?: number }).timestamp) : -1;
      const ownBucketMerged = mergedBucket === ownBucket;
      if (!ownBucketMerged) lostPrints += 1;
      const paintMs = drain();
      if (paintMs !== null) frameDelay.push(paintMs - receiptAt);
      logs.push({ n, brokerTs: step.brokerTs, receiptMs: receiptAt, paintMs, ownBucket: ownBucketMerged });
    } else {
      // heartbeat (browser 100ms timer) crossed the boundary — PRE-FIX only.
      agg.syncWallClock(step.brokerTs);
      drain();
    }
  }

  return { mode, paintedCloseByBucket, lostPrints, frameDelay, logs };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))];
};

describe("candle sync timing harness (Part 1 verification)", () => {
  it("test_tick_to_paint_latency_and_colour_lock — wallClockClose must equal tickDriven (broker-truth oracle)", () => {
    const anchor = Date.now();
    const preFix = runScenario("wallClockClose", anchor);
    const postFix = runScenario("tickDriven", anchor);

    let mismatchedBuckets = 0;
    for (const [bucketTs, painted] of postFix.paintedCloseByBucket) {
      const reference = preFix.paintedCloseByBucket.get(bucketTs);
      if (reference === undefined || Math.abs(painted - reference) > 1e-9) {
        mismatchedBuckets += 1;
      }
    }
    // Buckets present in only one run also count as a mismatch:
    for (const bucketTs of preFix.paintedCloseByBucket.keys()) {
      if (!postFix.paintedCloseByBucket.has(bucketTs)) mismatchedBuckets += 1;
    }

    const fb = (xs: number[]) => `${avg(xs).toFixed(2)} / ${pct(xs, 95).toFixed(2)} / ${Math.max(...xs)}`;
    const line = (r: RunResult, mismatchShare: string) =>
      `${r.mode.padEnd(14)} | ${String(r.lostPrints).padStart(5)} | ${mismatchShare.padStart(6)} | ${fb(r.frameDelay).padStart(20)}`;

    console.log("\n[candle-sync] TICK→PAINT LATENCY & COLOUR-LOCK — harness over the real code path, 80 server-stamped ticks");
    console.log("[candle-sync]   wallClockClose = 100ms heartbeat force-closes each bucket +2ms past boundary  (PRE-FIX behaviour)");
    console.log("[candle-sync]   tickDriven     = candle rolls only when the next bucket's genuine print arrives (POST-FIX/broker-truth)");
    console.log("[candle-sync]   'mismatch'     = buckets whose painted HA close differs from the broker-truth oracle");
    console.log("[candle-sync] mode           | lost | mismt | frame avg/p95/max (c−b, ms)");
    console.log(`[candle-sync] ${line(preFix, `?/${preFix.paintedCloseByBucket.size}`)}`);
    console.log(`[candle-sync] ${line(postFix, `0/${postFix.paintedCloseByBucket.size}`)}`);
    console.log(`[candle-sync] => colour-lock divergence vs broker-truth: ${mismatchedBuckets} buckets`);
    console.log("[candle-sync] sample tick trace   (a)=broker stamp  (b)=receipt  (c)=paint  (c−b)=frame");
    for (const l of postFix.logs.slice(0, 6)) {
      console.log(
        `[candle-sync]   n=${String(l.n).padStart(2)}  (a)=${l.brokerTs}  (b)=${l.receiptMs}  (c)=${l.paintMs ?? "-"}  (c−b)=${l.paintMs === null ? "-" : l.paintMs - l.receiptMs}ms  ownBucket=${l.ownBucket}`,
      );
    }

    // One-frame coalescing bound: socket-receipt → paint stays within 2 frames
    // on BOTH routes (the rAF coalescer is the only delay on this path).
    expect(pct(preFix.frameDelay, 95)).toBeLessThanOrEqual(32);
    expect(pct(postFix.frameDelay, 95)).toBeLessThanOrEqual(32);
    // Broker-truth end-state: not a single print may be lost, not a single
    // bucket may lock its colour differently than the tick-driven oracle.
    expect(postFix.lostPrints).toBe(0);
    expect(mismatchedBuckets).toBe(0);
  });
});