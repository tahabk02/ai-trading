/**
 * signalTiers.ts — SHARED T1..T5 LADDER (flexible-tier architecture, 2026-09-30).
 *
 * The engine computes an honest band for every verdict (T1 strongest … T5
 * weakest) and the operator selects which bands they are willing to TRADE.
 * `min_tier` only decides which emitted verdicts are `executable`; it never
 * changes, hides, or rewrites the tier itself.
 *
 * This module owns the canonical ladder so the controllers AND the 1Hz tick
 * forwarder cannot drift apart. A tick path that used a different list (or a
 * hardcoded T1) would silently ignore the operator's selection on the one
 * surface the terminal actually watches.
 *
 * MUST stay in lockstep with `ai-engine/app/services/signal_gatekeeper.py`
 * (`TIER_ORDER` / `TIER_THRESHOLDS`).
 */

/** Canonical T1..T5 signal tiers (T1 strongest). */
export const VALID_SIGNAL_TIERS = ["T1", "T2", "T3", "T4", "T5"] as const;

export type SignalTier = (typeof VALID_SIGNAL_TIERS)[number];

/**
 * Reads the user-selected minimum tier from either the engine's snake_case
 * (`min_tier`) or the bridge's camelCase (`minTier`) key.
 *
 * Anything unrecognised (undefined, blank, "T9", a number, an object) resolves
 * to null so the engine applies its own default (T1) rather than the bridge
 * silently inventing a wider preference — a bad input must never LOOSEN the
 * executable bar.
 */
export function clampMinTierToEngineSet(
  value: unknown,
): SignalTier | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return (VALID_SIGNAL_TIERS as readonly string[]).includes(normalized)
    ? (normalized as SignalTier)
    : null;
}

/** Reads `min_tier` from a request body, accepting both wire spellings. */
export function readMinTier(body: unknown): SignalTier | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  return clampMinTierToEngineSet(b.min_tier ?? b.minTier);
}