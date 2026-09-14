"use client";

import { useEffect, useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { ClientOnly } from "@/components/shared/client-only";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { OrderBook } from "@/components/trading/order-book";
import { Header } from "@/components/shared/header";

// ── CLIENT-ONLY CHART ISOLATION ──
// ZERO-MOCK POLICY: this route previously embedded an external TradingView
// widget fed THIRD-PARTY BINANCE symbols — visually real-looking candles that
// had nothing to do with the platform's own OTC feed. That legacy engine has
// been purged (tv-chart.tsx deleted). The ONLY chart allowed here is the
// platform's own lightweight-charts candlestick engine driven exclusively by
// the live WebSocket tick stream.
// The candlestick engine measures the DOM and touches browser-only APIs
// during construction — rendering it during SSR produces markup that can
// never match the client's first paint (React Hydration Error). ssr:false
// guarantees the chart mounts exclusively inside the browser.
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
import { PredictiveIntelligence } from "@/components/trading/predictive-intelligence";
import { SignalWidget } from "@/components/trading/signal-widget";
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

export default function DashboardPage() {
  const {
    connected,
    socketStatus,
    reconnectAttempt,
    lastError,
    usingFallbackUrl,
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
  // Full AI prediction payload — feeds the chart's target/anchor/ATR props
  // and seeds the aggregator with REAL backend OHLC history when present.
  const predictionData = useTradingStore((s) => s.predictionData);
  // ── HYDRATION-SAFE TIMEFRAME RESTORE (deterministic "1m" SSR default) ──
  const hydrateSelectedTimeframe = useTradingStore(
    (s) => s.hydrateSelectedTimeframe,
  );

  const [selectedSymbol, setSelectedSymbol] = useState(activeSymbol);

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
      // evaluation, never sit silently behind the 5s /predict debounce.
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
  // Drive the toolbar pills from the granular socket state machine so the UI
  // never lies about the transport (and never flashes IDLE during the brief
  // reconnection backoff): ACTIVE (green) ↔ SYNCING/RECONNECTING (amber) ↔ IDLE.
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
    enginePending && lastError
      ? `${usingFallbackUrl ? "(via fallback) " : ""}${lastError}`
      : undefined;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-obsidian text-slate-300 font-sans selection:bg-emerald-500/30 transition-colors duration-200">

      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        {/* ═══ UNIFIED TOP NAVBAR (logo, links, status, theme, language) ═══ */}
        <Header />

        {/* ═══ TERMINAL TOOLBAR (engine status + symbol submit + sync) ═══ */}
        <nav className="border-b border-slate-800/80 bg-obsidian/80 backdrop-blur-md sticky top-0 z-30 shrink-0">
          <div className="max-w-full mx-auto px-3 sm:px-4 md:px-6 h-14 sm:h-16 flex items-center justify-between">
            <div className="flex items-center gap-2 sm:gap-4">
              <h2 className="text-slate-100 font-bold text-[10px] sm:text-xs md:text-sm tracking-widest uppercase hidden xs:inline">
                Live Terminal
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
                  className="w-20 sm:w-24 md:w-28 bg-obsidian-950/80 border border-slate-700 rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs text-white font-mono placeholder-slate-500 focus:outline-none focus:border-emerald-500 min-h-[36px] sm:min-h-[40px]"
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

        <main className="flex-1 p-3 sm:p-4 md:p-6 overflow-x-hidden overflow-y-auto custom-scrollbar">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-6 min-h-0">
            <section className="lg:col-span-1 space-y-3 sm:space-y-4 max-h-[40vh] lg:max-h-[calc(100vh-140px)] overflow-y-auto overflow-x-hidden pr-0 lg:pr-2 custom-scrollbar min-h-0">
              <div className="flex items-center justify-between mb-1 sm:mb-2 sticky top-0 bg-obsidian/80 backdrop-blur-sm py-2 z-10">
                <h2 className="text-[9px] sm:text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                  Alpha Stream
                </h2>
                <span className="text-[9px] sm:text-[10px] text-emerald-400 font-mono flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  LIVE
                </span>
              </div>
              {liveSignals.length > 0 ? (
                liveSignals.map((signal, idx) => (
                  <SignalWidget
                    // STRICTLY UNIQUE key: symbol + per-signal id/timestamp +
                    // index. Two WS events sharing the identical millisecond
                    // timestamp previously collided (both got the same id),
                    // which produced React duplicate-key warnings in the
                    // Alpha Stream list.
                    key={`live-${signal?.symbol ?? "symbol"}-${signal?.id ?? signal?.timestamp ?? "ts"}-${idx}`}
                    signal={signal}
                  />
                ))
              ) : (
                <div className="py-12 sm:py-20 flex flex-col items-center justify-center border border-slate-800 bg-obsidian-900/40 rounded-2xl">
                  <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-slate-800/70 animate-pulse mb-3 sm:mb-4" />
                  <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest text-center px-4">
                    Scanning Market Pulse
                  </p>
                </div>
              )}
            </section>

            <section className="lg:col-span-3 space-y-3 sm:space-y-4 md:space-y-6 min-w-0">
              <ClientOnly
                fallback={
                  <>
                    <div className="min-h-[300px] w-full rounded-xl border border-slate-800 bg-obsidian-900/60 animate-pulse" />
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
                      <div className="md:col-span-1 min-h-[220px] rounded-xl border border-slate-800 bg-obsidian-900/60 animate-pulse" />
                      <div className="md:col-span-2 min-h-[220px] rounded-xl border border-slate-800 bg-obsidian-900/60 animate-pulse" />
                    </div>
                  </>
                }
              >
              <div className="min-h-[300px] w-full">
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
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
                <div className="md:col-span-1 w-full">
                  <ErrorBoundary>
                    <OrderBook
                      symbol={selectedSymbol}
                      currentPrice={unifiedPrice}
                    />
                  </ErrorBoundary>
                </div>
                <div className="md:col-span-2 w-full">
                  <ErrorBoundary>
                    <PredictiveIntelligence symbol={selectedSymbol} />
                  </ErrorBoundary>
                </div>
              </div>
              </ClientOnly>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
