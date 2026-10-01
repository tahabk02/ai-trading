"use client";

import React from "react";
import { useMarketTerminal } from "@/hooks/useMarketTerminal";
import {
  useMarketTerminalStore,
  ALL_MARKET_SYMBOLS,
  selectTerminalConnected,
  selectAssetClasses,
  selectFavorites,
  selectHiddenSymbols,
  selectSymbolQuery,
  selectFavoritesOnly,
  selectGlobalHorizon,
  selectTerminalPredictions,
  selectTerminalVerdicts,
  selectMinConfidencePct,
  selectMinTier,
  selectHideBelowThreshold,
} from "@/store/useMarketTerminalStore";
import { HorizonSelector } from "./horizon-selector";
import {
  AssetClassFilterPills,
  AssetSymbolSearch,
  AssetFilterStatus,
  FavoritesOnlyToggle,
} from "./asset-class-filter";
import { ConfidenceFilter } from "./confidence-filter";
import { TierSelector } from "./tier-selector";
import { AssetCard } from "./asset-card";
import { cn } from "@/utils/cn";
import {
  cardEffectiveConfidence,
  isBelowConfidenceBar,
} from "@/lib/minConfidenceFilter";
import { applyAssetFilter } from "@/lib/assetFilter";

/**
 * MARKET TERMINAL — the all-pairs grid (Alpha.5 Pro main dashboard).
 *
 * Streaming topology (single joined WS channel, no 44× replays):
 *   • `market_quotes`     — 1Hz all-pair price / spread / tick-count snapshots
 *   • `live_quant_signal` — 1Hz micro-quant CALL/PUT verdicts for every pair
 *   • /multi-predict      — heavier per-horizon refresh (debounced) when the
 *                           GLOBAL or a card's horizon changes
 *
 * GLOBAL horizon selector applies to every card; each card can also override
 * its own horizon (that override is cleared the moment the global changes).
 *
 * ALL_44_LAYOUT — PART 15: the grid renders the full 44-instrument universe
 * (32 OTC + 10 REAL + 2 crypto). REAL pairs carry the REAL badge and are
 * scored-only until [47]/[48] regime verification is explicitly confirmed.
 */
