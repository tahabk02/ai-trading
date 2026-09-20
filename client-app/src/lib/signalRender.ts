import type { CandlestickData } from "lightweight-charts";
import type { SignalHoldView } from "./realtimeCandleAggregator";

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