/**
 * alertGate.ts (client) — PART 41 [403] mirror of the backend predicate.
 *
 * The server only broadcasts `high_confidence_signal` for verdicts that are
 * executable && T1..T3 && regime_gate "tradable". The client re-verifies the
 * same predicate on every local prediction/WS payload (defense in depth): a
 * SCORED-ONLY verdict — even at 98% book agreement — must never raise a toast
 * or play the alert sound. Gate fields that can't be present fail closed.
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