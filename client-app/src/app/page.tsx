"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useTradingStore } from "@/store/useTradingStore";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useLang } from "@/hooks/useLang";
import { ClientOnly } from "@/components/shared/client-only";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { KillSwitchBanner } from "@/components/shared/kill-switch-banner";
import { OrderBook } from "@/components/trading/order-book";
import { Header } from "@/components/shared/header";

// ── CLIENT-ONLY CHART ISOLATION ──
// The candlestick engine (lightweight-charts) measures the DOM and touches
// window APIs during construction. Rendering it on the server produces HTML
// that cannot match the client's first paint → React Hydration Error:
// "Hydration failed because the initial UI does not match what was rendered
// on the server". next/dynamic with ssr:false guarantees the chart module is
// NEVER evaluated during SSR/SSG — it mounts exclusively in the browser.
const FinancialChart = dynamic(
  () =>
    import("@/components/trading/financial-chart").then(
      (m) => m.FinancialChart,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full min-h-[300px] rounded-xl border border-slate-800 bg-[#0F1420] flex flex-col items-center justify-center gap-2">
        <div className="w-8 h-8 rounded-full border-2 border-slate-600/60 border-t-blue-400 animate-spin" />
        <p className="text-xs font-mono text-slate-400 uppercase tracking-widest">
          Loading Live Chart
        </p>
      </div>
    ),
  },
);
import { SignalWidget } from "@/components/trading/signal-widget";
import { AIExplanation } from "@/components/trading/ai-explanation";
import { TradingPanel } from "@/components/trading/trading-panel";
import { ALL_SYMBOL_TICKERS, getPairLabel } from "@/constants/symbols";
import { cn } from "@/utils/cn";
import { t } from "@/utils/i18n";
import { TIMEFRAME_MS, type Timeframe } from "@/lib/realtimeCandleAggregator";

// ── Preset symbols for the quick-select dropdown ──
const POPULAR_SYMBOLS = ALL_SYMBOL_TICKERS;

// ── Trading panel collapse persistence ──
const LS_TRADING_PANEL_COLLAPSED = "trading_panel_collapsed";

function getTradingPanelPersisted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(LS_TRADING_PANEL_COLLAPSED) === "true";
  } catch {
    return false;
  }
}

// ============================================================
// MAIN PAGE — POCKET OPTION EXACT LAYOUT
// Sidebar (self-contained collapse) | Center (Chart+AI+OrderBook) | Right Trading Panel
// ============================================================

