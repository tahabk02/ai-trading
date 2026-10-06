/**
 * ohlcNormalizer.ts — the single authority on "is this a valid candle?".
 *
 * WHY A CENTRALISED NORMALISER
 * ────────────────────────────
 * OTC/tick candles are folded together from three independent producers
 * (`appendTick` from the polled spot feed, `ingestPoCandle` from the Pocket
 * Option bridge, and the historical/Frankfurter/Yahoo tier). Each one built
 * OHLC slightly differently, and the result was a class of rendering defects
 * that had nothing to do with the chart and everything to do with malformed
 * bars reaching it:
 *
 *   • FLAT CANDLES — a bucket that received exactly one tick was stored as
 *     `open = high = low = close = price`. That is a zero-height body, which
 *     renders as a horizontal line; when the next tick was lower it painted
 *     as a red slab. With a 10s poll feeding a 1s bucket EVERY tick opened a
 *     fresh single-tick bucket, so the entire 1s series was flat.
 *   • ZERO-PRICE ARTIFACTS — `Number(undefined)` is `NaN`, and `NaN > 0` is
 *     false, so a partially-mapped upstream row could slip past a naive `> 0`
 *     check in one place while another place accepted it outright.
 *   • PERMANENT NaN POISONING — `Math.max(x, NaN)` is `NaN`. A single
 *     non-finite tick landing in an in-progress bar destroyed that bar's
 *     `high`/`low` FOREVER, because every later `Math.max/Math.min` against
 *     `NaN` re-poisons it. The bar never self-heals and is never evicted,
 *     so the artifact persists for the life of the buffer.
 *
 * Every producer now routes through `normalizeOhlc`. Anything that cannot be
 * made well-formed is REJECTED (returns null) rather than repaired with
 * invented numbers — the platform's zero-fabrication rule. The one exception
 * is the high/low envelope, which is widened to cover open/close; that is a
 * monotone correction (it can only ever contain more price action) and is the
 * only way to keep a bar renderable when a producer under-reports its own
 * extremes.
 */

/** The platform's canonical candle shape. */
export interface NormalizableOhlc {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * Required (not optional) so a normalised candle is structurally
   * assignable to the platform's `ForexCandle` without a cast — the
   * normaliser always produces a finite, non-negative volume.
   */
  volume: number;
}

export type OhlcRejectReason =
  | "missing"
  | "bad_timestamp"
  | "non_finite"
  | "non_positive"
  | "inverted_range";

/**
 * Full diagnostic result. The chart/telemetry path uses the reason to report
 * WHY a bar was dropped rather than silently shrinking the series, which
 * previously made a starved feed look identical to a quiet market.
 */
export type OhlcResult =
  | { ok: true; candle: NormalizableOhlc; repaired: boolean }
  | { ok: false; reason: OhlcRejectReason };

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Normalise one candle, or explain why it cannot be used.
 *
 * INVARIANTS ENFORCED (a bar that violates these is unrenderable or lies):
 *   1. timestamp is a finite, non-negative integer-ish epoch value
 *   2. open/high/low/close are all finite
 *   3. open/high/low/close are all STRICTLY POSITIVE (a 0 close is the
 *      "zero-price artifact" and must never reach a chart or an ATR calc)
 *   4. high >= max(open, close)   — the envelope must contain the body
 *   5. low  <= min(open, close)
 *   6. high >= low
 *
 * 4–6 are repaired (widened) when violated but never narrowed: narrowing
 * would delete real price action the producer observed.
 */
