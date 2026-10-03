/**
 * minConfidenceFilter — CONFIDENCE FILTER (Alpha.5 Pro).
 *
 * PART 31 [309]/[311] — the confidence bar is NO LONGER an independently
 * draggable value. It is a READ-OUT of the selected tier's executable floor:
 *
 *   T1 → 96.5%   T2 → 90.0%   T3 → 80.0%   T4 → 70.0%   T5 → 70.0% (clamped)
 *
 * Previously the operator could drag the slider anywhere in 50..99 and that
 * value was forwarded as `min_confidence` verbatim, while the tier selector
 * independently decided `min_tier`. Two controls, one safety intent, two
 * answers — and a slider parked at 60% while T4 was selected would ask the
 * engine for a bar BELOW LOWEST_TRADABLE_TIER (70%), which is exactly the
 * bypass [311] flags: the same category of hazard as PART 34's force-override
 * finding, one layer up in the UI.
 *
 * So the manual drag is gone, `minConfidencePct` is derived in the store from
 * `resolveExecutionFloor(minTier)`, and this module's only remaining job is to
 * HARD-FLOOR any value that reaches it at MIN_EXECUTABLE_FLOOR_PCT so no
 * interaction path (persisted key, direct store poke, hand-edited request) can
 * express a sub-70% executable bar. LOWEST_TRADABLE_TIER stays the single
 * source of truth for that floor.
 */

import {
  MIN_EXECUTABLE_FLOOR_PCT,
  TIER_THRESHOLDS,
} from "@/lib/signalTiers";

export { MIN_EXECUTABLE_FLOOR_PCT };

/**
 * RETIRED — PART 31 [311]. The confidence bar used to be independently
 * draggable and persisted here, which is precisely the desync vector [309]
 * removes: a stored 60.0% would outlive the tier selection that contradicts
 * it. The key is deliberately never read again; the bar is now derived from
 * `terminal_min_tier` on every load.
 */
export const LS_MIN_CONFIDENCE_KEY = "terminal_min_confidence_pct";

/**
 * The bar control used to span 50..99% freely; 50.0% is no longer reachable
 * because `clampMinConfidencePct` floors at MIN_EXECUTABLE_FLOOR_PCT (70.0%).
 */
export const MIN_CONFIDENCE_HIGH_PCT = 99;
export const MIN_CONFIDENCE_DEFAULT_PCT = TIER_THRESHOLDS.T1 * 100;

export const LS_HIDE_BELOW_THRESHOLD_KEY = "terminal_hide_below_threshold";

/**
 * Clamp a confidence bar into `MIN_EXECUTABLE_FLOOR_PCT .. 99`.
 *
 * The floor is a HARD floor, not a default: a value below T4 (70%) is raised
 * to 70% rather than honoured. This is what makes [312]'s "can never display
 * below 70.0% regardless of interaction path" true even for callers that
 * bypass the store.
 */
export function clampMinConfidencePct(
  value: number | null | undefined,
  fallback = MIN_CONFIDENCE_DEFAULT_PCT,
): number {
  const base =
    value == null || !Number.isFinite(value) ? fallback : value;
  const flooredBase = Math.max(MIN_EXECUTABLE_FLOOR_PCT, base);
  return Math.min(MIN_CONFIDENCE_HIGH_PCT, Math.max(MIN_EXECUTABLE_FLOOR_PCT, flooredBase));
}

export function readPersistedHideBelowThreshold(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LS_HIDE_BELOW_THRESHOLD_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistHideBelowThreshold(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_HIDE_BELOW_THRESHOLD_KEY, value ? "1" : "0");
  } catch {
    // best effort only.
  }
}

/**
 * Effective displayed confidence driving the filter decision for ONE card.
 * Prefers the heavier horizon / official prediction; falls back to the live
 * 1Hz micro-quant verdict. Only a strictly positive confidence is measurable
 * (0 is the engine's "market-waiting / no signal" convention) — otherwise
 * null, so a waiting card is never treated as below-the-bar.
 */
export function cardEffectiveConfidence(
  horizonConfidence: number | null | undefined,
  liveConfidence: number | null | undefined,
): number | null {
  if (horizonConfidence != null && Number.isFinite(horizonConfidence) && horizonConfidence > 0) {
    return horizonConfidence;
  }
  if (liveConfidence != null && Number.isFinite(liveConfidence) && liveConfidence > 0) {
    return liveConfidence;
  }
  return null;
}

/**
 * True ONLY when a measurable confidence exists AND is strictly below the
 * active filter bar. A card with no confidence yet (still evaluating /
 * market-waiting, confidence 0) is NEVER treated as below-the-bar.
 */
export function isBelowConfidenceBar(
  confidence: number | null | undefined,
  minConfidencePct: number,
): boolean {
  if (confidence == null || !Number.isFinite(confidence) || confidence <= 0) {
    return false;
  }
  return confidence < minConfidencePct;
}