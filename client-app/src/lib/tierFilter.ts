/**
 * tierFilter — TIER SELECTOR (flexible-tier architecture, 2026-09-30).
 *
 * Lets the operator choose which signal bands they want to TRADE. The value is:
 *   1. persisted locally (survives reloads),
 *   2. forwarded as `min_tier` on /predict + /multi-predict so the AI engine
 *      marks lower bands scored-only at the source, and
 *   3. available as an instant client-side predicate for the grid.
 *
 * IMPORTANT — this filter never hides signal DATA. The engine emits every
 * computed tier (T1…T5) with its true confidence, direction and metadata; the
 * selection only decides which of those are `executable`. A T3 verdict is
 * always visible and always carries its real `tier`/`tier_label`; this module
 * never rewrites a tier to fake a decision.
 *
 * Mirrors the engine's floor rules (ai-engine/app/services/signal_gatekeeper.py):
 * the effective bar can never fall below LOWEST_TRADABLE_TIER (T4 / 70%), so
 * selecting T5 monitors WEAK verdicts without ever making them executable.
 */

import {
  DEFAULT_EXECUTION_TIER,
  LOWEST_TRADABLE_TIER,
  type SignalTier,
  type TierSelection,
  isTier,
  resolveExecutionFloor,
  resolveTier,
  tierRank,
  TIER_LABELS,
  TIER_THRESHOLDS,
  TIER_ORDER,
} from "@/lib/signalTiers";

export const LS_MIN_TIER_KEY = "terminal_min_tier";

/** Every band a user may select, strongest first (T1 is the strict default). */
export const TIER_SELECTIONS: TierSelection[] = [...TIER_ORDER];

/** Normalise any user-supplied value onto a real tier, else the default. */
export function clampTierSelection(
  value: unknown,
  fallback: TierSelection = DEFAULT_EXECUTION_TIER,
): TierSelection {
  if (isTier(typeof value === "string" ? value : null)) {
    return (value as string).trim().toUpperCase() as TierSelection;
  }
  return fallback;
}

export function readPersistedTierSelection(): TierSelection {
  if (typeof window === "undefined") return DEFAULT_EXECUTION_TIER;
  try {
    return clampTierSelection(window.localStorage.getItem(LS_MIN_TIER_KEY));
  } catch {
    return DEFAULT_EXECUTION_TIER;
  }
}

export function persistTierSelection(value: TierSelection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LS_MIN_TIER_KEY,
      clampTierSelection(value),
    );
  } catch {
    // localStorage may be unavailable (SSR, privacy mode) — best effort only.
  }
}

/** Human label for a selection, e.g. "T2 HIGH". */
export function tierSelectionLabel(selection: TierSelection): string {
  const s = clampTierSelection(selection);
  return `${s} ${TIER_LABELS[s]}`;
}

/** Short explanation of what selecting a band means for the operator. */
export function tierSelectionHint(selection: TierSelection): string {
  switch (clampTierSelection(selection)) {
    case "T1":
      return "Premium only (96.5%+) — the strictest, unchanged default.";
    case "T2":
      return "High (90%+) — includes T2 signals.";
    case "T3":
      return "Medium (80%+) — includes T3 signals.";
    case "T4":
      return "Low (70%+) — the most permissive band that can trade.";
    case "T5":
      // T5 is emitted and monitorable, but the bar never drops below T4.
      return "Monitor WEAK too — all tiers are displayed, but only T1–T4 can trade.";
    default:
      return "";
  }
}

/**
 * True when a verdict's tier clears the operator's selected floor, i.e. it is
 * a band the operator would actually trade.
 *
 * This is the client-side twin of the engine's `executable` computation and is
 * used only for PRESENTATION (sorting, badges, "below your floor" hints). The
 * engine remains the authority on `executable`; we never promote a verdict the
 * engine withheld for a non-tier reason (class gate, missing data, etc.).
 */
export function tierClearsSelection(
  tier: string | null | undefined,
  selection: TierSelection | null | undefined,
): boolean {
  if (!isTier(tier)) return false;
  const { barFrac } = resolveExecutionFloor(selection);
  return TIER_THRESHOLDS[tier] >= barFrac;
}

/**
 * Rank used to sort the grid strongest-first. Unknown/absent tiers sort last
 * but are never dropped, so the blotter stays complete.
 */
export function selectionSortRank(
  tier: string | null | undefined,
  selection: TierSelection | null | undefined,
): number {
  if (!isTier(tier)) return -1;
  // Ties broken by the operator's floor so the bands they selected float up.
  return tierRank(tier) + (tierClearsSelection(tier, selection) ? 1 : 0);
}

export { LOWEST_TRADABLE_TIER, DEFAULT_EXECUTION_TIER, resolveExecutionFloor };
export type { SignalTier, TierSelection };

/** Minimal shape a card needs to know its own honest band. */
export interface TierCarrying {
  tier?: string | null;
  tier_label?: string | null;
  confidence?: number | null;
  book_agreement?: number | null;
}

/**
 * Resolve the HONEST tier for one card.
 *
 * Prefers the engine's explicit `tier` field — it is the authority and is
 * never rewritten. Only when a payload predates that field does this fall back
 * to deriving the band from the measured confidence.
 */
export function resolveCardTier(
  prediction: TierCarrying | null | undefined,
  verdict: TierCarrying | null | undefined,
): SignalTier | null {
  for (const source of [prediction, verdict]) {
    const raw = source?.tier;
    if (isTier(raw)) return (raw as string).trim().toUpperCase() as SignalTier;
  }
  // Fallback for older/partial payloads: derive from a measurable confidence.
  const conf = [prediction?.confidence, verdict?.confidence, prediction?.book_agreement].find(
    (c) => c != null && Number.isFinite(c) && c > 0,
  );
  if (conf == null) return null;
  return resolveTier(Number(conf));
}