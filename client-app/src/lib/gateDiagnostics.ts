/**
 * gateDiagnostics.ts — TRANSPARENT GATE DIAGNOSTICS (non-fabricating).
 *
 * When a pair is non-interactive the card must say WHY, in plain language, and
 * what would unlock it. The reason is NEVER invented: it is the engine's own
 * `suppressed_reason` (the fine class-gate / high-precision / regime sub-reason
 * the AI Engine already ships on the payload) or the regime-gate display reason
 * the client already derives. This module only TRANSLATES engine codes into
 * readable copy — it never alters, widens or bypasses a gate.
 *
 * Vocabulary is the exact one produced by
 * `ai-engine/app/services/signal_gatekeeper.py::apply_strict_execution_gate`
 * (`suppressed_reason`) and the per-class strategies
 * (`otc_hf_quality` / `real_liquidity_gate` / `crypto_hf_quality`).
 */

export type GateDiagnosticTone = "gold" | "amber" | "slate";

export interface GateDiagnostic {
  /** The engine code (normalized) that produced this diagnostic. */
  code: string;
  /** Short, uppercase, card-sized label. */
  label: string;
  /** What the gate means, in one sentence. */
  hint: string;
  /** The concrete condition(s) that would unlock the pair. */
  unlock: string;
  /** Cosmetics — which of the card's existing tones to use. */
  tone: GateDiagnosticTone;
}

interface GateReasonCopy {
  label: string;
  hint: string;
  unlock: string;
  tone?: GateDiagnosticTone;
}

/**
 * Engine code → readable copy. Keys are the lower-cased codes exactly as the
 * engine emits them; `stale_market_out_of_safety_bounds` is included because
 * the core-backend stale fallback stamps it on the payload.
 */
export const GATE_REASON_COPY: Record<string, GateReasonCopy> = {
  // ── per-asset-class filter gates ──
  insufficient_history: {
    label: "HISTORY TOO SHORT",
    hint: "The tape is too shallow for a defensible verdict.",
    unlock: "Needs ≥160 clean closes (REAL) / ≥30 ticks (OTC) / ≥60 (CRYPTO).",
  },
  no_bid_ask_quotes: {
    label: "NO BID/ASK BOOK",
    hint: "No live L2 quotation is available for this pair.",
    unlock: "Requires a live quotation with a valid spread.",
  },
  spread_too_wide: {
    label: "SPREAD TOO WIDE",
    hint: "The relative spread is above the illiquidity floor.",
    unlock: "Spread must fall under 0.5% to trade.",
  },
  spread_exceeds_atr_margin: {
    label: "SPREAD > 1-BAR MOVE",
    hint: "One-tick spread would eat the entry before the trade starts.",
    unlock: "Spread must be smaller than a typical one-bar move.",
  },
  spread_proxy_insufficient_margin: {
    label: "SPREAD PROXY UNSAFE",
    hint: "Proxied spread has no safe margin over the realized move.",
    unlock: "Needs a wider ATR margin before it can be validated.",
  },
  spread_proxy_insufficient_atr: {
    label: "SPREAD PROXY UNSAFE",
    hint: "The tape is too flat to validate the proxied spread.",
    unlock: "Needs a non-dead tape (non-zero ATR) to validate.",
  },
  flow_against_direction: {
    label: "FLOW AGAINST DIRECTION",
    hint: "Order-flow pressure opposes the verdict.",
    unlock: "Wait for flow to align with the direction.",
  },
  mtf_misaligned: {
    label: "MTF MISALIGNED",
    hint: "The resampled M1/M5/H1 trends disagree with the verdict.",
    unlock: "At least 2 of M1/M5/H1 must align.",
  },
  mtf_insufficient_evidence: {
    label: "MTF EVIDENCE THIN",
    hint: "Not enough resampled history to judge multi-timeframe alignment.",
    unlock: "Needs a deeper tape for the M5/H1 buckets.",
  },
  volatility_stress: {
    label: "VOLATILITY SPIKE",
    hint: "Realized volatility sits in the anomalous tail.",
    unlock: "Wait for volatility to normalize.",
  },
  otc_hf_fail: {
    label: "OTC HF QUALITY FAIL",
    hint: "High-frequency price action / clustering is below the OTC bar.",
    unlock: "Needs genuine directional momentum, not a flat tape.",
  },
  crypto_hf_fail: {
    label: "CRYPTO HF QUALITY FAIL",
    hint: "Breakout / momentum / volatility structure is below the crypto bar.",
    unlock: "Needs a valid breakout with trend structure.",
  },

  // ── high-precision / regime gates ──
  below_high_precision_bar: {
    label: "CONFLUENCE UNDER BAR",
    hint: "The verdict's confluence is below the executable high-precision bar.",
    unlock: "Needs ≥96.5% confluence, or lower the Confidence Filter.",
  },
  regime_scored_only: {
    label: "RANDOM-WALK REGIME",
    hint: "The window classifies as random_walk — observable, never tradable.",
    unlock: "Needs a trending / mean-reverting regime window.",
  },
  too_late: {
    label: "TOO LATE IN BUCKET",
    hint: "Too little real time left in the bucket to act (execution latency gate).",
    unlock: "Wait for the next bucket to open.",
  },
  no_directional_signal: {
    label: "NO DIRECTION YET",
    hint: "The engine emitted no BUY/SELL verdict — there is no direction to act on.",
    unlock: "Wait for a directional verdict.",
  },
  awaiting_directional_signal: {
    label: "NO DIRECTION YET",
    hint: "The execution gate released a verdict that carries no direction.",
    unlock: "Wait for a directional verdict.",
  },
  insufficient_input: {
    label: "INSUFFICIENT INPUT",
    hint: "Not enough valid input to evaluate this pair yet.",
    unlock: "Cold start — collecting market data.",
  },
  stale_market_out_of_safety_bounds: {
    label: "STALE / OUT OF BOUNDS",
    hint: "The last-good verdict was demoted: the live market is outside verified safety bounds.",
    unlock: "Wait for the feed to return inside the safety bounds.",
  },
  awaiting_payload: {
    label: "AWAITING VERDICT",
    hint: "No /predict verdict is in hand for this symbol yet.",
    unlock: "Waiting for the first engine response.",
  },

  // ── operator filter demotions (not engine gates) ──
  filter_confidence_bar: {
    label: "BELOW CONFIDENCE FILTER",
    hint: "The engine verdict is under your operator confidence bar.",
    unlock: "Lower the Confidence Filter to trade it.",
    tone: "amber",
  },
  filter_tier_floor: {
    label: "BELOW TIER FLOOR",
    hint: "The verdict's honest band sits under your selected tier floor.",
    unlock: "Select a lower tier to trade it.",
    tone: "slate",
  },
};

