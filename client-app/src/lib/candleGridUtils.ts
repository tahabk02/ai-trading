/**
 * PURE candle-grid utilities for the FinancialChart.
 *
 * Every function here is a deterministic, side-effect-free transform on
 * (timestamps / OHLC arrays / booleans) — no React, no lightweight-charts, no
 * aggregator — so the exact geometry the chart renders (bucket alignment,
 * projection anchoring, spike-body clamping, seam contiguity) is unit-testable
 * in isolation. Kept byte-symmetric with the live pipeline:
 *   • bucketStart / leadShiftBucket parity (aggregator) is the alignment truth;
 *   • these sit on the CHART side only where it applies grid math to rendered
 *     candles (strict boundary filter, projection base slot, ATR body guard).
 */

export function bucketAlignStrict(tsMs: number, bucketMs: number): boolean {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return false;
  if (!bucketMs || bucketMs <= 0) return false;
  return tsMs % bucketMs === 0;
}

export function roundToNearestBucket(tsMs: number, bucketMs: number): number {
  const b = bucketMs && bucketMs > 0 ? bucketMs : 60_000;
  const ms = Number(tsMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / b) * b;
}

export function floorToBucketSeconds(sec: number, bucketSeconds: number): number {
  const bs = bucketSeconds && bucketSeconds > 0 ? bucketSeconds : 60;
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.floor(sec / bs) * bs;
}

/* ── SPIKE-BODY GUARD (mission [4]: no >5×ATR body ever renders) ──
 * A single corrupt/spike candle (fat-finger feed, catch-up tick after silent
 * minutes) must never render a body ~10× the series normal and squash the
 * pane. Cap = 5 × ATR(20) when the caller provides it, else 5 × the series'
 * robust MEDIAN body (median is L1-robust — a lone hand-typed spike cannot
 * pollute its own baseline). Clamping preserves the candle's body MIDPOINT
 * and DIRECTION — it SHORTENS an absurd body, never invents a level. */
export const CANDLE_BODY_ATR_MULT = 5;

export function bodyCapFor(
  candles: Array<{ open: number; close: number }>,
  atrProp: number,
): number {
  if (Number.isFinite(atrProp) && atrProp > 0) {
    return atrProp * CANDLE_BODY_ATR_MULT;
  }
  const bodies = candles
    .map((c) => Math.abs(Number(c.open) - Number(c.close)))
    .filter((b) => Number.isFinite(b) && b > 0);
  if (bodies.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...bodies].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return mid > 0 ? mid * CANDLE_BODY_ATR_MULT : Number.POSITIVE_INFINITY;
}

export function clampCandleBody<C extends { open: number; high: number; low: number; close: number }>(
  c: C,
  cap: number,
): { candle: C; clamped: boolean } {
  const open = Number(c.open);
  const close = Number(c.close);
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) {
    return { candle: c, clamped: false };
  }
  const body = Math.abs(close - open);
  if (body <= cap) return { candle: c, clamped: false };
  const mid = (open + close) / 2;
  const half = cap / 2;
  const cClose = close >= open ? mid + half : mid - half;
  const cOpen = open >= close ? mid + half : mid - half;
  const high = Number.isFinite(Number(c.high))
    ? Math.max(Number(c.high), cOpen, cClose)
    : Math.max(cOpen, cClose);
  const low = Number.isFinite(Number(c.low))
    ? Math.min(Number(c.low), cOpen, cClose)
    : Math.min(cOpen, cClose);
  return {
    candle: { ...c, open: cOpen, high, low, close: cClose },
    clamped: true,
  };
}

/* SEAM CONTIGUITY AUDIT (mission [6]): every consecutive pair of rendered
 * candles must sit EXACTLY one bucket step apart. A stray delta (missing real
 * data, mixed grid, projection offset) is counted and surfaced so a "candles
 * spread apart / mfr9in 3la b3dhom" symptom is never silent. */
export function seamGapCount<C extends { time: number | unknown }>(
  candles: C[],
  bucketSeconds: number,
): number {
  if (candles.length < 2) return 0;
  const step = bucketSeconds && bucketSeconds > 0 ? bucketSeconds : 60;
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const a = Number(candles[i - 1].time);
    const b = Number(candles[i].time);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      gaps += 1;
      continue;
    }
    if (b - a !== step) gaps += 1;
  }
  return gaps;
}