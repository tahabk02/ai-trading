import { TARGET_CANDLES_MIN_TIER, tierRank, type SignalTier } from "./signalTiers";

/**
 * PART 24 [161]/[162] — the expiry selector must respect the gate system the
 * same way every other surface does. Two gates, both mirroring the engine:
 *
 *  1. "too_late" — the PART 9 execution-latency time gate
 *     (ai-engine/app/services/signal_gatekeeper.py). MIN_ACTIONABLE_WINDOW_MS
 *     mirrors DEFAULT_MIN_ACTIONABLE_WINDOW_MS there: the engine calibrates it
 *     as p95(measured_latency) x 1.5 and bootstraps at 1500ms — the client
 *     keeps the same bootstrap constant so both sides agree on a tape with no
 *     live latency measurement. An expiry whose first bucket-aligned landing
 *     sits less than this window from NOW is suppressed as too_late for that
 *     option — never silently accepted (the alignment would have to slide a
 *     bucket, silently lengthening the user's chosen horizon).
 *
 *  2. "no_tradable_layer" — the regime/tier gate. The projection horizon
 *     selector (Pro Expiry Bar) drives the chart's target-candle zone, which
 *     only exists at T1-T3 (TARGET_CANDLES_MIN_TIER); the execution expiry
 *     grid (Quick Trade) is honest at the engine's MIN_EXECUTABLE_TIER (T4).
 *     A random_walk symbol arrives as suppressed_reason === "regime_scored_only"
 *     and is never tradable at any tier.
 */

export const MIN_ACTIONABLE_WINDOW_MS = 1500;

export interface ExpiryOptionState {
  label: string;
  seconds: number;
  /** Bucket-aligned landing after sliding past the action window (s). */
  alignedSeconds: number;
  /** Real time from NOW to that landing (ms). */
  marginMs: number;
  remainingToBucketCloseMs: number;
  tooLate: boolean;
  suppressed: boolean;
  reason: "too_late" | null;
}

export interface ExpirySelectorState {
  zoneActive: boolean;
  anyActionable: boolean;
  blockedReason: "regime_scored_only" | "low_tier" | "no_tier" | null;
  remainingToBucketCloseMs: number;
  options: ExpiryOptionState[];
  nowMs: number;
}

function alignExpirationToBucket(
  expirationSeconds: number,
  timeframeSeconds: number,
  elapsedMs: number,
  minWindowMs: number,
): number {
  const tf = Math.max(1, timeframeSeconds);
  const period = tf * 1000;
  const baseExp = Math.max(1, expirationSeconds);
  const window = Math.max(0, minWindowMs);
  const elapsed = Math.max(0, elapsedMs);
  let k = Math.max(1, Math.ceil((baseExp * 1000) / period));
  while (k * period < elapsed + window) {
    k += 1;
  }
  return k * tf;
}

/** Real time until the current timeframe bucket closes (ms), floored at 1ms. */
export function remainingToBucketCloseMs(
  nowMs: number,
  timeframeSeconds: number,
): number {
  const period = Math.max(1, timeframeSeconds) * 1000;
  const rem = period - (nowMs % period);
  return Math.max(1, rem);
}

/** Per-option actionability for one expiry choice on the given bucket grid. */
export function expirySelectionState(
  seconds: number,
  label: string,
  timeframeSeconds: number,
  nowMs: number,
  minWindowMs: number = MIN_ACTIONABLE_WINDOW_MS,
  optionEnabled: boolean = true,
): ExpiryOptionState {
  const tf = Math.max(1, timeframeSeconds);
  const period = tf * 1000;
  const elapsedMs = nowMs % period;
  const remaining = remainingToBucketCloseMs(nowMs, tf);
  const baseExp = Math.max(1, seconds);
  // The FIRST bucket-aligned landing the choice would occupy. If that landing
  // is less than the action window from NOW, accepting the choice would
  // silently slide a bucket — the exact silently-allowed drift [161] removes.
  const baseK = Math.max(1, Math.ceil((baseExp * 1000) / period));
  const baseMarginMs = baseK * tf * 1000 - nowMs;
  const tooLate = baseMarginMs < minWindowMs;
  const alignedSeconds = alignExpirationToBucket(
    seconds,
    tf,
    elapsedMs,
    minWindowMs,
  );
  const marginMs = alignedSeconds * 1000 - nowMs;
  return {
    label,
    seconds,
    alignedSeconds,
    marginMs,
    remainingToBucketCloseMs: remaining,
    tooLate,
    suppressed: !optionEnabled || tooLate,
    reason: tooLate ? "too_late" : null,
  };
}

/**
 * Whole-selector state: zone gate (regime + tier) folded over the per-option
 * too_late gate. minTradableTier is the selector's honest floor — "T3" for the
 * chart projection horizon, "T4" (MIN_EXECUTABLE_TIER) for execution.
 */
export function expirySelectorState(
  tier: string | null | undefined,
  suppressedReason: string | null | undefined,
  timeframeSeconds: number,
  nowMs: number,
  options: ReadonlyArray<{ label: string; seconds: number }>,
  minTradableTier: SignalTier = TARGET_CANDLES_MIN_TIER,
  minWindowMs: number = MIN_ACTIONABLE_WINDOW_MS,
): ExpirySelectorState {
  const regimeScoredOnly =
    (suppressedReason ?? "").trim().toLowerCase() === "regime_scored_only";
  const zoneActive =
    !regimeScoredOnly && tierRank(tier) >= tierRank(minTradableTier);
  const blockedReason: ExpirySelectorState["blockedReason"] = regimeScoredOnly
    ? "regime_scored_only"
    : tier == null || (tier ?? "").trim() === ""
      ? "no_tier"
      : tierRank(tier) < tierRank(minTradableTier)
        ? "low_tier"
        : null;
  const opts = options.map((o) =>
    expirySelectionState(o.seconds, o.label, timeframeSeconds, nowMs, minWindowMs, zoneActive),
  );
  return {
    zoneActive,
    anyActionable: zoneActive && opts.some((o) => !o.suppressed),
    blockedReason,
    remainingToBucketCloseMs:
      opts.length > 0 ? opts[0].remainingToBucketCloseMs : 0,
    options: opts,
    nowMs,
  };
}