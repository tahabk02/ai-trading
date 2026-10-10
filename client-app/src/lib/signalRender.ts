import type { CandlestickData } from "lightweight-charts";
import type { SignalHoldView } from "./realtimeCandleAggregator";
import {
  normalizeViewRegimeDetail,
  normalizeViewRegimeGate,
  normalizeViewTier,
} from "./realtimeCandleAggregator";
import { targetCandlesEnabled } from "./signalTiers";

/**
 * PART 11 — BAR TINT MUST CONSUME THE BUFFERED SIGNAL, NEVER THE RAW STORE
 * FIELD. Before PART 11 the candle-paint loop tinted bars from a second,
 * UNBUFFERED read — `buildSignalView(predictionDataRef.current, …).gatedSignal`
 * — while the HUD label read the SignalHoldBuffer-stabilized value. Two store
 * writers (`fetchPrediction` REST + `applyLiveSignal` WS, different cadences)
 * flipped the raw field at will, so bars changed color on every 96.5% gate
 * crossing even while the label was frozen — the production "HUD flicker".
 *
 * This pure function is the ONE place that maps a signal to bar colors, and
 * the component passes it the SignalHoldBuffer output (`effectiveSignal()`).
 * It is kept dependency-free (colors injected) so the render-path contract is
 * unit-testable without mounting the chart.
 *
 * Gap rows always paint the gap color regardless of the signal. When the
 * buffered signal is neutral the base (unread T0) colors are kept.
 */
/**
 * PART 21 — the SHARED pure badge renderer ([137]c). Every badge-shaped
 * consumer (chart HUD, asset-card CALL/PUT chip, widget badge) renders from a
 * `SignalHoldView` through this one function, so the badge can never read a
 * second, independently-fetched copy of the signal. Direction mirrors the
 * buffer's gated signal; a suppressed reason surfaces the honest label.
 */
export function signalBadgeFor(view: SignalHoldView): {
  direction: "BUY" | "SELL" | null;
  tier: string | null;
  suppressedReason: SignalHoldView["suppressedReason"];
  badgeText: string;
} {
  return {
    direction: view.gatedSignal,
    tier: view.tier,
    suppressedReason: view.suppressedReason,
    badgeText:
      view.suppressedReason === "too_late"
        ? "TOO LATE"
        : view.suppressedReason === "regime_scored_only"
          ? "SCORED ONLY"
          : view.gatedSignal ?? "NO SIGNAL",
  };
}

export function barTintForBufferedSignal(
  base: CandlestickData,
  isGap: boolean,
  bufferedSignal: "BUY" | "SELL" | null,
  gapColor: string,
  bullColor: string,
  bearColor: string,
): CandlestickData {
  if (isGap) {
    return { ...base, color: gapColor, borderColor: gapColor, wickColor: gapColor };
  }
  if (bufferedSignal === "BUY" || bufferedSignal === "SELL") {
    const c = bufferedSignal === "BUY" ? bullColor : bearColor;
    return { ...base, color: c, borderColor: c, wickColor: c };
  }
  return base;
}

/**
 * PART 40 [394] — THE TARGET GATE. A projection (target candles, projection
 * price lines, the TGT slot and the target direction) renders if AND ONLY IF
 * the engine's regime gate says `tradable` AND the tier clears T1–T3. Two
 * inputs, both off the ONE SignalHoldView — no second condition exists
 * anywhere: confidence, feed status and the symbol never widen it, and a
 * missing/unknown gate fails CLOSED (withheld + reason, never a ghost target).
 */
export function targetZoneEnabled(
  view: Pick<SignalHoldView, "tier" | "regimeGate">,
): boolean {
  return view.regimeGate === "tradable" && targetCandlesEnabled(view.tier);
}

/** Why the target slot is withheld. Every withheld state carries one. */
export type TargetWithheldReason =
  | "too_late"
  | "stale_feed"
  | "scored_only"
  | "pending_high_precision"
  | "below_tier"
  | "regime_review"
  | "no_target";

export interface TargetRenderState {
  /** True ⇔ [394]: regime_gate "tradable" AND tier in T1–T3. */
  showTarget: boolean;
  /** The gate that decided it — echoed so surfaces can show the raw value. */
  regimeGate: string | null;
  /** The target's direction — null exactly when showTarget is false. */
  signal: "BUY" | "SELL" | null;
  /** null exactly when the target renders; else the truthful why-not. */
  reason: TargetWithheldReason | null;
  /** The engine's raw sub-reason (otc_hf_fail / mtf_misaligned / …), if any. */
  detail: string | null;
}

/**
 * PART 40 [394]/[395] — the render state is a PURE function of the view (plus
 * the target price, which only decides whether a gated target has a value to
 * draw). `targetPrice` is optional so callers that only need the gate can
 * omit it; supplied as 0/absent-but-gated it reports `no_target` instead of a
 * silent blank.
 */
