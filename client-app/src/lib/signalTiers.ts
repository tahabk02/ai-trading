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
  // Lowest tradable floor (70%). A user MAY select T4 to trade this band.
  T4: 0.7, // LOW
  // WEAK: a real, EMITTED band that the trader can see and monitor. It has a
  // 0% floor, so selecting T5 never widens the executable bar past T4 (see
  // resolveExecutionFloor).
  T5: 0.0, // WEAK
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

/** Default strict bar: only T1 (96.5%) is executable unless the user widens it. */
export const MIN_EXECUTABLE_TIER = "T1" as SignalTier;

/** The floor the engine applies when the user has not chosen one. */
export const DEFAULT_EXECUTION_TIER = "T1" as SignalTier;

/**
 * Weakest band a user may actually trade. T5 is emitted and monitorable but
 * selecting it cannot lower the executable bar below T4 — mirroring the
 * engine's LOWEST_TRADABLE_TIER.
 */
export const LOWEST_TRADABLE_TIER = "T4" as SignalTier;

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
export function tierRank(tier: unknown): number {
  return isTier(tier) ? TIER_RANK[tier.trim().toUpperCase()] : 0;
}

/** True when ``tier`` is a known engine tier label (T1…T5).
 *  Type-guards first: `tier` arrives from untrusted socket/REST payloads, and a
 *  number or object would make `.trim()` throw and take the whole render down. */
export function isTier(tier: unknown): tier is SignalTier {
  if (typeof tier !== "string") return false;
  const t = tier.trim().toUpperCase();
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

// ── FLEXIBLE-TIER EXECUTION FLOOR (2026-09-30) ────────────────────────────
// The trader picks which bands they want to trade. This NEVER changes which
// tiers are received or displayed — the engine emits T1…T5 regardless. It only
// decides what the client sends as `min_tier` and which verdicts it treats as
// actionable. Mirrors the engine's resolve_execution_floor().

/** A trader's tier selection: any band, with T1 the strict default. */
export type TierSelection = SignalTier;

export interface ExecutionFloor {
  /** The band the trader selected (echoed for display). */
  selected: TierSelection;
  /** The band whose threshold the executable bar actually comes from. */
  effective: SignalTier;
  /** Effective executable bar, 0..1. */
  barFrac: number;
  /** True when the selection had to be widened for safety (T5 → T4). */
  floored: boolean;
}

/** Resolve a trader selection into the executable bar it implies.
 *
 *  Selecting a weaker band never RAISES the bar, and T5 is clamped to the
 *  weakest tradable band (T4) so a WEAK verdict can never become executable. */
export function resolveExecutionFloor(
  selection: TierSelection | null | undefined,
): ExecutionFloor {
  const sel: SignalTier = isTier(selection) ? (selection as SignalTier) : DEFAULT_EXECUTION_TIER;
  const own = TIER_THRESHOLDS[sel];
  const lowest = TIER_THRESHOLDS[LOWEST_TRADABLE_TIER];
  const floored = own < lowest;
  return {
    selected: sel,
    effective: floored ? LOWEST_TRADABLE_TIER : sel,
    barFrac: floored ? lowest : own,
    floored,
  };
}

/**
 * The executable floor a selection implies, as a PERCENTAGE (0..100).
 *
 * PART 31 [309]: this is the ONLY thing that may set `minConfidencePct`. The
 * Confidence Filter stopped being an independently draggable value and became
 * a read-out of the selected tier's real floor, so the number the trader sees
 * and the number the engine is asked for can no longer disagree.
 */
export function executionFloorPct(selection: TierSelection | null | undefined): number {
  return resolveExecutionFloor(selection).barFrac * 100;
}

/**
 * Absolute hard floor (percent) implied by LOWEST_TRADABLE_TIER. Nothing — no
 * interaction path, no persisted value, no direct store poke — may express an
 * executable bar below this.
 */
export const MIN_EXECUTABLE_FLOOR_PCT = TIER_THRESHOLDS[LOWEST_TRADABLE_TIER] * 100;

/** True when ``tier`` clears the trader's selected floor.
 *
 *  This is the filter predicate for "show me signals I would actually trade".
 *  A T5 band never clears it, because T5's threshold is 0% and the floor is
 *  never lower than T4's 70%. */
export function tierClearsFloor(
  tier: string | null | undefined,
  selection: TierSelection | null | undefined,
): boolean {
  if (!isTier(tier)) return false;
  const { barFrac } = resolveExecutionFloor(selection);
  return TIER_THRESHOLDS[tier] >= barFrac;
}