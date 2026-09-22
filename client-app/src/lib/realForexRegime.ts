/**
 * realForexRegime.ts — PART 15 [51] REAL-FOREX REGIME-GATE CARD DISPLAY.
 *
 * Every REAL_FOREX_PAIRS card must surface the PART 14 `regime_gate` state
 * from financial_analysis.py's payload, reusing the existing suppressedReason
 * UI pattern (the same SCORED-ONLY rendering already built for random_walk).
 *
 * [47]/[48] GATE: EUR/GBP + EUR/NOK were flagged "trending" in the PART 14
 * audit, but at LOW confidence on a <1-year window — the fixed-income/regime
 * classification is still UNDER REVIEW. Until that number/date-range check is
 * EXPLICITLY confirmed, EVERY real-forex card renders scored-only style: it
 * must never visually invite a trade action while the classification that
 * would justify a tradable UI is still pending. The backend gate already
 * enforces non-executability; this only governs display wiring.
 */

import { REAL_FOREX_SET } from "@/constants/symbols";

/**
 * PART 15 — set TRUE only after [47]/[48] are answered and explicitly
 * confirmed by a human. Until then every REAL_FOREX_PAIRS card shows the
 * SCORED-ONLY (non-tradable) display regardless of the payload.
 */
export const REAL_FOREX_TRADABLE_CONFIRMED = false;

/**
 * How the card's price row is sourced. PART 28 switched the 10 real pairs to
 * a genuinely intraday source (Yahoo Finance 1-minute chart API streamed via
 * the core-backend tick engine at 1Hz), so for every instrument the card is
 * a live tape — "daily_close" no longer exists in the wire.
 */
export type RealForexDataKind = "live" | "daily_close";

/**
 * Why a scored-only card is not tradable — surfaced on hover + on-card.
 */
export const REAL_FOREX_NONINTERACTIVE_COPY: Record<
  NonNullable<RealForexRegimeDisplay["reason"]>,
  string
> = {
  regime_pending_confirmation: "Regime review pending — not yet confirmed tradable",
  regime_scored_only: "Random walk regime — scored only, not tradable",
};

export interface RealForexRegimeDisplay {
  /** True when the symbol is one of the 10 REAL_FOREX_PAIRS (assetSubType "forex"). */
  isReal: boolean;
  /** True → the card renders SCORED-ONLY: price only, no BUY/SELL, no action. */
  scoredOnly: boolean;
  /**
   * Why the card is non-tradable:
   *   "regime_scored_only"             — backend regime_gate === "scored_only"
   *   "regime_pending_confirmation"    — [47]/[48] not yet confirmed
   *   null                             — tradable (real pair only after confirm)
   */
  reason: "regime_scored_only" | "regime_pending_confirmation" | null;
  /** Data cadence: every instrument (incl. the 10 real pairs) is a live tape. */
  dataKind: RealForexDataKind;
  /** Cursor/tooltip copy surfaced when a scored-only card is hovered. */
  nonInteractiveTitle: string;
  /** Short visible caption for a scored-only card (the non-interactive why). */
  scoredOnlyCaption: string;
}

/**
 * Resolve the terminal-card display state for a symbol from the PART 14
 * regime_gate payload field. Pure — no React/store — so the grid rule is
 * unit-testable.
 */
export function resolveRealForexRegimeDisplay(
  symbol: string,
  regimeGate?: string | null,
): RealForexRegimeDisplay {
  const norm = String(symbol || "").trim().toUpperCase();
  const isReal = REAL_FOREX_SET.has(norm);
  if (!isReal)
    return {
      isReal: false,
      scoredOnly: false,
      reason: null,
      dataKind: "live",
      nonInteractiveTitle: "",
      scoredOnlyCaption: "",
    };

  const gate = String(regimeGate || "").trim().toLowerCase();

  // Until [47]/[48] are confirmed, real pairs are ALWAYS scored-only —
  // regardless of what the payload currently says.
  if (!REAL_FOREX_TRADABLE_CONFIRMED) {
    const reason =
      gate === "scored_only"
        ? "regime_scored_only"
        : "regime_pending_confirmation";
    return {
      isReal: true,
      scoredOnly: true,
      reason, dataKind: "live",
      nonInteractiveTitle: REAL_FOREX_NONINTERACTIVE_COPY[reason],
      scoredOnlyCaption: REAL_FOREX_NONINTERACTIVE_COPY[reason],
    };
  }

  // Post-confirmation: honor the backend gate exactly.
  if (gate === "tradable")
    return {
      isReal: true,
      scoredOnly: false,
      reason: null,
      dataKind: "live", nonInteractiveTitle: "",
      scoredOnlyCaption: "",
    };
  const reason =
    gate === "scored_only" ? "regime_scored_only" : "regime_pending_confirmation";
  return {
    isReal: true,
    scoredOnly: true,
    reason, dataKind: "live",
    nonInteractiveTitle: REAL_FOREX_NONINTERACTIVE_COPY[reason],
    scoredOnlyCaption: REAL_FOREX_NONINTERACTIVE_COPY[reason],
  };
}

/**
 * Card interaction contract for the terminal grid (PART 15 [53]).
 *
 * scored_only cards are NOT merely visually greyed off: the card is truly
 * non-interactive — no card-wide navigation role, no tab stop, no PRO action
 * button, no target candle. A tradable card is a normal role="link" card.
 */
export interface RealForexCardBehavior {
  /** scored-only ⇒ role must be undefined (no "link"), tabIndex -1, no PRO button. */
  scoredOnly: boolean;
  interactive: boolean;
  /** ARIA label for the card (nav or scored-only description). */
  ariaLabel: string;
  reason: RealForexRegimeDisplay["reason"];
  dataKind: RealForexRegimeDisplay["dataKind"];
  /** Hover/cursor copy for a scored-only card (empty when interactive). */
  nonInteractiveTitle: string;
  /** Short visible caption for a scored-only card (the non-interactive why). */
  scoredOnlyCaption: string;
}

export function realForexCardBehavior(
  symbol: string,
  regimeGate?: string | null,
): RealForexCardBehavior {
  const display = resolveRealForexRegimeDisplay(symbol, regimeGate);
  const { scoredOnly, reason, dataKind, nonInteractiveTitle, scoredOnlyCaption } =
    display;
  return {
    scoredOnly,
    interactive: !scoredOnly,
    ariaLabel: scoredOnly
      ? `${symbol} — real-forex, scored-only (${reason === "regime_scored_only" ? "random walk" : "regime review"})`
      : `Open Pro Terminal for ${symbol}`,
    reason,
    dataKind,
    nonInteractiveTitle,
    scoredOnlyCaption,
  };
}