export function targetRenderState(
  view: SignalHoldView,
  targetPrice?: number,
): TargetRenderState {
  const detail = view.regimeDetail;
  if (targetZoneEnabled(view)) {
    const price = targetPrice === undefined ? 1 : Number(targetPrice);
    const hasPrice = Number.isFinite(price) && price > 0;
    return {
      showTarget: true,
      regimeGate: view.regimeGate,
      signal: view.gatedSignal,
      reason: hasPrice ? null : "no_target",
      detail: null,
    };
  }
  // Withheld — reason precedence, most specific engine verdict first.
  const reason: TargetWithheldReason =
    view.suppressedReason === "too_late" || detail === "too_late"
      ? "too_late"
      : detail === "stale_market_out_of_safety_bounds"
        ? "stale_feed"
        : view.suppressedReason === "regime_scored_only" ||
            view.regimeGate === "scored_only"
          ? "scored_only"
          : view.regimeGate === "pending_high_precision"
            ? "pending_high_precision"
            : view.regimeGate === "tradable"
              ? "below_tier"
              : // gate null / unknown future value — no verdict, fail closed
                "regime_review";
  return {
    showTarget: false,
    regimeGate: view.regimeGate,
    signal: null,
    reason,
    detail,
  };
}

/**
 * PART 40 [395] — the SAME pure gate for surfaces that hold a raw /predict
 * payload instead of a SignalHoldView (the 44-card grid). The payload is
 * normalized with the aggregator's own normalizers, so a card and the chart
 * can never disagree about what "tradable + T1–T3" means. `null` payload is
 * the honest "no verdict in hand" state — withheld with `awaiting_payload`.
 */
export function targetStateForPayload(
  payload: {
    tier?: string | null;
    regime_gate?: string | null;
    suppressed_reason?: string | null;
    target_price?: number;
  } | null
  | undefined,
  targetPrice?: number,
): TargetRenderState {
  if (!payload) {
    return {
      showTarget: false,
      regimeGate: null,
      signal: null,
      reason: "regime_review",
      detail: "awaiting_payload",
    };
  }
  const detail = normalizeViewRegimeDetail(payload.suppressed_reason);
  const view: SignalHoldView = {
    gatedSignal: null,
    tier: normalizeViewTier(payload.tier),
    bucketSec: 0,
    suppressedReason:
      detail === "too_late"
        ? "too_late"
        : detail === "regime_scored_only"
          ? "regime_scored_only"
          : null,
    regimeGate: normalizeViewRegimeGate(payload.regime_gate),
    regimeDetail: detail,
  };
  return targetRenderState(
    view,
    targetPrice ?? (Number(payload.target_price) || 0),
  );
}

/** Copy for a withheld target slot — one shared wording for chart + cards so
 *  the same withheld state reads identically on every surface. */
export function targetReasonCopy(
  reason: TargetWithheldReason | null,
  detail?: string | null,
): { label: string; hint: string } {
  switch (reason) {
    case "too_late":
      return {
        label: "TOO LATE TO ACT",
        hint: "The engine demoted this emission: not enough real time left in the bucket to act.",
      };
    case "stale_feed":
      return {
        label: "STALE FEED",
        hint: "The market feed is outside the safety bounds — the target is held, not guessed.",
      };
    case "scored_only":
      return {
        label: "SCORED-ONLY — RANDOM WALK",
        hint: "The regime gate scored this symbol as random_walk: observable, never tradable.",
      };
    case "pending_high_precision":
      return {
        label: detail
          ? `PENDING HIGH PRECISION · ${detail.toUpperCase()}`
          : "PENDING HIGH PRECISION",
        hint: "The regime gate has not cleared this symbol for a target yet (sub-reason shown verbatim from the engine).",
      };
    case "below_tier":
      return {
        label: detail
          ? `BELOW TIER · ${detail.toUpperCase()}`
          : "BELOW TIER",
        hint: "The gate is open but this verdict's band sits below T3 — the projection only draws T1–T3.",
      };
    case "no_target":
      return {
        label: "AWAITING ENGINE TARGET",
        hint: "The gate passed but the payload carries no target price yet.",
      };
    case "regime_review":
    default:
      return detail === "awaiting_payload"
        ? {
            label: "AWAITING VERDICT",
            hint: "No /predict verdict is in hand for this symbol yet.",
          }
        : {
            label: detail
              ? `REGIME REVIEW · ${detail.toUpperCase()}`
              : "REGIME REVIEW — NO VERDICT",
            hint: "No regime verdict has arrived for this symbol yet.",
          };
  }
}
/**
 * PART 24 [158] — the "TARGET CANDLES N candles" HUD text must render EXACTLY
 * when the target-candle SHAPE renders. Pre-PART 24 the text was a THIRD
 * independent read (`targetCandlesLabelFor` count derived from
 * expirationSeconds/timeframeSeconds in financial-chart, never routed through
 * view.tier) — so a WEAK/T5 tape showed "TARGET CANDLES N" beside an empty
 * projection, the same independent-drift class as PART 20/22. The count now
 * flows through the SAME SignalHoldView the shape gate consumes.
 *
 * PART 40 [394] — `enabled` is the FULL target gate (regime + tier) so the
 * text can never claim a projection the regime gate withholds.
 */
export function targetCandlesLabelFor(
  view: Pick<SignalHoldView, "tier" | "regimeGate">,
  intervals: number,
): { enabled: boolean; count: number | null } {
  const enabled = targetZoneEnabled(view);
  return {
    enabled,
    count: enabled && Number.isFinite(intervals) && intervals > 0 ? intervals : null,
  };
}

/** Renderable value of the label — null means the text must not be drawn. */
export function formatTargetCandlesLabel(
  label: { enabled: boolean; count: number | null },
): string | null {
  return label.enabled && label.count != null ? `${label.count} candles` : null;
}
