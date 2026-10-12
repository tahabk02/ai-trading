"use client";

import { create } from "zustand";
import type { SignalHoldView } from "@/lib/realtimeCandleAggregator";

/**
 * ── THE SINGLE COHERENT SIGNAL VIEW ──────────────────────────────────────
 *
 * WHY THIS EXISTS
 * ---------------
 * The chart HUD and the CoherenceStrip used to read DIFFERENT sources for the
 * same fact, which is the PART 20/21 renderer-drift class:
 *
 *   • financial-chart.tsx read the `SignalHoldBuffer`-stabilized view
 *     (`effectiveSignal()` / `hudView`).
 *   • pro-expiry-bar.tsx read the RAW `predictionData.signal` field.
 *
 * Two store writers flip that raw field on independent cadences —
 * `fetchPrediction` (REST /predict) and `applyLiveSignal` (WS) — so between
 * them the raw field transiently reads `null`. The strip therefore showed
 * HOLD/"SIGNAL: WAITING" for a few hundred milliseconds while the chart, one
 * pixel away, correctly still showed BUY. The two panels disagreed about the
 * same instant, which is exactly what `signalRenderPath.test.ts` PART 21
 * exists to prevent.
 *
 * WHY THE BUFFER IS NOT REBUILT HERE
 * ---------------------------------
 * Tempting, and wrong: instantiating a second `SignalHoldBuffer` on the page.
 * The buffer's freeze window is keyed to `wallSec` — the broker-grid bucket
 * floor — which only the chart's paint loop can supply. A page-side buffer
 * would read at different instants against a different clock, so it would
 * drift from the chart instead of agreeing with it. Two buffers is the bug,
 * not the cure.
 *
 * Instead the chart — the sole owner of the buffer and of `wallSec` — publishes
 * the view it already computed, and every other consumer reads THAT object.
 * One evaluate, one view, one truth: badge ↔ strip ↔ HUD ↔ target-candle gate
 * can no longer disagree, because they are literally the same read.
 *
 * INVARIANT 1 (zero-hop tick paint)
 * ---------------------------------
 * `publishSignalView` is called from a post-render effect on the chart's HUD
 * cadence (~1 Hz), never from the per-tick paint loop, and the store write is
 * change-gated on all four view fields. A store write therefore happens only on
 * a real signal transition (a 96.5%-gated, hysteresis-buffered event, plus at
 * most one per broker bucket) — not once per tick, and not once per render.
 */
export interface SignalViewStore {
  view: SignalHoldView | null;
  publishSignalView: (next: SignalHoldView) => void;
}

export const useSignalViewStore = create<SignalViewStore>((set, get) => ({
  view: null,

  publishSignalView: (next) => {
    const current = get().view;

    // Change gate — the whole point. Without this, a fresh object identity on
    // every HUD frame would re-render every subscriber ~1x/second for no
    // visible change, and a loop would be one missed comparison away.
    if (
      current &&
      current.gatedSignal === next.gatedSignal &&
      current.tier === next.tier &&
      current.bucketSec === next.bucketSec &&
      current.suppressedReason === next.suppressedReason
    ) {
      return;
    }

    set({ view: next });
  },
}));

/**
 * Stable selector — returns the slice, so a subscriber re-renders only when
 * the published view genuinely changes.
 */
export const selectSignalView = (state: SignalViewStore) => state.view;