/** Regime display reason → engine code (client-composed map). */
const REGIME_REASON_CODE: Record<string, string> = {
  regime_scored_only: "regime_scored_only",
  regime_pending_high_precision: "below_high_precision_bar",
  regime_pending_confirmation: "awaiting_payload",
};

function normalizeCode(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  const key = code.trim().toLowerCase().replace(/\s+/g, "_");
  return key.length > 0 ? key : null;
}

/**
 * Translate one engine code into a readable diagnostic. Returns null for a
 * missing/empty code (there is nothing to say). An UNKNOWN but present code is
 * surfaced verbatim (uppercased) rather than swallowed — the grid must never
 * hide a real engine reason it does not yet have copy for.
 */
export function humanizeGateReason(
  code: string | null | undefined,
): GateDiagnostic | null {
  const key = normalizeCode(code);
  if (!key) return null;
  const copy = GATE_REASON_COPY[key];
  if (copy) {
    return {
      code: key,
      label: copy.label,
      hint: copy.hint,
      unlock: copy.unlock,
      tone: copy.tone ?? "gold",
    };
  }
  return {
    code: key,
    label: key.replace(/_/g, " ").toUpperCase(),
    hint: "Engine gate reason reported by the signal surface.",
    unlock: "See the AI Engine gate for the exact threshold.",
    tone: "slate",
  };
}

export interface CardGateDiagnosticInput {
  /** A market-closed real card has its own state — it carries no gate reason. */
  marketClosed?: boolean;
  /** Interactive cards are tradable — there is nothing to diagnose. */
  interactive?: boolean;
  /** The engine's fine reason (`prediction.data.suppressed_reason`). */
  suppressedReason?: string | null;
  /** The client-derived regime display reason (`realForexRegime`). */
  regimeReason?: string | null;
  /** The card was demoted by the operator confidence filter. */
  demotedByFilter?: boolean;
  /** The card was demoted by the operator tier floor. */
  demotedByTier?: boolean;
}

/**
 * Resolve the ONE diagnostic a non-interactive card should show.
 *
 * Precedence is the engine's own authority: a real `suppressed_reason` wins,
 * then the regime display reason, and only then the operator-filter demotions
 * (which are not engine gates). Market-closed and interactive cards yield null.
 */
export function resolveCardGateDiagnostic(
  input: CardGateDiagnosticInput,
): GateDiagnostic | null {
  if (input.marketClosed || input.interactive) return null;

  const engine = humanizeGateReason(input.suppressedReason);
  if (engine) return engine;

  const regimeCode = input.regimeReason
    ? REGIME_REASON_CODE[input.regimeReason]
    : undefined;
  if (regimeCode) return humanizeGateReason(regimeCode);

  if (input.demotedByFilter) return humanizeGateReason("filter_confidence_bar");
  if (input.demotedByTier) return humanizeGateReason("filter_tier_floor");
  return null;
}
