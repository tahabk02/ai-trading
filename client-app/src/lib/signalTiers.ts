/**
 * signalTiers.ts — CLIENT MIRROR of the AI Engine's canonical multi-tier ladder
 * (app/services/signal_gatekeeper.py). ONE source of truth consulted by the
 * signal widgets and the target-candle overlay so the front end reaches the
 * SAME T1…T5 verdict the engine dispatches. Pure TS — no DOM, importable from
 * lib/aggregator code.
 */

export type SignalTier = "T1" | "T2" | "T3" | "T4" | "T5";

export const TIER_THRESHOLDS: Record<SignalTier, number> = {
  T1: 0.965, // PREMIUM
  T2: 0.9, // HIGH
  T3: 0.8, // MEDIUM
  T4: 0.7, // LOW
  T5: 0.0, // WEAK — below T4, never dispatched
};

export const TIER_ORDER: SignalTier[] = ["T1", "T2", "T3", "T4", "T5"];

export const TIER_LABELS: Record<SignalTier, string> = {
  T1: "PREMIUM",
  T2: "HIGH",
  T3: "MEDIUM",
  T4: "LOW",
  T5: "WEAK",
};

export const TIER_RANK: Record<SignalTier, number> = {
  T1: 4,
  T2: 3,
  T3: 2,
  T4: 1,
  T5: 0,
};

export const MIN_EXECUTABLE_TIER = "T4" as SignalTier;

/** Target-candle overlay is rendered for T1–T3 only. */
export const TARGET_CANDLES_MIN_TIER = "T3" as SignalTier;

/** Normalize any genuine confidence (0..1 or 0..100) onto the 0..1 scale. */
export function normalizeTierConfidence(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return raw > 1 ? Math.min(raw / 100, 1) : raw;
}

/** Map a genuine confidence onto its honest tier label (T1…T5).
 *  Mirrors engine resolve_tier(): <0.70 → T5 WEAK. */
export function resolveTier(confidence: number): SignalTier {
  const frac = normalizeTierConfidence(Number(confidence) || 0);
  for (const tier of ["T1", "T2", "T3", "T4"] as SignalTier[]) {
    if (frac >= TIER_THRESHOLDS[tier]) return tier;
  }
  return "T5";
}

/** Rank of a tier (T1=4 … T5=0); unknown labels rank 0 (safe). */
export function tierRank(tier: string | null | undefined): number {
  const t = (tier || "").trim().toUpperCase() as SignalTier;
  return TIER_RANK[t] ?? 0;
}

/** True when ``tier`` is a known engine tier label (T1…T5). */
export function isTier(tier: string | null | undefined): tier is SignalTier {
  const t = (tier || "").trim().toUpperCase();
  return t === "T1" || t === "T2" || t === "T3" || t === "T4" || t === "T5";
}

/** True when ``tier`` is at least as strong as ``min``. */
export function tierAtLeast(
  tier: string | null | undefined,
  min: string = MIN_EXECUTABLE_TIER,
): boolean {
  return tierRank(tier) >= tierRank(min);
}

/** True when the target-candle overlay should render (T1–T3). */
export function targetCandlesEnabled(
  tier: string | null | undefined,
): boolean {
  return tierRank(tier) >= tierRank(TARGET_CANDLES_MIN_TIER);
}