export const MarketTerminal: React.FC = () => {
  const {
    connected,
    setGlobalHorizon,
    setCardHorizon,
    refreshNow,
    setMinConfidencePct,
    setMinTier,
    toggleHideBelowThreshold,
  } = useMarketTerminal();
  const globalHorizon = useMarketTerminalStore(selectGlobalHorizon);
  const assetClasses = useMarketTerminalStore(selectAssetClasses);
  const favorites = useMarketTerminalStore(selectFavorites);
  const hiddenSymbols = useMarketTerminalStore(selectHiddenSymbols);
  const symbolQuery = useMarketTerminalStore(selectSymbolQuery);
  const favoritesOnly = useMarketTerminalStore(selectFavoritesOnly);
  const connectedFlag = useMarketTerminalStore(selectTerminalConnected);
  // Confidence Filter — subscribed live so the grid demotes/hides the instant
  // the slider moves (no waiting for the throttled engine re-dispatch).
  const minConfidencePct = useMarketTerminalStore(selectMinConfidencePct);
  // Tier Selector — same live-subscription rationale: cards re-render the
  // moment the operator changes the band they trade.
  const minTier = useMarketTerminalStore(selectMinTier);
  const hideBelowThreshold = useMarketTerminalStore(selectHideBelowThreshold);
  const predictions = useMarketTerminalStore(selectTerminalPredictions);
  const verdicts = useMarketTerminalStore(selectTerminalVerdicts);

  const live = connected && connectedFlag;

  const symbols = React.useMemo(() => {
    // ASSET FILTER — classification is STATIC (registry-backed), never derived
    // from live quotes. The previous implementation read
    // `getState().quotes[sym]?.assetSubType` inside this memo, which is a
    // non-reactive read: before the first `market_quotes` snapshot every
    // `sub` was `undefined`, and once a PARTIAL snapshot landed the non-empty
    // result suppressed the fallback — so selecting "Real" mid-boot could
    // render an arbitrary subset (3 of 10 pairs) with no error surfaced.
    // `applyAssetFilter` is pure and always sees the full universe.
    const base = applyAssetFilter(ALL_MARKET_SYMBOLS, {
      classes: assetClasses,
      favorites,
      hidden: hiddenSymbols,
      query: symbolQuery,
      favoritesOnly,
    });

    // Confidence Filter (hide mode): physically remove pairs whose measurable
    // confidence is below the active bar. Cards with no confidence yet (still
    // evaluating / market-waiting) are NEVER hidden.
    if (!hideBelowThreshold) return base;
    const kept = base.filter((sym) => {
      const pred = predictions[sym];
      const verdict = verdicts[sym];
      const conf = cardEffectiveConfidence(
        pred?.confidence,
        verdict?.confidence,
      );
      return !isBelowConfidenceBar(conf, minConfidencePct);
    });
    return kept;
  }, [
    assetClasses,
    favorites,
    hiddenSymbols,
    symbolQuery,
    favoritesOnly,
    hideBelowThreshold,
    minConfidencePct,
    predictions,
    verdicts,
  ]);

  const hiddenCount = React.useMemo(
    () => ALL_MARKET_SYMBOLS.length - symbols.length,
    [symbols.length],
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-term-canvas text-term-ink">
      {/* ── TERMINAL TOOLBAR ── */}
      <nav className="border-b border-term-line bg-term-canvas/85 backdrop-blur-md sticky top-0 z-30 shrink-0">
        <div className="max-w-full mx-auto px-3 sm:px-4 md:px-6 min-h-14 py-2 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-term-ink font-bold text-[11px] sm:text-xs tracking-tight whitespace-nowrap">
              Market terminal
            </h2>
            <div className="w-px h-4 bg-term-line hidden sm:block" />
            <div className="flex items-center gap-1.5">
              <div
                className={cn(
                  "w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full",
                  live ? "bg-bull animate-pulse" : "bg-bear",
                )}
              />
              <span className="num-fig text-[9px] sm:text-[10px] text-term-ink-dim uppercase tracking-tighter">
                {live
                  ? `Streaming ${ALL_MARKET_SYMBOLS.length} pairs`
                  : "Connecting…"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Asset filtering is NEVER gated on feed health, tier, or tradability —
                a disabled filter reads as "this data is unavailable". */}
            <AssetSymbolSearch />
            <AssetClassFilterPills />
            <FavoritesOnlyToggle />
            <AssetFilterStatus />
            <ConfidenceFilter
              value={minConfidencePct}
              hideBelow={hideBelowThreshold}
              onCommit={setMinConfidencePct}
              onToggleHide={toggleHideBelowThreshold}
            />
            <TierSelector value={minTier} onCommit={setMinTier} />
            <HorizonSelector
              value={globalHorizon}
              onChange={setGlobalHorizon}
              size="md"
            />
            <button
              onClick={() => refreshNow()}
              className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-chip border border-term-line text-term-ink-dim hover:text-term-ink hover:border-term-ink-faint cursor-pointer transition-[transform,background-color,color] duration-75 active:scale-90 whitespace-nowrap"
            >
              Refresh
            </button>
          </div>
        </div>
      </nav>

      {/* ── Grid ── */}
      <main className="flex-1 p-3 sm:p-4 md:p-5 overflow-y-auto custom-scrollbar min-h-0">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
          {symbols.map((sym) => (
            <AssetCard
              key={sym}
              symbol={sym}
              onHorizonChange={setCardHorizon}
            />
          ))}
        </div>
        <p className="mt-4 text-center text-[8px] text-term-ink-faint num-fig uppercase tracking-widest">
          All {ALL_MARKET_SYMBOLS.length} · OTC 32 · Real 10 · Crypto 2 —
          live micro-quant verdicts · 60% definitive gate · Conf bar{" "}
          {minConfidencePct.toFixed(1)}% · {symbols.length} shown
          {hiddenCount > 0 ? ` · ${hiddenCount} below bar hidden` : ""}
        </p>
      </main>
    </div>
  );
};