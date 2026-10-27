/**
 * signalThresholds.ts — the confidence boundaries shared by every host-side
 * alert/broadcast decision.
 *
 * These values mirror the AI Engine's canonical contracts:
 *   • HIGH_CONFIDENCE_ALERT_THRESHOLD — quant_matrix.py. A priority alert only
 *     fires above this genuine 10-book confluence score.
 *   • MIN_EXECUTABLE_CONFIDENCE — THERMAL_GATE_FLOOR / T4-LOW in
 *     signal_gatekeeper.py. It is the weakest user-selectable executable band,
 *     so the live broadcaster must emit on a crossing of THIS bar rather than
 *     a retired 60% constant.
 *
 * Keeping them here prevents /tick-signal and /predict from drifting apart.
 */

/** AI Engine HIGH_CONFIDENCE_ALERT_THRESHOLD (percent). */
export const HIGH_CONFIDENCE_ALERT_THRESHOLD = 90.0;

/** Weakest executable tier threshold — T4-LOW (percent). */
export const MIN_EXECUTABLE_CONFIDENCE = 80.0;

/** True when a genuine confidence score qualifies for a priority alert. */
export function isHighConfidence(confidence: number): boolean {
  // The AI Engine emits `high_confidence_alert` on `confidence > 90.0`;
  // mirror the strict comparison exactly.
  return Number.isFinite(confidence) && confidence > HIGH_CONFIDENCE_ALERT_THRESHOLD;
}
