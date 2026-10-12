/**
 * alertGate.ts — PART 41 [403]: THE alert eligibility predicate.
 *
 * A `high_confidence_signal` broadcast (and the client toast + sound it drives)
 * MAY fire ONLY when the verdict is genuinely executable:
 *
 *   executable === true            — the engine's strict execution surface
 *   tier in T1..T3                 — high-precision dispatch tiers only
 *   regime_gate === "tradable"     — the high-precision regime actually passed
 *
 * `broadcastHighConfidenceSignal` and the live-tick high-confidence emit both
 * consult this single predicate so the rail, the terminal and the durable
 * stream can never disagree about what qualifies for an alert. A signal whose
 * regime gate is still pending (98% book agreement or not) MUST be silent.
 */

export const ALERT_EXECUTABLE_TIERS = new Set(["T1", "T2", "T3"]);
export const ALERT_REGIME_GATE = "tradable";

export interface AlertEligibilityInput {
  executable?: boolean;
  tier?: string | null;
  regime_gate?: string | null;
}

export function isAlertEligible(input: AlertEligibilityInput): boolean {
  if (input?.executable !== true) return false;
  const tier = String(input.tier ?? "").trim().toUpperCase();
  if (!ALERT_EXECUTABLE_TIERS.has(tier)) return false;
  const gate = String(input.regime_gate ?? "").trim().toLowerCase();
  return gate === ALERT_REGIME_GATE;
}