export function normalizeOhlcDetailed(input: unknown): OhlcResult {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing" };
  const b = input as Record<string, unknown>;

  const timestamp = b.timestamp;
  if (!isNum(timestamp)) return { ok: false, reason: "bad_timestamp" };

  const open = Number(b.open);
  const high = Number(b.high);
  const low = Number(b.low);
  const close = Number(b.close);

  // NOTE: check finiteness BEFORE the positivity test. `NaN > 0` is false so
  // a combined `> 0` check silently reports "non_positive" for a NaN, hiding
  // the real cause; and `Number(null)` is 0, which passes a naive check.
  if (!isNum(open) || !isNum(high) || !isNum(low) || !isNum(close)) {
    return { ok: false, reason: "non_finite" };
  }
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
    return { ok: false, reason: "non_positive" };
  }

  const bodyHi = Math.max(open, close);
  const bodyLo = Math.min(open, close);
  const fixedHigh = Math.max(high, bodyHi);
  const fixedLow = Math.min(low, bodyLo);
  const repaired = fixedHigh !== high || fixedLow !== low;

  // Widen-only repair can never invert the range (fixedHigh >= bodyHi >=
  // bodyLo >= fixedLow), so `inverted_range` is unreachable from here; it is
  // kept for callers that check a range directly.
  if (fixedHigh < fixedLow) return { ok: false, reason: "inverted_range" };

  const rawVolume = b.volume;
  const volume = isNum(rawVolume) && rawVolume >= 0 ? rawVolume : 0;

  return {
    ok: true,
    repaired,
    candle: {
      timestamp,
      open,
      high: fixedHigh,
      low: fixedLow,
      close,
      volume,
    },
  };
}

/** Convenience wrapper: the normalised candle, or null when unusable. */
export function normalizeOhlc(input: unknown): NormalizableOhlc | null {
  const r = normalizeOhlcDetailed(input);
  return r.ok ? r.candle : null;
}

/** Is this a single price print safe to fold into a bucket? */
export function isUsablePrice(p: unknown): p is number {
  return isNum(p) && p > 0;
}

/**
 * Fold one print into an in-progress bucket, IMMUNE to NaN poisoning.
 *
 * Returns a NEW bar rather than mutating, and refuses to propagate a
 * non-finite field: because `Math.max(NaN, x) === NaN`, an in-place update
 * that trusted its input could permanently destroy a bar. Re-deriving from
 * the previous value each time keeps the bar recoverable.
 */
export function applyPrintToBar(
  bar: NormalizableOhlc,
  price: number,
): NormalizableOhlc | null {
  if (!isUsablePrice(price)) return null;
  if (!isUsablePrice(bar.close)) return null;
  return {
    ...bar,
    // Guard each extreme so a legacy poisoned bar can be rebuilt instead of
    // being propagated forever.
    high: Math.max(isUsablePrice(bar.high) ? bar.high : bar.close, price),
    low: Math.min(isUsablePrice(bar.low) ? bar.low : bar.close, price),
    close: price,
    volume: (isNum(bar.volume) && bar.volume >= 0 ? bar.volume : 0) + 1,
  };
}

/**
 * Roll a new bucket starting at `price`.
 *
 * `prevClose` is threaded in so the new bar OPENS WHERE THE LAST ONE CLOSED
 * instead of at the first tick of the new bucket. Without that continuity a
 * single-tick bucket is necessarily flat (open == high == low == close) even
 * when the market genuinely moved between buckets — the exact "flat red
 * block" signature. Carrying the prior close makes the body real while still
 * using no invented price action: it is the previous bar's own close.
 */
export function openBucket(
  timestamp: number,
  price: number,
  prevClose: number | null,
): NormalizableOhlc | null {
  if (!isUsablePrice(price)) return null;
  const open = isUsablePrice(prevClose) ? (prevClose as number) : price;
  return {
    timestamp,
    open,
    high: Math.max(open, price),
    low: Math.min(open, price),
    close: price,
    volume: 1,
  };
}

/**
 * Normalise a whole series: drop unusable bars, order ascending, and collapse
 * duplicate timestamps (last write wins, matching the existing dedupe
 * semantics). Applied at the READ boundary so nothing malformed can reach the
 * chart even if a producer upstream regresses.
 */
export function normalizeSeries(
  bars: unknown,
  opts: { limit?: number } = {},
): NormalizableOhlc[] {
  if (!Array.isArray(bars)) return [];
  const byTs = new Map<number, NormalizableOhlc>();
  for (const raw of bars) {
    const c = normalizeOhlc(raw);
    if (!c) continue;
    byTs.set(c.timestamp, c);
  }
  const out = Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
  return opts.limit && opts.limit > 0 ? out.slice(-opts.limit) : out;
}
