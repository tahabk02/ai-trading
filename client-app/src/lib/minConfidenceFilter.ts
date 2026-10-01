/**
 * minConfidenceFilter — CONFIDENCE FILTER (Alpha.5 Pro).
 *
 * The dashboard grid's Confidence Filter lets the operator pick a minimum
 * executable confidence (50..99%, default 96.5%). The value is:
 *   1. persisted locally (survives reloads),
 *   2. forwarded as `min_confidence` on /predict + /multi-predict so the AI
 *      engine demotes sub-bar pairs to SCORED-ONLY at the source, and
 *   3. applied as an instant grid-level visibility rule in the terminal.
 *
 * The engine floors the effective bar at T4 (70%) so the filter can never
 * mark a sub-tradable-tier verdict executable — this module mirrors the
 * client-side clamp only (50..99) and leaves the tier floor to the engine.
 */

export const MIN_CONFIDENCE_LOW_PCT = 50;
export const MIN_CONFIDENCE_HIGH_PCT = 99;
export const MIN_CONFIDENCE_DEFAULT_PCT = 96.5;

export const LS_MIN_CONFIDENCE_KEY = "terminal_min_confidence_pct";
export const LS_HIDE_BELOW_THRESHOLD_KEY = "terminal_hide_below_threshold";

export function clampMinConfidencePct(
  value: number | null | undefined,
  fallback = MIN_CONFIDENCE_DEFAULT_PCT,
): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(
    MIN_CONFIDENCE_HIGH_PCT,
    Math.max(MIN_CONFIDENCE_LOW_PCT, value),
  );
}

export function readPersistedMinConfidencePct(): number {
  if (typeof window === "undefined") return MIN_CONFIDENCE_DEFAULT_PCT;
  try {
    const raw = Number(window.localStorage.getItem(LS_MIN_CONFIDENCE_KEY));
    return Number.isFinite(raw)
      ? clampMinConfidencePct(raw, MIN_CONFIDENCE_DEFAULT_PCT)
      : MIN_CONFIDENCE_DEFAULT_PCT;
  } catch {
    return MIN_CONFIDENCE_DEFAULT_PCT;
  }
}

export function persistMinConfidencePct(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LS_MIN_CONFIDENCE_KEY,
      String(clampMinConfidencePct(value)),
    );
  } catch {
    // localStorage may be unavailable (SSR, privacy mode) — best effort only.
  }
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