export default function DashboardPage() {
  // ════════════════════════════════════════════════════════════════════════
  // ABSOLUTE-TOP HOOK SECTION — every hook precedes ANY derived value,
  // conditional, or return statement, so React's hook-order bookkeeping never
  // sees a reordered/conditional call (no "changed the order of Hooks" error).
  // No conditionals or early returns exist above this block.
  // ════════════════════════════════════════════════════════════════════════

  const { lang, rtl } = useLang();

  // ── HYDRATION-SAFE PERSISTED STATE ──
  // useState(getTradingPanelPersisted()) read localStorage DURING the first
  // render: the server rendered collapsed=false while a browser with persisted
  // state rendered true → mismatched classNames/aria attributes → React
  // "Hydration failed because the initial UI does not match what was rendered
  // on the server". Initialize deterministically; restore AFTER mount below.
  const [tradingPanelCollapsed, setTradingPanelCollapsed] = useState(false);

  const toggleTradingPanel = useCallback(() => {
    setTradingPanelCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LS_TRADING_PANEL_COLLAPSED, String(next));
      } catch {}
      return next;
    });
  }, []);

  // Restore the persisted collapse state only AFTER mount (hydration-safe).
  useEffect(() => {
    setTradingPanelCollapsed(getTradingPanelPersisted());
  }, []);

  // ── WebSocket (unconditional, always mounted) ──
  const {
    connected,
    isScanning,
    subscribeSymbol,
    unsubscribeSymbol,
    streamStalled,
    stalePrice,
    socketStatus,
    reconnectAttempt,
    usingFallbackUrl,
    lastError,
  } = useWebSocket();

  // ── Store (all selectors are hooks — declared here at the top) ──
  const activeSymbol = useTradingStore((s) => s.activeSymbol);
  const predictionData = useTradingStore((s) => s.predictionData);
  const getPrediction = useTradingStore((s) => s.getPrediction);
  const setActiveSymbol = useTradingStore((s) => s.setActiveSymbol);
  const liveSignals = useTradingStore((s) => s.liveSignals);
  const selectedTimeframe = useTradingStore((s) => s.selectedTimeframe);
  const storeCurrentPrice = useTradingStore((s) => s.currentPrice);
  const setExpirationSeconds = useTradingStore((s) => s.setExpirationSeconds);
  const expirationSeconds = useTradingStore((s) => s.expirationSeconds);
  const hydrateSelectedTimeframe = useTradingStore(
    (s) => s.hydrateSelectedTimeframe,
  );

  // ── Derived data — use the STORE's unified currentPrice (single source of truth) ──
  // The live WebSocket tick stream is the single authoritative source for
  // `currentPrice`. A /predict HTTP response's `current_price` is ONLY used as
  // a provisional seed before the first tick arrives. Eliminating the fallback
  // to `predictionData?.current_price` removes the second price source that
  // caused the trading-panel ticker and chart to desync/regress on timeframe
  // change (when a /predict fetch stamps a stale price over the fresher live
  // value).
  const currentPrice = storeCurrentPrice;
  const chartData = predictionData?.candles ?? [];

  // ── GRANULAR CONNECTION STATE (reconnect / fallback indicators) ──
  // Mirrors the terminal toolbar state machine instead of a binary live/offline
  // dot: RECONNECTING (amber) flicks during exponential-backoff retries, and
  // `lastError` / `usingFallbackUrl` ride the tooltip so a refused backend
  // (ERR_CONNECTION_REFUSED) surfaces as a hint, never as a console spam.
  const engineLive = socketStatus === "connected" || connected;
  const enginePending =
    socketStatus === "connecting" || socketStatus === "reconnecting";
  const engineDot = engineLive
    ? "bg-emerald-500"
    : enginePending
      ? "bg-amber-400"
      : "bg-rose-500";
  const engineLabel = engineLive
    ? t(lang, "engineActive")
    : socketStatus === "reconnecting"
      ? `${t(lang, "engineReconnecting")}${
          reconnectAttempt > 0 ? ` #${reconnectAttempt}` : ""
        }`
      : socketStatus === "connecting"
        ? t(lang, "engineConnecting")
        : t(lang, "engineOffline");
  const statusDetail =
    enginePending && lastError
      ? `${usingFallbackUrl ? t(lang, "viaFallback") : ""}${lastError}`
      : usingFallbackUrl
        ? t(lang, "viaFallback")
        : undefined;

  // ── LIVE CANDLE-CLOSE COUNTDOWN (Pocket-style expiry clock) ──
  // Wall-clock aligned to the active timeframe bucket exactly like the
  // backend aggregator: closes at :00/:01/:02... for 1m/2m/3m buckets.
  const [msUntilClose, setMsUntilClose] = useState(0);

  // ── LIVE PRICE DIRECTION FLASH ──
  // Colors the live price green/red against the PREVIOUS observed tick so
  // users see genuine per-tick market direction streaming off the socket.
  const prevPriceRef = useRef(0);
  const [priceDirection, setPriceDirection] = useState<"up" | "down" | "flat">(
    "flat",
  );

  // ── Derive live price direction from real ticks ──
  useEffect(() => {
    if (currentPrice > 0 && prevPriceRef.current > 0) {
      if (currentPrice > prevPriceRef.current) setPriceDirection("up");
      else if (currentPrice < prevPriceRef.current) setPriceDirection("down");
    }
    if (currentPrice > 0) prevPriceRef.current = currentPrice;
  }, [currentPrice]);

  // ── Local UI state ──
  const [selectedSymbol, setSelectedSymbol] = useState(activeSymbol);
  const [searchInput, setSearchInput] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const [filteredSymbols, setFilteredSymbols] = useState(POPULAR_SYMBOLS);

  // ── HYDRATION-SAFE TIMEFRAME RESTORE (mount) ──
  useEffect(() => {
    hydrateSelectedTimeframe();
  }, [hydrateSelectedTimeframe]);

  // ── Sync selected symbol into local state ──
  useEffect(() => {
    setSelectedSymbol(activeSymbol);
  }, [activeSymbol]);

  // ── Sync timeframe to expiration when changed ──
  useEffect(() => {
    // Full horizon range: 1 minute → 10 days — the AI projection line on the
    // chart stretches forward EXACTLY this far (ATR × √horizon math).
    const tfToSecs: Record<string, number> = {
      "1s": 1,
      "5s": 5,
      "20s": 20,
      "1m": 60,
      "2m": 120,
      "3m": 180,
      "5m": 300,
      "10m": 600,
      "15m": 900,
      "20m": 1200,
      "25m": 1500,
      "30m": 1800,
      "35m+": 2100,
      "1h": 3600,
      "4h": 14400,
      "1d": 86400,
      "2d": 172800,
      "3d": 259200,
      "5d": 432000,
      "10d": 864000,
    };
    const secs = tfToSecs[selectedTimeframe];
    if (secs && secs !== expirationSeconds) {
      setExpirationSeconds(secs);
    }
  }, [selectedTimeframe, expirationSeconds, setExpirationSeconds]);

  // ── CANDLE-CLOSE COUNTDOWN LOOP (Pocket-style expiry clock) ──
  useEffect(() => {
    const bucketMs =
      TIMEFRAME_MS[selectedTimeframe as Timeframe] ?? TIMEFRAME_MS["1m"];
    const tick = () => setMsUntilClose(bucketMs - (Date.now() % bucketMs));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [selectedTimeframe]);

  // ── Fetch prediction + subscribe on mount/symbol change ──
  useEffect(() => {
    const normalized = selectedSymbol.trim().toUpperCase();
    if (!normalized) return;
    getPrediction(normalized);
    subscribeSymbol(normalized);
    return () => {
      unsubscribeSymbol(normalized);
    };
  }, [selectedSymbol, getPrediction, subscribeSymbol, unsubscribeSymbol]);

  // ── Filter dropdown ──
  useEffect(() => {
    if (!searchInput.trim()) {
      setFilteredSymbols(POPULAR_SYMBOLS);
      return;
    }
    const q = searchInput.toUpperCase();
    setFilteredSymbols(POPULAR_SYMBOLS.filter((s) => s.includes(q)));
  }, [searchInput]);

  // ── Close dropdown on outside click ──
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // ── Select a symbol ──
  const selectSymbol = useCallback(
    (symbol: string) => {
      const normalized = symbol.trim().toUpperCase();
      if (!normalized) return;
      setSelectedSymbol(normalized);
      setActiveSymbol(normalized);
      setSearchInput("");
      setDropdownOpen(false);
      getPrediction(normalized);
    },
    [getPrediction, setActiveSymbol],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const sym = searchInput.trim().toUpperCase();
      if (sym) selectSymbol(sym);
    },
    [searchInput, selectSymbol],
  );

  // ════════════════════════════════════════════════════════════════════════
  // DERIVED VALUES (no hooks below this point — safe, deterministic)
  // ════════════════════════════════════════════════════════════════════════

  // ── Dynamic grid spans for Pocket Option 3-column layout ──
  // Mobile: 1 column, Tablet(MD): 3 columns, Desktop(XL): 12 columns
  const CENTER_COL_CLASS = tradingPanelCollapsed
    ? "md:col-span-3 xl:col-span-9"
    : "md:col-span-2 xl:col-span-7";

  const PANEL_COL_CLASS = tradingPanelCollapsed
    ? "md:col-span-0 xl:col-span-1"
    : "md:col-span-1 xl:col-span-3";

  return (
    <div
      className="flex h-screen w-screen overflow-hidden bg-obsidian text-slate-300 font-sans selection:bg-blue-500/30 fixed inset-0 transition-colors duration-200"
      dir={rtl ? "rtl" : "ltr"}
    >
      {/* ── MAIN CONTENT AREA: flex column (unified top-nav + terminal bar + grid) ── */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* ═══ UNIFIED TOP NAVBAR (logo, links, status, theme, language) ═══ */}
        <Header />

        {/* ═══ TERMINAL TOOLBAR (live price, countdown, symbol search) ═══ */}
        <nav className="border-b border-slate-800 bg-obsidian/80 backdrop-blur-xl shrink-0 z-30">
          <div className="max-w-full mx-auto px-4 lg:px-6 h-12 sm:h-14 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-slate-900 dark:text-white font-bold text-xs tracking-widest uppercase">
                {t(lang, "liveTerminal")}
              </h2>
              <div className="w-px h-3 bg-slate-300 dark:bg-slate-800" />
              {/* ── LIVE PRICE TICKER (real socket-driven price + direction) ── */}
              <span
                className={cn(
                  "font-mono text-xs font-bold tabular-nums transition-colors duration-150",
                  priceDirection === "up"
                    ? "text-emerald-500 dark:text-emerald-400"
                    : priceDirection === "down"
                      ? "text-rose-500 dark:text-rose-400"
                      : "text-slate-700 dark:text-slate-300",
                )}
              >
                {currentPrice > 0 ? currentPrice.toFixed(5) : "—"}
              </span>
              <div className="w-px h-3 bg-slate-300 dark:bg-slate-800" />
              {/* ── CANDLE CLOSE COUNTDOWN (mm:ss until active bucket rolls) ── */}
              <span className="font-mono text-[10px] text-blue-600 dark:text-blue-400 font-bold tabular-nums">
                {String(Math.floor(msUntilClose / 60000)).padStart(2, "0")}:
                {String(Math.floor((msUntilClose % 60000) / 1000)).padStart(
                  2,
                  "0",
                )}
              </span>
              <div className="w-px h-3 bg-slate-300 dark:bg-slate-800" />
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "w-1.5 h-1.5 rounded-full animate-pulse",
                    engineDot,
                  )}
                  title={statusDetail}
                />
                <span
                  className="text-[9px] font-mono text-slate-500 uppercase tracking-tighter"
                  title={statusDetail}
                >
                  {engineLabel}
                </span>
              </div>
            </div>

            {/* Symbol Search */}
            <div ref={searchRef} className="relative">
              <form onSubmit={handleSubmit}>
                <div className="relative">
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => {
                      setSearchInput(e.target.value);
                      setDropdownOpen(true);
                    }}
                    onFocus={() => setDropdownOpen(true)}
                    placeholder={t(lang, "search")}
                    className="w-36 lg:w-44 bg-slate-100 dark:bg-slate-950 border border-slate-300 dark:border-slate-700/50 rounded-lg pl-2.5 pr-7 py-1 text-xs text-slate-900 dark:text-white font-mono placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-blue-500 shadow-sm"
                  />
                  <button
                    type="submit"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </button>
                </div>
              </form>
              {dropdownOpen && (
                <div className="absolute top-full right-0 mt-1 w-52 bg-obsidian-950 border border-slate-700/60 rounded-xl overflow-hidden shadow-2xl z-50 max-h-36 overflow-y-auto">
                  {filteredSymbols.length > 0 ? (
                    filteredSymbols.map((sym) => (
                      <button
                        key={sym}
                        type="button"
                        onClick={() => selectSymbol(sym)}
                        className={cn(
                          "w-full text-left px-3 py-1.5 text-xs font-mono transition-colors",
                          sym === activeSymbol
                            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 font-bold"
                            : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white",
                        )}
                      >
                        {sym}{" "}
                        {sym === activeSymbol && (
                          <span className="float-right text-[9px] text-blue-500 font-bold">
                            {t(lang, "active")}
                          </span>
                        )}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-xs text-slate-500 text-center">
                      {t(lang, "noMatches")}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </nav>

        {/* ═══ KILL SWITCH / DAILY DRAWDOWN RISK GUARD ═══ */}
        <KillSwitchBanner />

        {/* ═══ 3-COLUMN GRID — POCKET OPTION LAYOUT ═══ */}
        <main className="flex-1 overflow-hidden">
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-2 lg:gap-3 h-full p-2 lg:p-3">
            {/* ── LEFT COLUMN: Alpha Stream Feed ── */}
            <section
              className={cn(
                "xl:col-span-2 overflow-y-auto custom-scrollbar pr-1",
              )}
              style={{ maxHeight: "calc(100vh - 48px)" }}
            >
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em]">
                  {t(lang, "alphaStream")}
                </h2>
                <span className="text-[9px] text-blue-400 font-mono">
                  {t(lang, "live")}
                </span>
              </div>

              {liveSignals.length > 0 ? (
                liveSignals.map((sig, idx) => {
                  const rawType = sig.signalType ?? sig.signal_type ?? "";
                  const mappedType =
                    rawType === "BUY"
                      ? ("BUY" as const)
                      : rawType === "SELL"
                        ? ("SELL" as const)
                        : undefined;
                  return (
                    <SignalWidget
                      // STRICTLY UNIQUE key: symbol + per-signal id/timestamp +
                      // index (same-ms collisions previously made `live-${Date.now()}`
                      // ids duplicate, tripping React key warnings).
                      key={`live-${sig?.symbol ?? "symbol"}-${sig?.id ?? sig?.timestamp ?? "ts"}-${idx}`}
                      signal={{
                        id: sig.id,
                        symbol: sig.symbol,
                        signalType: mappedType,
                        createdAt: sig.createdAt ?? sig.timestamp ?? undefined,
                        confidence: sig.confidence,
                        price: sig.price,
                      }}
                    />
                  );
                })
              ) : (
                <div className="py-6 flex flex-col items-center justify-center border border-slate-800 bg-slate-900/20 rounded-xl space-y-2">
                  <div className="relative w-10 h-10">
                    <div
                      className={cn(
                        "absolute inset-0 rounded-full border-2",
                        isScanning
                          ? "border-blue-500/40 border-t-blue-400 animate-spin"
                          : "border-slate-700",
                      )}
                    />
                    <div
                      className={cn(
                        "absolute inset-1.5 rounded-full flex items-center justify-center",
                        isScanning
                          ? "bg-blue-500/20 animate-pulse"
                          : "bg-slate-800/50",
                      )}
                    >
                      <div
                        className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          engineDot,
                          isScanning ? "animate-ping" : "",
                        )}
                      />
                    </div>
                  </div>
                  <div className="text-center">
                    <p className="text-slate-400 text-[9px] font-bold uppercase tracking-widest">
                      {isScanning
                        ? t(lang, "scanningMarket")
                        : t(lang, "scannerIdle")}
                    </p>
                    <p className="text-slate-500 text-[8px] font-mono mt-0.5">
                      {isScanning
                        ? `${getPairLabel(activeSymbol)} · ${t(lang, "interval")}`
                        : socketStatus === "reconnecting"
                          ? `${t(lang, "engineReconnecting")}${reconnectAttempt > 0 ? ` #${reconnectAttempt}` : ""}${usingFallbackUrl ? ` · ${t(lang, "viaFallback")}` : ""}`
                          : socketStatus === "connecting"
                            ? t(lang, "waitingConnection")
                            : `${t(lang, "disconnected")}${usingFallbackUrl ? ` · ${t(lang, "viaFallback")}` : ""}`}
                    </p>
                  </div>
                </div>
              )}
            </section>

            {/* ── CENTER COLUMN: Chart + AI Explanation + Order Book ── */}
            <section
              className={cn(
                CENTER_COL_CLASS,
                "flex flex-col h-full w-full overflow-y-auto relative",
              )}
            >
              {/* ── PARENT-LEVEL HYDRATION GUARD ──
                  The entire center column (chart + AI explanation + order
                  book) mounts client-side behind a deterministic skeleton,
                  so the SSR HTML and the browser's first paint are 100%
                  identical — eliminating any section-level hydration drift
                  coming from ANY child of this subtree. */}
              <ClientOnly
                fallback={
                  <>
                    {/* Skeleton mirrors the chart block's fluid min-heights */}
                    <div className="min-h-[280px] sm:min-h-[350px] md:min-h-[400px] lg:min-h-[450px] flex-shrink-0 w-full rounded-xl border border-slate-800 bg-slate-900/50 animate-pulse" />
                    {/* Skeleton mirrors the AI/OB grid footprint */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 lg:gap-4 w-full flex-shrink-0 mt-3 md:mt-4">
                      <div className="md:col-span-2 h-[220px] rounded-xl border border-slate-800 bg-slate-900/50 animate-pulse" />
                      <div className="md:col-span-1 h-[220px] rounded-xl border border-slate-800 bg-slate-900/50 animate-pulse" />
                    </div>
                  </>
                }
              >
              {/* Chart — fluid height: smaller on mobile, larger on desktop */}
              <div className="min-h-[280px] sm:min-h-[350px] md:min-h-[400px] lg:min-h-[450px] flex-shrink-0">
                <ErrorBoundary
                  resetKey={`${activeSymbol}-${selectedTimeframe}`}
                >
                  <FinancialChart
                    data={chartData}
                    symbol={activeSymbol}
                    timeframe={selectedTimeframe}
                    currentPrice={currentPrice}
                    predictedTargetPrice={predictionData?.target_price}
                    predictionAnchorPrice={predictionData?.current_price}
                    atr={
                      predictionData?.atr ??
                      predictionData?.scalping_indicators?.atr_14 ??
                      0
                    }
                    projectionMinutes={expirationSeconds / 60}
                    signal={predictionData?.signal ?? null}
                    lookaheadHorizon={5}
                    streamStalled={streamStalled}
                    stalePrice={stalePrice}
                  />
                </ErrorBoundary>
              </div>

              {/* AI Analysis + Order Book */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 lg:gap-4 w-full flex-shrink-0 mt-3 md:mt-4">
                <div className="md:col-span-2">
                  <ErrorBoundary>
                    <AIExplanation />
                  </ErrorBoundary>
                </div>
                <div className="md:col-span-1">
                  <ErrorBoundary>
                    <OrderBook
                      symbol={selectedSymbol}
                      currentPrice={currentPrice}
                    />
                  </ErrorBoundary>
                </div>
              </div>
              </ClientOnly>
            </section>

            {/* ── RIGHT COLUMN: Trading Panel (collapsible) ── */}
            <section className={cn(PANEL_COL_CLASS, "relative")}>
              <div className="relative h-full">
                <div
                  className={cn(
                    "transition-all duration-300 ease-in-out overflow-hidden",
                    tradingPanelCollapsed ? "w-0" : "w-full",
                  )}
                >
                  <ErrorBoundary>
                    <TradingPanel stalePrice={stalePrice} />
                  </ErrorBoundary>
                </div>
                {/* Panel toggle button — always visible */}
                <button
                  onClick={toggleTradingPanel}
                  className={cn(
                    "absolute top-1/2 -translate-y-1/2 z-50 w-6 h-10 bg-slate-800 border border-slate-700 rounded-l-lg flex items-center justify-center hover:bg-slate-700 transition-colors shadow-lg",
                    tradingPanelCollapsed ? "left-0" : "-left-3",
                  )}
                  aria-label={
                    tradingPanelCollapsed
                      ? "Expand trading panel"
                      : "Collapse trading panel"
                  }
                >
                  <span className="text-xs text-slate-400 font-mono select-none">
                    {tradingPanelCollapsed ? "◀" : "▶"}
                  </span>
                </button>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
