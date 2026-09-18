"use client";

import React from "react";
import { useMarketTerminal } from "@/hooks/useMarketTerminal";
import {
  useMarketTerminalStore,
  ALL_MARKET_SYMBOLS,
  selectTerminalConnected,
  selectTerminalFilter,
  selectGlobalHorizon,
} from "@/store/useMarketTerminalStore";
import { HorizonSelector } from "./horizon-selector";
import { AssetClassFilterPills } from "./asset-class-filter";
import { AssetCard } from "./asset-card";

/**
 * MARKET TERMINAL — the all-pairs grid (Alpha.5 Pro main dashboard).
 *
 * Streaming topology (single joined WS channel, no 34× replays):
 *   • `market_quotes`     — 1Hz all-pair price / spread / tick-count snapshots
 *   • `live_quant_signal` — 1Hz micro-quant CALL/PUT verdicts for every pair
 *   • /multi-predict      — heavier per-horizon refresh (debounced) when the
 *                           GLOBAL or a card's horizon changes
 *
 * GLOBAL horizon selector applies to every card; each card can also override
 * its own horizon (that override is cleared the moment the global changes).
 */
export const MarketTerminal: React.FC = () => {
  const { connected, setGlobalHorizon, setCardHorizon, refreshNow } =
    useMarketTerminal();
  const globalHorizon = useMarketTerminalStore(selectGlobalHorizon);
  const filter = useMarketTerminalStore(selectTerminalFilter);
  const connectedFlag = useMarketTerminalStore(selectTerminalConnected);

  const live = connected && connectedFlag;

  const symbols = React.useMemo(() => {
    if (filter === "all") return ALL_MARKET_SYMBOLS;
    const defs = ALL_MARKET_SYMBOLS.map((sym) => ({
      sym,
      sub: useMarketTerminalStore.getState().quotes[sym]?.assetSubType,
    }));
    const byQuote = defs.filter((d) => d.sub === filter).map((d) => d.sym);
    return byQuote.length > 0
      ? byQuote
      : // Quotes may not have landed yet — fall back to the static registry so a
        // brand-new grid still renders every OTC/crypto pair immediately.
        ALL_MARKET_SYMBOLS.filter((sym) => {
          // Registry-driven filter: OTC pairs have label "… OTC"; crypto majors
          // are BTC/USD + ETH/USD.
          if (filter === "crypto") return /^BTC\/USD$|^ETH\/USD$/.test(sym);
          return true;
        });
  }, [filter]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── TERMINAL TOOLBAR ── */}
      <nav className="border-b border-[var(--tp-border)] bg-header-sheen backdrop-blur-md sticky top-0 z-30 shrink-0">
        <div className="max-w-full mx-auto px-3 sm:px-4 md:px-6 min-h-14 py-2 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-slate-100 font-bold text-[11px] sm:text-xs tracking-widest uppercase whitespace-nowrap">
              Market Terminal
            </h2>
            <div className="w-px h-4 bg-slate-800 hidden sm:block" />
            <div className="flex items-center gap-1.5">
              <div
                className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${
                  live ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                }`}
              />
              <span className="text-[9px] sm:text-[10px] font-mono text-slate-500 uppercase tracking-tighter">
                {live ? "STREAMING 34 PAIRS" : "CONNECTING…"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <AssetClassFilterPills
              value={filter}
              onChange={(f) => useMarketTerminalStore.getState().setFilter(f)}
            />
            <HorizonSelector
              value={globalHorizon}
              onChange={setGlobalHorizon}
              size="md"
            />
            <button
              onClick={() => refreshNow()}
              className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors whitespace-nowrap"
            >
              Refresh
            </button>
          </div>
        </div>
      </nav>

      {/* ── Grid ── */}
      <main className="flex-1 p-3 sm:p-4 md:p-5 overflow-y-auto custom-scrollbar min-h-0">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5 sm:gap-3">
          {symbols.map((sym) => (
            <AssetCard
              key={sym}
              symbol={sym}
              onHorizonChange={setCardHorizon}
            />
          ))}
        </div>
        <p className="mt-4 text-center text-[8px] text-slate-600 font-mono uppercase tracking-widest">
          Live micro-quant verdicts · 60% definitive gate · {symbols.length} of{" "}
          {ALL_MARKET_SYMBOLS.length} instruments
        </p>
      </main>
    </div>
  );
};