/**
 * realForexRegime.ts — PART 15 [51] / PART 28.2 [214]/[215]
 * REAL-FOREX REGIME-GATE CARD DISPLAY.
 *
 * Every REAL_FOREX_PAIRS card surfaces the `regime_gate` state computed by
 * financial_analysis.py from REAL intraday closes (>= MIN_CLOSES = 100),
 * reusing the existing suppressedReason SCORED-ONLY rendering pattern.
 *
 * PART 28.2: the [47]/[48] review gate is now answered by the engine itself —
 * the 10 real pairs stream a genuine Yahoo intraday tape (PART 28), so the
 * regime classification that justifies a tradable UI is evaluated live on
 * intraday ticks. Pairs whose intraday classification is non-random-walk
 * (trending / mean_reverting) come back "tradable" and unlock the card;
 * random_walk pairs stay SCORED-ONLY. This is DATA-DRIVEN — the client no
 * longer blanket-blocks all real cards, and it never invents a tradable
 * state: no verdict on the payload still renders as "regime review pending".
 */

import { REAL_FOREX_SET } from "@/constants/symbols";

/**
 * How the card's price row is sourced. PART 28 switched the 10 real pairs to
 * a genuinely intraday source (Yahoo Finance 1-minute chart API streamed via
 * the core-backend tick engine at 1Hz), so for every instrument the card is
 * a live tape — "daily_close" no longer exists in the wire.
 */
export type RealForexDataKind = "live" | "daily_close";

/**
 * Why a scored-only card is not tradable — surfaced on hover + on-card.
 * STRICT 96.5% BAR (2026-09-24): engine surfaces regime_gate
 * "pending_high_precision" for every verdict below the executable floor, so
 * the card copy explains the high-precision gate explicitly.
 */
export const REAL_FOREX_NONINTERACTIVE_COPY: Record<
  NonNullable<RealForexRegimeDisplay["reason"]>,
  string
> = {
  regime_pending_confirmation: "Regime review pending — not yet confirmed tradable",
  regime_scored_only: "Random walk regime — scored only, not tradable",
  regime_pending_high_precision:
    "Below 96.5% — high-precision gate pending, scored only",
};

export interface RealForexRegimeDisplay {
  /** True when the symbol is one of the 10 REAL_FOREX_PAIRS (assetSubType "forex"). */
  isReal: boolean;
  /** True → the card renders SCORED-ONLY: price only, no BUY/SELL, no action. */
  scoredOnly: boolean;
  /**
   * Why the card is non-tradable:
   *   "regime_pending_high_precision"  — engine executable=false (regime_gate
   *                                       "pending_high_precision", sub-96.5%)
   *   "regime_scored_only"             — backend regime_gate === "scored_only"
   *   "regime_pending_confirmation"    — no verdict on the payload (null)
   *   null                             — tradable (engine-cleared real pair)
   */
  reason:
    | "regime_pending_high_precision"
    | "regime_scored_only"
    | "regime_pending_confirmation"
    | null;
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

  // PART 28.2 + STRICT 96.5% BAR (2026-09-24): honor the backend gate exactly.
  // No blanket [47]/[48] block — a real pair is tradable only when the
  // engine's strict execution gate says so (regime_gate "tradable");
  // "pending_high_precision" (sub-96.5% SCORED-ONLY) is its own reason;
  // random_walk gate stays scored_only; no verdict stays "pending".
  if (gate === "tradable")
    return {
      isReal: true,
      scoredOnly: false,
      reason: null,
      dataKind: "live", nonInteractiveTitle: "",
      scoredOnlyCaption: "",
    };
  const reason =
    gate === "pending_high_precision"
      ? "regime_pending_high_precision"
      : gate === "scored_only"
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
      ? `${symbol} — real-forex, scored-only (${reason === "regime_scored_only" ? "random walk" : reason === "regime_pending_high_precision" ? "high-precision gate" : "regime review"})`
      : `Open Pro Terminal for ${symbol}`,
    reason,
    dataKind,
    nonInteractiveTitle,
    scoredOnlyCaption,
  };
}