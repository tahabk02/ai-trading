"use client";

import { Suspense, useEffect, useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import { ClientOnly } from "@/components/shared/client-only";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { OrderBook } from "@/components/trading/order-book";
import { Header } from "@/components/shared/header";
import { resolveProSymbol, resolveTfParam } from "@/lib/pro-deep-link";

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
import { PredictiveIntelligence } from "@/components/trading/predictive-intelligence";
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
    <div className="flex h-screen w-full overflow-hidden bg-obsidian text-slate-300 font-sans selection:bg-emerald-500/30 transition-colors duration-200">
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
  // ── HYDRATION-SAFE TIMEFRAME RESTORE (deterministic "1m" SSR default) ──
  const hydrateSelectedTimeframe = useTradingStore(
    (s) => s.hydrateSelectedTimeframe,
  );

  const [selectedSymbol, setSelectedSymbol] = useState(activeSymbol);

  // ═══ DEEP-LINK: read `?symbol=` + `&tf=`, normalize, redirect if absent ═══
  const querySymbol = searchParams?.get("symbol") ?? null;
  const queryTf = searchParams?.get("tf") ?? null;

  useEffect(() => {
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
    <div className="flex h-screen w-full overflow-hidden bg-obsidian text-slate-300 font-sans selection:bg-emerald-500/30 transition-colors duration-200">

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

        <main className="flex-1 min-h-0 p-3 sm:p-4 md:p-6 overflow-x-hidden overflow-y-auto custom-scrollbar">
          {/*
            3-COLUMN PRO LAYOUT (≥1280px):
              LEFT   280px  — market watch / live alpha stream
              CENTER   1fr  — the chart centerpiece (≥60% viewport) + AI panel
              RIGHT  320px  — order book + execution context
            Below xl the columns stack, chart first.
          */}
          <div className="grid grid-cols-1 gap-3 sm:gap-4 md:gap-6 xl:grid-cols-[280px_minmax(0,1fr)_320px] xl:items-start">
            {/* ── CENTER — chart centerpiece (ordered first on mobile) ── */}
            <section className="order-1 xl:order-2 space-y-3 sm:space-y-4 md:space-y-6 min-w-0">
              <ClientOnly
                fallback={
                  <>
                    <div className="min-h-[300px] w-full tp-card animate-pulse" />
                    <div
                      className="w-full rounded-xl border border-[var(--tp-border)] bg-[var(--tp-surface)] animate-pulse h-[calc(100vh-320px)] min-h-[500px]"
                    />
                  </>
                }
              >
                <div className="w-full">
                  <ProExpiryBar
                    symbol={(selectedSymbol || activeSymbol).toUpperCase()}
                    currentPrice={unifiedPrice}
                    anchorPrice={predictionData?.current_price}
                    targetPrice={predictionData?.target_price}
                    signal={predictionData?.signal ?? null}
                    live={engineLive}
                  />
                </div>
                <div className="w-full">
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
                <div className="w-full">
                  <ErrorBoundary>
                    <PredictiveIntelligence symbol={selectedSymbol} />
                  </ErrorBoundary>
                </div>
              </ClientOnly>
            </section>

            {/* ── LEFT — market watch / live alpha stream (280px) ── */}
            <section className="order-2 xl:order-1 space-y-3 sm:space-y-4 min-w-0 xl:max-h-[calc(100vh-140px)] xl:overflow-y-auto xl:overflow-x-hidden xl:pr-1 custom-scrollbar">
              <div className="flex items-center justify-between sticky top-0 bg-[var(--tp-bg)]/85 backdrop-blur-sm py-2 z-10">
                <h2 className="text-[9px] sm:text-[10px] font-black text-ink-faint uppercase tracking-[0.2em]">
                  Market Watch
                </h2>
                <span className="text-[9px] sm:text-[10px] text-emerald-400 font-mono flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  LIVE
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-[var(--tp-border)] bg-[var(--tp-elevated)] px-3 py-2">
                <span className="font-mono text-[11px] font-bold text-ink">
                  {(selectedSymbol || activeSymbol).toUpperCase()}
                </span>
                <span className="ml-auto font-mono text-[11px] tabular-nums text-emerald-500">
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

            {/* ── RIGHT — order book + execution context (320px) ── */}
            <section className="order-3 space-y-4 min-w-0">
              <div className="flex items-center justify-between">
                <h2 className="text-[9px] sm:text-[10px] font-black text-ink-faint uppercase tracking-[0.2em]">
                  Order Book
                </h2>
              </div>
              <ErrorBoundary>
                <OrderBook symbol={selectedSymbol} currentPrice={unifiedPrice} />
              </ErrorBoundary>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}