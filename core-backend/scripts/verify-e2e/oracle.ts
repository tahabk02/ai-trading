/**
 * verify-e2e/oracle.ts — PART 47 [525] INDEPENDENT candle/time oracle.
 *
 * This file is deliberately a from-scratch reimplementation of the two rules
 * the product depends on, so it can catch a defect in the code under test:
 *
 *   1. Epoch-floor bucketing + strict OHLC fold (open=first, high=max,
 *      low=min, close=last, volume=sum of positive prints).
 *   2. The target/expiry slot ladder: the projection spans `ceil(exp/tf)`
 *      buckets, so its LAST slot is `tipBucket + ceil(exp/tf)*tf`.
 *
 * The server implementation is imported separately by the runner; the two are
 * compared bar-for-bar. NOTHING here imports from `src/`.
 */

import type { Bar, Tick } from "./types";

/** Epoch-floor bucket start, exact integer math (broker-clock ms). */
export function floorBucket(tsMs: number, tfMs: number): number {
  return Math.floor(tsMs / tfMs) * tfMs;
}

/**
 * Fold ascending ticks into closed bars for one timeframe.
 * The still-open trailing bucket is intentionally NOT emitted, matching a
 * "only complete bars" contract.
 */
export function oracleAggregate(ticks: Tick[], tfMs: number): Bar[] {
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  let accVol = 0;
  let count = 0;

  const flush = (): void => {
    if (cur === null) return;
    // Product contract: when every print carries zero volume, the bar's volume
    // is reported as its tick count (see closeBucket in the server service).
    cur.volume = accVol > 0 ? accVol : count;
    bars.push(cur);
  };

  for (const t of ticks) {
    if (!Number.isFinite(t.tsMs) || !Number.isFinite(t.price)) continue;
    const bucket = floorBucket(t.tsMs, tfMs);
    const vol = t.volume && t.volume > 0 ? t.volume : 0;

    if (cur === null || bucket > cur.timestamp) {
      flush();
      cur = { timestamp: bucket, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 };
      accVol = vol;
      count = 1;
    } else if (bucket === cur.timestamp) {
      cur.high = Math.max(cur.high, t.price);
      cur.low = Math.min(cur.low, t.price);
      cur.close = t.price;
      accVol += vol;
      count += 1;
    }
    // bucket < cur.timestamp: a stale out-of-order print is dropped.
  }

  return bars;
}

/** How many buckets an expiry projection spans on a given grid. */
export function oracleTargetCount(expirationSeconds: number, timeframeSeconds: number): number {
  const exp = Number(expirationSeconds);
  const tf = Number(timeframeSeconds);
  if (!Number.isFinite(exp) || !Number.isFinite(tf) || tf <= 0) return 1;
  return Math.max(1, Math.min(120, Math.ceil(exp / tf)));
}

export interface OracleSlot {
  index: number;
  timeSec: number;
  offsetSec: number;
}

/** The contiguous slot ladder a projection occupies, starting one bucket ahead. */
export function oracleSlots(
  tipBucketSec: number,
  timeframeSeconds: number,
  count: number,
): OracleSlot[] {
  const tf = Number(timeframeSeconds);
  const n = Math.max(1, Math.round(Number(count) || 1));
  if (!Number.isFinite(tipBucketSec) || tipBucketSec <= 0 || !Number.isFinite(tf) || tf <= 0) {
    return [];
  }
  const floor = Math.floor(tipBucketSec / tf) * tf;
  const out: OracleSlot[] = [];
  for (let i = 1; i <= n; i += 1) {
    out.push({ index: i, timeSec: floor + i * tf, offsetSec: i * tf });
  }
  return out;
}

/** The bucket the EXPIRY marker anchors to: the last slot of the projection. */
export function oracleExpirySlotSec(
  tipBucketSec: number,
  expirationSeconds: number,
  timeframeSeconds: number,
): number {
  const slots = oracleSlots(
    tipBucketSec,
    timeframeSeconds,
    oracleTargetCount(expirationSeconds, timeframeSeconds),
  );
  return slots.length ? slots[slots.length - 1].timeSec : 0;
}

/** Roll 1m bars up into an N-minute grid using the strict fold. */
export function oracleRollup(minuteBars: Bar[], groupMinutes: number): Bar[] {
  const groupMs = groupMinutes * 60_000;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curGroup = -1;

  for (const m of minuteBars) {
    const g = floorBucket(m.timestamp, groupMs);
    if (cur === null || g !== curGroup) {
      if (cur !== null) out.push(cur);
      curGroup = g;
      cur = {
        timestamp: g,
        open: m.open,
        high: m.high,
        low: m.low,
        close: m.close,
        volume: m.volume,
      };
    } else {
      cur.high = Math.max(cur.high, m.high);
      cur.low = Math.min(cur.low, m.low);
      cur.close = m.close;
      cur.volume += m.volume;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Deep structural comparison of two bar series. Returns a defect description. */
export function diffBars(a: Bar[], b: Bar[]): string | null {
  if (a.length !== b.length) {
    return `bar count differs: server=${a.length} oracle=${b.length}`;
  }
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    const fields: (keyof Bar)[] = ["timestamp", "open", "high", "low", "close", "volume"];
    for (const f of fields) {
      if (x[f] !== y[f]) {
        return `bar[${i}] ${f}: server=${x[f]} oracle=${y[f]} (ts=${x.timestamp})`;
      }
    }
  }
  return null;
}
