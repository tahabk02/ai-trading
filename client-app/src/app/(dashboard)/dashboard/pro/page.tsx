"use client";

import { Suspense, useEffect, useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import { ClientOnly } from "@/components/shared/client-only";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { OrderBook } from "@/components/trading/order-book";
import { TradingPanel } from "@/components/trading/trading-panel";
import { Header } from "@/components/shared/header";
import { FeedHealthBar } from "@/components/shared/feed-health";
import { resolveProSymbol, resolveTfParam } from "@/lib/pro-deep-link";
import { useSignalViewStore, selectSignalView } from "@/lib/signalViewStore";

// ── CLIENT-ONLY CHART ISOLATION ──
// The ONLY chart allowed on this terminal is the platform's own
// lightweight-charts candlestick engine driven exclusively by the live
// WebSocket tick stream (no third-party/mock candles). The chart measures the
// DOM and touches browser-only APIs during construction — rendering it during
// SSR produces markup that never matches the client's first paint (React
// Hydration Error). ssr:false guarantees the chart mounts only in the browser.
const FinancialChart = dynamic(
  () =>
    import("@/components/trading/financial-chart").then(
      (m) => m.FinancialChart,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full min-h-[300px] rounded-xl border border-slate-800 bg-obsidian flex flex-col items-center justify-center gap-2">
        <div className="w-8 h-8 rounded-full border-2 border-slate-600/60 border-t-blue-400 animate-spin" />
        <p className="text-xs font-mono text-slate-400 uppercase tracking-widest">
          Loading Live Chart
        </p>
      </div>
    ),
  },
);
import { NeuralMatrixVisualizer } from "@/components/pro/neural-matrix-visualizer";
import { SignalWidget } from "@/components/trading/signal-widget";
import { ProExpiryBar } from "@/components/pro/pro-expiry-bar";
import { useWebSocket } from "@/hooks/useWebSocket";
import {
  useTradingStore,
  selectActiveSymbol,
  selectCurrentPrice,
  selectIsLoading,
  selectGetPrediction,
  selectSetActiveSymbol,
  selectLiveSignals,
  selectSelectedTimeframe,
  selectSelectedExpiration,
} from "@/store/useTradingStore";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";

/**
 * PRO TERMINAL — the single-asset deep-dive. Opened from the Market Terminal
 * via /dashboard/pro?symbol=EUR/USD. The `symbol` query is read with
 * useSearchParams(), normalized to the canonical whitelist form, set as the
 * active store symbol (which pre-loads candles + AI prediction + target
 * candles). A missing / non-normalizable symbol redirects to /dashboard.
 */
export default function ProTerminalPage() {
  return (
    <Suspense fallback={<ProTerminalShell />}>
      <ProTerminalInner />
    </Suspense>
  );
}

function ProTerminalShell() {
  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-obsidian text-slate-300 font-sans selection:bg-emerald-500/30 transition-colors duration-200">
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        <Header />
        <div className="flex-1 min-h-[300px] rounded-xl bg-obsidian flex items-center justify-center gap-2">
          <div className="w-8 h-8 rounded-full border-2 border-slate-600/60 border-t-blue-400 animate-spin" />
          <p className="text-xs font-mono text-slate-400 uppercase tracking-widest">
            Opening Terminal…
          </p>
        </div>
      </div>
    </div>
  );
}

function ProTerminalInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const {
    connected,
    socketStatus,
    reconnectAttempt,
    lastError,
    subscribeSymbol,
    unsubscribeSymbol,
    streamStalled,
    stalePrice,
    candleParityBreach,
  } = useWebSocket();
  const activeSymbol = useTradingStore(selectActiveSymbol);
  const currentPrice = useTradingStore(selectCurrentPrice);
  const predictionLoading = useTradingStore(selectIsLoading);
  const getPrediction = useTradingStore(selectGetPrediction);
  const setActiveSymbol = useTradingStore(selectSetActiveSymbol);
  const liveSignals = useTradingStore(selectLiveSignals);
  const selectedTimeframe = useTradingStore(selectSelectedTimeframe);
  const selectedExpirationSeconds = useTradingStore(selectSelectedExpiration);
  const setSelectedExpirationSeconds = useTradingStore(
    (s) => s.setSelectedExpirationSeconds,
  );
  // Full AI prediction payload — feeds the chart's target/anchor/ATR props
  // and seeds the aggregator with REAL backend OHLC history when present.
  const predictionData = useTradingStore((s) => s.predictionData);

  // PART 42.1 [422] — the feed-health bar must say MARKET CLOSED (never PRICE
  // STALE) when every REAL forex instrument is in its weekly closed window.
  // Returns a primitive so the page re-renders only on the transition, never on
  // the tick clock. OTC/crypto quotes are ignored (they are 24/7). When the
  // market-terminal store is unhydrated (direct Pro load) this stays false and
  // the bar behaves exactly as before.
  const realMarketClosed = useMarketTerminalStore((s) => {
    let anyReal = false;
    for (const key in s.quotes) {
      const q = s.quotes[key];
      if (q.assetSubType === "forex") {
        anyReal = true;
        if (!q.marketClosed) return false;
      }
    }
    return anyReal;
  });

  // ═══ THE ONE COHERENT SIGNAL VIEW ═══
  // Published by the chart (sole owner of the SignalHoldBuffer and of the
  // broker-grid `wallSec` clock) and consumed here for the CoherenceStrip.
  //
  // This is the fix for the "SIGNAL: WAITING" gap. The strip used to read the
  // RAW `predictionData.signal`, while the chart HUD read the stabilized view.
  // Because `fetchPrediction` (REST) and `applyLiveSignal` (WS) write that raw
  // field on different cadences, it transiently read `null` between them — so
  // the strip flashed HOLD/"WAITING" while the chart beside it correctly held
  // BUY. One view, both panels, no disagreement.
  //
  // Before the chart has published its first view (pre-mount / dynamic import
  // still resolving) we fall back to the raw field so the strip is never blank.
  // The fallback is one-way: `coherentView` is never reset to null, so the two
  // sources can never oscillate against each other and cause a flip-flop.
  const coherentView = useSignalViewStore(selectSignalView);
  const coherentSignal = coherentView
    ? coherentView.gatedSignal
    : (predictionData?.signal ?? null);
  const coherentTier = coherentView
    ? coherentView.tier
    : (predictionData?.tier ?? null);
  const coherentRegimeScoredOnly =
    coherentView?.suppressedReason === "regime_scored_only";
  // PART 40 [394]/[395] — regime gate + engine sub-reason for the Pro target
  // slot. Same precedence rule as the strip above: the published view is the
  // authority, the raw payload is the pre-first-publish fallback, and with
  // neither in hand the honest state is "awaiting", never a silent blank.
  const coherentRegimeGate = coherentView
    ? coherentView.regimeGate
    : (predictionData?.regime_gate ?? null);
  const coherentRegimeDetail = coherentView
    ? coherentView.regimeDetail
    : predictionData
      ? (predictionData?.suppressed_reason ?? null)
      : "awaiting_payload";
  // ── HYDRATION-SAFE TIMEFRAME RESTORE (deterministic "1m" SSR default) ──
  const hydrateSelectedTimeframe = useTradingStore(
    (s) => s.hydrateSelectedTimeframe,
  );

  const [selectedSymbol, setSelectedSymbol] = useState(activeSymbol);
  const appliedDeepLinkRef = useRef<string | null>(null);

  // ═══ FOCUS MODE (chart-only) ═══
  // Hides both side rails AND the AI panel so the chart owns the full viewport
  // for pure price action.
  //
  // INVARIANT 1: this is a single boolean in React state. It is read only by
  // layout classNames and is not an input to any store selector, the projection
  // matrix, or the aggregator. Toggling it re-renders the page exactly once per
  // click — the same cost as clicking a button anywhere else — and the tick
  // paint path never reads it, so it cannot add per-tick work. `default: false`
  // also keeps it out of the initial paint.
  const [focusMode, setFocusMode] = useState(false);
  const toggleFocusMode = useCallback(() => setFocusMode((v) => !v), []);

  // ═══ DEEP-LINK: read `?symbol=` + `&tf=`, normalize, redirect if absent ═══
  const querySymbol = searchParams?.get("symbol") ?? null;
  const queryTf = searchParams?.get("tf") ?? null;

  useEffect(() => {
    const deepLinkKey = `${querySymbol ?? ""}|${queryTf ?? ""}`;
    if (appliedDeepLinkRef.current === deepLinkKey) return;
    appliedDeepLinkRef.current = deepLinkKey;
    if (!querySymbol) return;
    const resolvedHere = resolveProSymbol(querySymbol);
    if ("redirect" in resolvedHere) {
      router.replace(resolvedHere.redirect);
      return;
    }
    // Pre-load: set the active store symbol → getPrediction effect below
    // pulls candles + AI signal + target, subscribe effect opens the tick
    // stream, and the aggregator re-seeds under the canonical symbol.
    const canon = resolvedHere.symbol;
    setSelectedSymbol(canon);
    setActiveSymbol(canon);
    // `&tf=` carries the Market Terminal's selected expiration (SECONDS);
    // snap it onto selectedExpirationSeconds so the Pro chart opens on the
    // SAME target horizon the card was displaying.
    const tfSecs = resolveTfParam(queryTf);
    if (tfSecs != null) setSelectedExpirationSeconds(tfSecs);
  }, [
    querySymbol,
    queryTf,
    router,
    setActiveSymbol,
    setSelectedExpirationSeconds,
  ]);

  useEffect(() => {
    setSelectedSymbol(activeSymbol);
  }, [activeSymbol]);

  // Re-apply the persisted timeframe AFTER mount, BEFORE the auto-fetch below,
  // so the first prediction request uses the user's real saved horizon.
  useEffect(() => {
    hydrateSelectedTimeframe();
  }, [hydrateSelectedTimeframe]);

  // Auto-fetch on symbol OR timeframe change (timeframe can change from settings page)
  useEffect(() => {
    const sym = (selectedSymbol || "").trim().toUpperCase();
    if (sym) {
      // `force` — a user-initiated re-sync must trigger an IMMEDIATE
      // evaluation, never sit silently behind the debounce.
      getPrediction(sym, selectedTimeframe, undefined, true);
    }
  }, [selectedSymbol, selectedTimeframe, getPrediction]);

  useEffect(() => {
    const norm = (selectedSymbol || "").trim().toUpperCase();
    if (!norm) return;
    subscribeSymbol(norm);
    return () => {
      unsubscribeSymbol(norm);
    };
  }, [selectedSymbol, subscribeSymbol, unsubscribeSymbol]);

  const handleSymbolSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const sym = (fd.get("symbol") as string)?.trim().toUpperCase();
      if (sym) {
        setSelectedSymbol(sym);
        setActiveSymbol(sym);
      }
    },
    [setActiveSymbol],
  );

  const unifiedPrice =
    Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 0;

  // ── CONNECTION STATE DERIVATIONS ──
  const engineLive = socketStatus === "connected" || connected;
  const enginePending =
    socketStatus === "connecting" || socketStatus === "reconnecting";
  const engineColor = engineLive
    ? "bg-emerald-500"
    : enginePending
      ? "bg-amber-400"
      : "bg-rose-500";
  const engineLabel = engineLive
    ? "ACTIVE"
    : socketStatus === "reconnecting"
      ? `RECONNECTING${reconnectAttempt > 0 ? ` #${reconnectAttempt}` : ""}`
      : socketStatus === "connecting"
        ? "CONNECTING"
        : "IDLE";
  const statusDetail =
    enginePending && lastError ? lastError : undefined;

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-obsidian text-slate-300 font-sans selection:bg-emerald-500/30 transition-colors duration-200">

      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        {/* ═══ UNIFIED TOP NAVBAR (logo, links, status, theme, language) ═══ */}
        <Header />

        {/* ═══ TERMINAL TOOLBAR (engine status + symbol submit + sync) ═══ */}
        <nav className="border-b border-slate-800/80 bg-obsidian/80 backdrop-blur-md sticky top-0 z-30 shrink-0">
          <div className="max-w-full mx-auto px-3 sm:px-4 md:px-6 h-14 sm:h-16 flex items-center justify-between">
            <div className="flex items-center gap-2 sm:gap-4">
              <h2 className="text-slate-100 font-bold text-[10px] sm:text-xs md:text-sm tracking-widest uppercase hidden xs:inline">
                Pro Terminal
              </h2>
              <div className="w-px h-4 bg-slate-800 hidden xs:block" />
              <div className="flex items-center gap-1.5 sm:gap-2">
                <div
                  className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${engineColor} ${enginePending ? "animate-pulse" : ""}`}
                  title={statusDetail}
                />
                <span
                  className="text-[9px] sm:text-[10px] font-mono text-slate-500 uppercase tracking-tighter"
                  title={statusDetail}
                >
                  <span className="hidden xs:inline">
                    Engine: {engineLabel}
                  </span>
                  <span className="xs:hidden">
                    {engineLive ? "ON" : enginePending ? "..." : "OFF"}
                  </span>
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-4">
              <form
                onSubmit={handleSymbolSubmit}
                className="flex items-center gap-1 sm:gap-2"
              >
                <input
                  name="symbol"
                  type="text"
                  placeholder="BTC/USDT"
                  value={selectedSymbol}
                  onChange={(e) => setSelectedSymbol(e.target.value)}
                  className="w-20 sm:w-24 md:w-28 bg-obsidian-950/80 border border-slate-700 rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs text-slate-100 font-mono placeholder-slate-500 focus:outline-none focus:border-emerald-500 min-h-[36px] sm:min-h-[40px]"
                />
                <button
                  type="submit"
                  disabled={predictionLoading}
                  className="text-[10px] bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white font-bold px-2 sm:px-3 py-1.5 rounded-lg transition-all min-h-[36px] sm:min-h-[40px]"
                >
                  {predictionLoading ? (
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span className="hidden xs:inline">...</span>
                    </span>
                  ) : (
                    "Go"
                  )}
                </button>
              </form>
              {/*
                FOCUS MODE — one click to an isolated, full-viewport chart.

                Deliberately a plain button in the existing toolbar rather than a
                floating overlay: overlays sit ON TOP of the canvas and occlude
                candles, and this control is *about* the chart, so it belongs in
                the same row as the symbol submit. It also stays reachable while
                the centre column scrolls, which a canvas-absolute control would
                not.
              */}
              <button
                type="button"
                onClick={toggleFocusMode}
                aria-pressed={focusMode}
                title={
                  focusMode
                    ? "Exit chart focus — show side rails"
                    : "Focus chart — hide side rails"
                }
                data-testid="focus-mode-toggle"
                className={
                  "text-[10px] font-bold px-2 sm:px-3 py-1.5 rounded-lg transition-all min-h-[36px] sm:min-h-[40px] shrink-0 " +
                  (focusMode
                    ? "bg-emerald-600 text-white hover:bg-emerald-500"
                    : "bg-obsidian-950/80 border border-slate-700 text-slate-300 hover:border-emerald-500/60 hover:text-emerald-400")
                }
              >
                <span className="hidden xs:inline">
                  {focusMode ? "Exit Focus" : "Focus"}
                </span>
                <span className="xs:hidden">{focusMode ? "Exit" : "Foc"}</span>
              </button>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <div
                  className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${engineColor} ${enginePending ? "animate-pulse" : ""}`}
                  title={statusDetail}
                />
                <span
                  className="text-[9px] sm:text-xs uppercase tracking-widest font-bold"
                  title={statusDetail}
                >
                  {engineLive ? (
                    <span className="text-emerald-400">Sync</span>
                  ) : enginePending ? (
                    <span className="text-amber-400">Syncing</span>
                  ) : (
                    <span className="text-rose-400">Err</span>
                  )}
                </span>
              </div>
            </div>
          </div>
        </nav>

        {/*
          FEED HEALTH — owns its own 1 Hz sampler internally.
          Only the change-gated booleans cross this boundary, so the page
          re-renders on state transitions only, never on the tick clock.
        */}
        <FeedHealthBar
          connected={connected}
          stale={stalePrice}
          stalled={streamStalled}
          marketClosed={realMarketClosed}
        />

        <main className="flex-1 min-h-0 p-3 sm:p-4 md:p-6 overflow-x-hidden overflow-y-auto custom-scrollbar xl:overflow-y-hidden">
          {/*
            PHASE 2 — STRUCTURAL HEIGHT MODEL (no `calc(100vh - N)` anywhere)
            ============================================================================
            The terminal is a FIXED-SHELL application, not a document. Height is
            propagated structurally:

              100dvh root → flex-col → [ Header (shrink-0) | toolbar (shrink-0)
               | feed health | main (flex-1 min-h-0) ] → grid (h-full) → the
               left rail and the operator rail each own one scrollport, and the
               centre column owns none (its two regions fit exactly).

            Two rules make this work, and both are load-bearing:

            1. `min-h-0` on every flex child in the chain. Without it a flex item
               refuses to shrink below its content size, so one tall rail re-inflates
               the whole shell and the page starts scrolling again.

            2. `xl:items-stretch` (the grid default) — NOT `items-start`. Under
               `items-start` every rail is exactly as tall as its own content, so a
               rail can never overflow, so its `overflow-y-auto` never engages, and
               any `sticky` child inside it has zero scroll range to travel. That is
               precisely why the TradingPanel's sticky wrapper was inert in Phase 1.
               Stretch gives all three rails the SAME definite height, which creates
               the scroll range and makes sticky live.

            RESPONSIVE SPLIT: below xl the page scrolls normally (touch UX, stacked
            columns). At xl it becomes the fixed 3-pane shell. One breakpoint, two
            coherent behaviours, no intermediate clipping state.
          */}
          <div
            className={
              "grid grid-cols-1 gap-3 sm:gap-4 md:gap-6 xl:h-full " +
              // FOCUS MODE collapses to a single full-width column. The rails are
              // still rendered in the DOM but `display: none` via the wrapper, so
              // no panel is unmounted and no store subscription is torn down —
              // entering and leaving focus is a pure layout operation, which is
              // what keeps it free of render or tick-path side effects.
              (focusMode
                ? "xl:grid-cols-[minmax(0,1fr)]"
                : "xl:grid-cols-[280px_minmax(0,1fr)_320px]")
            }
          >
            {/* ── CENTER — CoherenceStrip + pinned chart + full-width AI panel ── */}
            <section
              className={
                "order-1 xl:order-2 flex flex-col gap-3 sm:gap-4 min-w-0 min-h-0 " +
                // NORMAL: the AI panel now lives below the chart, so this column is
                // again a scrollport — and the chart is pinned inside it so scrolling
                // to the AI never scrolls the candles out of view.
                // FOCUS: no AI panel, so nothing overflows and no scrollport is
                // needed; the chart simply takes the whole column.
                (focusMode
                  ? "xl:overflow-hidden"
                  : "xl:overflow-y-auto xl:overflow-x-hidden custom-scrollbar")
              }
            >
              <ClientOnly
                fallback={
                  <>
                    <div className="min-h-[44px] w-full tp-card animate-pulse" />
                    <div className="w-full rounded-xl border border-[var(--tp-border)] bg-[var(--tp-surface)] animate-pulse h-[320px] xl:h-full min-h-0" />
                    {/* Reserves the matrix's footprint so the swap on hydrate
                        does not shift the scrollport. Must mirror the real
                        component's own height exactly (clamp 200-300px,
                        24vh) — a mismatch here hydrates into a visible jump. */}
                    {!focusMode && (
                      <div
                        data-testid="neural-matrix-fallback"
                        className="shrink-0 w-full min-w-0 h-[clamp(200px,24vh,300px)] rounded-xl border border-[var(--tp-border)] bg-[var(--tp-surface)] animate-pulse"
                      />
                    )}
                  </>
                }
              >
                {/*
                  COHERENCE STRIP — the fixed signal band across the top of the
                  centre column. It is chrome, not content: `shrink-0` so it
                  never gets squeezed by the chart below it.

                  Every signal-bearing prop comes from ONE `SignalHoldView`
                  (gatedSignal + tier + suppressedReason together). Reading
                  `signal` from one source and `tier` from another is precisely
                  how a WEAK badge ends up beside a full target projection, so
                  the three are deliberately taken as a single coherent read.
                */}
                {/*
                  PINNED HEADER SHELL — the strip and the chart are ONE sticky
                  unit, not two independently-scrolling siblings.

                  The bug this fixes: with the chart `sticky top-0 z-10` and
                  the strip merely `shrink-0`, scrolling the column moved the
                  strip up and UNDER the chart. The strip's own z-index is
                  `auto`, so the chart won every overlap and the
                  "TOO LATE TO ACT" badge was occluded — the reported
                  "badge overlapping headers" defect. Measured: the strip
                  reached top = -79px and its centre point hit-tested to the
                  chart, not the badge.

                  Sticking both together in one shell is the fix that needs no
                  magic offset and no z-index race: they are a single box, so
                  they cannot overlap each other, and `bg-[var(--tp-bg)]` is
                  REQUIRED on the shell — without an opaque background the
                  AI panel scrolling underneath would show through the gap.
                */}
                <div
                  data-testid="pinned-chart-shell"
                  className="sticky top-0 z-20 flex flex-col gap-3 sm:gap-4 bg-[var(--tp-bg)] pb-1"
                >
                  <ProExpiryBar
                    symbol={(selectedSymbol || activeSymbol).toUpperCase()}
                    currentPrice={unifiedPrice}
                    anchorPrice={predictionData?.current_price}
                    targetPrice={predictionData?.target_price}
                    signal={coherentSignal}
                    live={engineLive}
                    tier={coherentTier}
                    regimeScoredOnly={coherentRegimeScoredOnly}
                    regimeGate={coherentRegimeGate}
                    regimeDetail={coherentRegimeDetail}
                  />
                {/*
                  THE CHART.

                  It is a child of the pinned shell above, so it is already
                  pinned as part of that unit and needs NO `sticky` of its own —
                  two independently-sticky siblings is precisely what let the
                  chart slide over the strip.

                  NORMAL MODE — a definite, viewport-relative height
                  (`clamp(280px, 42vh, 520px)`) that is INDEPENDENT of the AI
                  panel below, so the panel's tall `min-h` can never starve the
                  chart back down to the ~228px Phase 2 failure.

                  FOCUS MODE — no AI panel below, so the chart is the only child
                  left and `flex-1 min-h-0` hands it the entire column: the
                  maximum possible price action, with rails and panel gone.

                  `min-h-0` is load-bearing wherever `flex-1` is used: without it
                  a flex item refuses to shrink below its content and re-inflates
                  the column, restarting the page scroll.
                */}
                <div
                  className={
                    "min-w-0 flex " +
                    (focusMode
                      ? "flex-1 min-h-0"
                      : "shrink-0 h-[clamp(280px,42vh,520px)]")
                  }
                >
                  <ErrorBoundary
                    resetKey={`${selectedSymbol}-${selectedTimeframe}`}
                  >
                    <FinancialChart
                      data={predictionData?.candles ?? []}
                      symbol={(selectedSymbol || activeSymbol).toUpperCase()}
                      timeframe={selectedTimeframe}
                      currentPrice={unifiedPrice}
                      predictedTargetPrice={predictionData?.target_price}
                      predictionAnchorPrice={predictionData?.current_price}
                      atr={
                        predictionData?.atr ??
                        predictionData?.scalping_indicators?.atr_14 ??
                        0
                      }
                      expirationSeconds={selectedExpirationSeconds}
                      signal={predictionData?.signal ?? null}
                      streamStalled={streamStalled}
                      stalePrice={stalePrice}
                      candleParityBreach={candleParityBreach}
                    />
                  </ErrorBoundary>
                </div>
                </div>
                {/* end pinned header shell — strip + chart move as one unit */}

                {/*
                  THE NEURAL MATRIX — full width, directly below the chart, inside
                  the SAME `ClientOnly` as the chart so the two hydrate together
                  and never disagree about a height.

                  This block REPLACES the old narrative AI panel. The panel stacked
                  static text below the candles, which is the same information the
                  operator already reads in the CoherenceStrip and the expiry bar;
                  the matrix instead shows the thing the prose could never show:
                  WHICH agents are hot, HOW MUCH signal is in flight, and HOW
                  CLOSE the fused verdict is to committing. It is the same block
                  footprint, so the scroll model below is unchanged.

                  WHY IT IS SAFE NEXT TO THE TICK LOOP (INVARIANT 1)
                  ------------------------------------------------------------
                  This is the load-bearing reason the component is a canvas and not
                  a list of animated divs. A React-rendered "live" readout must
                  subscribe to `currentPrice` to stay live — and that subscription
                  re-renders THIS PAGE on every packet. The matrix instead reads
                  the store through `getState()` inside its own rAF loop, so it
                  animates at display refresh while React stays idle.

                  The page therefore passes only TWO props, both cheap and both
                  change-gated: `symbol` (changes on a deep link / submit) and
                  `live` (a boolean the WebSocket hook already gates). No price,
                  no prediction object, no `liveSignals` array crosses this
                  boundary — a new prop here would be a new per-tick render.

                  `shrink-0` is still required for the same reason as before:
                  inside a scrollport, a flex child with a large floor and no
                  `shrink-0` is the classic "content silently clipped, never
                  scrollable" bug.

                  Hidden in FOCUS MODE — that mode is pure price action, and the
                  brief scopes the toggle to removing the panel below the chart.
                */}
                {!focusMode && (
                  <div
                    data-testid="ai-panel-below-chart"
                    className="shrink-0 w-full min-w-0"
                  >
                    <NeuralMatrixVisualizer
                      symbol={(selectedSymbol || activeSymbol).toUpperCase()}
                      live={engineLive}
                    />
                  </div>
                )}
              </ClientOnly>
            </section>

            {/* ── LEFT — market watch / live alpha stream (280px) ── */}
            <section
              data-testid="left-rail"
              className={
                "order-2 xl:order-1 flex flex-col gap-3 sm:gap-4 min-w-0 min-h-0 xl:overflow-y-auto xl:overflow-x-hidden xl:pr-1 custom-scrollbar " +
                (focusMode ? "hidden" : "")
              }
            >
              <div className="flex items-center justify-between sticky top-0 bg-[var(--tp-bg)]/85 backdrop-blur-sm py-2 z-10">
                <h2 className="text-[9px] sm:text-[10px] font-black text-ink-faint uppercase tracking-[0.2em]">
                  Market Watch
                </h2>
                <span className="text-[9px] sm:text-[10px] text-st-pos font-mono flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-st-pos animate-pulse" />
                  LIVE
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-[var(--tp-border)] bg-[var(--tp-elevated)] px-3 py-2">
                <span className="font-mono text-[11px] font-bold text-ink">
                  {(selectedSymbol || activeSymbol).toUpperCase()}
                </span>
                <span className="ml-auto font-mono text-[11px] tabular-nums text-st-pos">
                  {unifiedPrice > 0 ? unifiedPrice.toFixed(5) : "--"}
                </span>
              </div>
              {liveSignals.length > 0 ? (
                liveSignals.map((signal, idx) => (
                  <SignalWidget
                    key={`live-${signal?.symbol ?? "symbol"}-${signal?.id ?? signal?.timestamp ?? "ts"}-${idx}`}
                    signal={signal}
                  />
                ))
              ) : (
                <div className="py-12 sm:py-16 flex flex-col items-center justify-center tp-card">
                  <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-[var(--tp-elevated)] animate-pulse mb-3 sm:mb-4" />
                  <p className="text-ink-faint text-[10px] font-bold uppercase tracking-widest text-center px-4">
                    Scanning Market Pulse
                  </p>
                </div>
              )}
            </section>

            {/* ── RIGHT — operator rail: execution + depth (320px) ── */}
            {/*
              THE RAIL IS THE OPERATOR PANE'S SINGLE SCROLLPORT.

              Measured attempt-and-rejected: making the rail a non-scrolling
              flex column so only its children scrolled left the Order Book
              CLIPPED and unreachable (rail overflow 103px, rail not a
              scrollport). Removing a scrollport does not free space — the
              content still has to go somewhere reachable.

              So the rail owns the ONE scrollbar and nothing nests inside it:
                a) execution panel — NOT a scroll container, so its
                   `sticky bottom-0` CALL/PUT footer resolves against THIS rail
                b) Order Book — flows in the same column, no inner scroller
              Result: exactly one scrollbar per operator pane at every height.
            */}
            <section
              data-testid="right-rail"
              className={
                "order-3 flex flex-col gap-4 sm:gap-5 min-w-0 min-h-0 xl:overflow-y-auto xl:overflow-x-hidden custom-scrollbar " +
                (focusMode ? "hidden" : "")
              }
            >
              {/*
                OPERATOR RAIL — execution + depth, in this order:

                ┌ a) Execution panel ────────────────┐  top of rail
                │    CALL/PUT = sticky bottom-0 ──── │ │  pins to the RAIL's
                └────────────────────────────────────┘ ┘  bottom edge
                ┌ b) Order Book ───────────────────────┐
                └──────────────────────────────────────┘

                The AI panel is NOT here. It lives in the CENTRE column, full
                width, directly below the pinned chart. A 320px rail cannot hold
                it "spacious" — it forces a narrow single-file stack — and the
                narrative belongs beside the candles it describes. See the centre
                column for its placement.

                WHY THE PANEL IS *NOT* HEIGHT-CAPPED ANY MORE
                -------------------------------------------------
                The panel was once bounded to 85% of the rail so that
                `sticky top-0` would be legal: `position: sticky` cannot pin a
                box taller than its scrollport, and the panel's natural ~647px
                exceeded the ~602px rail at 1280x800, so it was pushed 45px
                ABOVE the rail with CALL/PUT clipped away.

                Capping it, however, forced TradingPanel to become its own
                scroller to fit inside the cap, and THAT is what created the
                nested scrollbar measured in the browser (rail 208px of overflow
                containing a panel scrolling 136px). Capping solved one bug by
                causing another.

                The fix removes the need for a cap entirely. The panel root is
                now `overflow-clip` — not a scroll container — so the footer's
                `sticky bottom-0` resolves against the RAIL, the rail's own
                single scrollbar scrolls the whole stack, and neither the sticky
                footprint nor the nested-scrollbar problem can occur at any
                window height. Do not reintroduce `max-h-[85%]` here: it is only
                safe if the panel is also a scroll container, and that is exactly
                the nested-scroller combination just removed.

                `stalePrice` is passed explicitly because TradingPanel REQUIRES
                it: it is what makes the panel treat a quiet tape as a dead
                stream instead of enabling execution against stale prices.
              */}
              {/*
                THE PINNED EXECUTION PANEL — first in the stack, so it owns the
                rail's top, and NOT a scroll container of its own.

                `bg-[var(--tp-bg)]` is opaque and REQUIRED: while the rail
                scrolls, the panel's pinned top overlaps the book flowing
                beneath it, and a transparent box would let the book show
                through the panel's gaps.
              */}
              <div
                data-testid="pinned-execution-panel"
                className="sticky top-0 z-20 shrink-0 flex flex-col bg-[var(--tp-bg)]"
              >
                <ErrorBoundary>
                  <TradingPanel stalePrice={stalePrice} />
                </ErrorBoundary>
              </div>

              {/*
                ORDER BOOK — no inner scroller. An earlier `xl:max-h-[320px]
                xl:overflow-y-auto` here was one of the two nested scrollports;
                the rail's single scrollbar reaches the book instead.
              */}
              <div className="shrink-0">
                <h2 className="text-[9px] sm:text-[10px] font-black text-ink-faint uppercase tracking-[0.2em]">
                  Order Book
                </h2>
                <div className="mt-3">
                  <ErrorBoundary>
                    <OrderBook
                      symbol={selectedSymbol}
                      currentPrice={unifiedPrice}
                    />
                  </ErrorBoundary>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}