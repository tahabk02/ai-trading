import { TARGET_CANDLES_MIN_TIER, tierRank, type SignalTier } from "./signalTiers";

/**
 * PART 24 [161]/[162] — expiry/horizon SELECTION is never gated; only EXECUTION is.
 *
 * ARCHITECTURE (this is the whole point of the module):
 *
 *   1. SELECTABILITY  — always true. Navigation is a pure input. It is NEVER a
 *      function of market state. If a verdict is below the bar, or the symbol is
 *      scored_only, or the bucket is closing, the operator can STILL switch
 *      horizons. Previously `suppressed` was fed straight into `disabled`, which
 *      produced a circular deadlock: a low tier disabled every option, so the
 *      operator could never switch to a horizon that might clear the bar. The
 *      old `suppressed` field is deliberately GONE from this module's types so
 *      the mistake cannot be reintroduced.
 *
 *   2. ACTION-READINESS — informational only, per option, time-varying. It is
 *      REPORTED (status text, amber ring) and never enforced. Two independent
 *      gates, both mirroring the engine:
 *
 *      a. "too_late" — the PART 9 execution-latency time gate
 *         (ai-engine/app/services/signal_gatekeeper.py). MIN_ACTIONABLE_WINDOW_MS
 *         mirrors DEFAULT_MIN_ACTIONABLE_WINDOW_MS there: the engine calibrates
 *         it as p95(measured_latency) x 1.5 and bootstraps at 1500ms — the
 *         client keeps the same bootstrap constant so both sides agree on a tape
 *         with no live latency measurement. An expiry whose first bucket-aligned
 *         landing sits less than this window from NOW is too_late for that
 *         option — never silently accepted (the alignment would have to slide a
 *         bucket, silently lengthening the user's chosen horizon).
 *
 *      b. the regime/tier gate. The projection horizon (Pro Expiry Bar) drives
 *         the chart's target-candle zone, which only exists at T1-T3
 *         (TARGET_CANDLES_MIN_TIER); the execution expiry grid (Quick Trade) is
 *         honest at the engine's MIN_EXECUTABLE_TIER (T1, 96.5% - STRICT
 *         high-precision bar). A random_walk symbol arrives as suppressed_reason
 *         === "regime_scored_only" and is never tradable at any tier; a
 *         sub-96.5% signal arrives as "pending_high_precision" and is likewise
 *         never tradable.
 *
 *   3. COMMIT ELIGIBILITY — enforced at the action boundary, never in the nav.
 *      `executeTrade` independently refuses a dispatch without a fresh quote
 *      (<= 2.5s), without a matching engine signal younger than 15s, and below
 *      the strict 96.5% confidence floor; the engine's SignalLock refuses
 *      HOLD / zero-confidence / zero-target verdicts. Un-gating navigation
 *      therefore cannot manufacture a tradeable signal - it only stops the UI
 *      from trapping the operator.
 */

export const MIN_ACTIONABLE_WINDOW_MS = 1500;

/**
 * Why a choice is not action-ready right now. Purely descriptive — nothing in
 * this union may be used to block interaction.
 */
export type ExpiryBlockReason =
  | "too_late"
  | "regime_scored_only"
  | "regime_pending_high_precision"
  | "low_tier"
  | "no_tier";

export interface ExpiryOptionState {
  label: string;
  seconds: number;
  /** Bucket-aligned landing after sliding past the action window (s). */
  alignedSeconds: number;
  /** Real time from NOW to that landing (ms). */
  marginMs: number;
  remainingToBucketCloseMs: number;
  /** Informational timing gate: the landing cannot clear the action window. */
  tooLate: boolean;
  /** Informational: the regime/tier gate is closed for this symbol. */
  regimeBlocked: boolean;
  /** Informational: could this choice be acted on right now? */
  actionReady: boolean;
  /** Most relevant blocking reason (regime outranks timing), else null. */
  reason: ExpiryBlockReason | null;
  /** Real wait until this choice becomes action-ready (ms); 0 when ready. */
  retryInMs: number;
}

export interface ExpirySelectorState {
  zoneActive: boolean;
  anyActionable: boolean;
  blockedReason: ExpiryBlockReason | null;
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

/**
 * PURE TIMING state for one expiry choice on the given bucket grid.
 *
 * Deliberately knows nothing about tiers or regimes — it answers only "is there
 * enough real time before this choice's bucket-aligned landing?". The regime
 * fold happens in `expirySelectorState`.
 */
export function expirySelectionState(
  seconds: number,
  label: string,
  timeframeSeconds: number,
  nowMs: number,
  minWindowMs: number = MIN_ACTIONABLE_WINDOW_MS,
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
    regimeBlocked: false,
    actionReady: !tooLate,
    reason: tooLate ? "too_late" : null,
    retryInMs: tooLate ? Math.max(0, marginMs) : 0,
  };
}

export function expiryCountdownRemainingSeconds(
  nowMs: number,
  anchorMs: number,
  expirationSeconds: number,
): number {
  const duration = Number(expirationSeconds);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(anchorMs) ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return 0;
  }
  const durationMs = Math.max(1, Math.round(duration * 1000));
  const elapsedMs = Math.max(0, nowMs - anchorMs);
  return Math.max(0, Math.ceil((durationMs - elapsedMs) / 1000));
}

/**
 * Whole-selector state: the regime/tier gate folded over the per-option timing
 * gate. minTradableTier is the surface's honest floor — "T3" for the chart
 * projection horizon, "T1" (MIN_EXECUTABLE_TIER, 96.5%) for execution.
 *
 * NOTE the return type carries no `disabled` / `suppressed` field. Consumers
 * MUST NOT gate interaction on `actionReady` / `regimeBlocked`; they exist to be
 * rendered as status. See the module header.
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
  const regimePendingHighPrecision =
    (suppressedReason ?? "").trim().toLowerCase() === "pending_high_precision";
  const zoneActive =
    !regimeScoredOnly &&
    !regimePendingHighPrecision &&
    tierRank(tier) >= tierRank(minTradableTier);
  const blockedReason: ExpiryBlockReason | null = regimeScoredOnly
    ? "regime_scored_only"
    : regimePendingHighPrecision
      ? "regime_pending_high_precision"
      : tier == null || (tier ?? "").trim() === ""
        ? "no_tier"
        : tierRank(tier) < tierRank(minTradableTier)
          ? "low_tier"
          : null;

  const opts = options.map((o) => {
    // Timing first…
    const timing = expirySelectionState(
      o.seconds,
      o.label,
      timeframeSeconds,
      nowMs,
      minWindowMs,
    );
    // …then the regime fold. The regime reason outranks the timing reason
    // because it is stable for the whole bucket, whereas too_late is a
    // transient sub-second condition.
    const reason: ExpiryBlockReason | null = blockedReason ?? timing.reason;
    const regimeBlocked = blockedReason !== null;
    const actionReady = !regimeBlocked && !timing.tooLate;
    return {
      ...timing,
      regimeBlocked,
      actionReady,
      reason,
      // When the regime gate is closed the timing wait is meaningless (no
      // horizon would help), so report 0 rather than a fake countdown.
      retryInMs: regimeBlocked ? 0 : timing.retryInMs,
    };
  });

  return {
    zoneActive,
    anyActionable: opts.some((o) => o.actionReady),
    blockedReason,
    remainingToBucketCloseMs:
      opts.length > 0 ? opts[0].remainingToBucketCloseMs : 0,
    options: opts,
    nowMs,
  };
}