"use client";

/**
 * asset-class-filter.tsx — MARKET TERMINAL ASSET FILTER BAR.
 *
 * Multi-select venue classes (OTC / Real / Crypto), a free-text pair+currency
 * search, and a favorites-only isolate toggle. Every visible control is
 * ALWAYS enabled: filtering is a view concern, never gated on market state,
 * feed health, or the operator's tradability tier. A disabled filter control
 * reads as "this data is unavailable" and, when the underlying cause is a
 * not-yet-landed quote snapshot, is indistinguishable from a broken app.
 *
 * Classification comes from the static registry (`lib/assetFilter`), NOT from
 * live quotes — see the module header for why that distinction matters.
 */

import React from "react";
import { useMarketTerminalStore, ALL_MARKET_SYMBOLS } from "@/store/useMarketTerminalStore";
import {
  ASSET_CLASSES,
  ASSET_CLASS_LABEL,
  countVisible,
  countVisibleByClass,
  isFilterActive,
  isShowingEverything,
  TOTAL_SYMBOL_COUNT,
  type AssetClass,
  type AssetFilterState,
} from "@/lib/assetFilter";
import { cn } from "@/utils/cn";

function useFilterState(): AssetFilterState {
  const classes = useMarketTerminalStore((s) => s.assetClasses);
  const favorites = useMarketTerminalStore((s) => s.favorites);
  const hiddenSymbols = useMarketTerminalStore((s) => s.hiddenSymbols);
  const symbolQuery = useMarketTerminalStore((s) => s.symbolQuery);
  const favoritesOnly = useMarketTerminalStore((s) => s.favoritesOnly);
  return { classes, favorites, hidden: hiddenSymbols, query: symbolQuery, favoritesOnly };
}

/**
 * The class pill row. Counts are computed against the OTHER active predicates
 * (favorites / hidden / query) but NOT against class isolation, so toggling a
 * class never zeroes out every badge and makes the control look dead.
 */
export const AssetClassFilterPills: React.FC = () => {
  const state = useFilterState();
  const toggleAssetClass = useMarketTerminalStore((s) => s.toggleAssetClass);
  const setAssetClasses = useMarketTerminalStore((s) => s.setAssetClasses);

  // The badge counts are always computed against the FULL universe, never the
  // post-filter list, so isolating a class cannot zero out every badge. That
  // makes `symbols` a module constant rather than something derived from the
  // filter state, so there is nothing to memoise.
  const counts = React.useMemo(
    () => countVisibleByClass(ALL_MARKET_SYMBOLS, state),
    [state],
  );
  const visible = React.useMemo(() => countVisible(ALL_MARKET_SYMBOLS, state), [state]);
  const showingAll = isShowingEverything(state.classes);

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Asset class filter">
      {ASSET_CLASSES.map((cls) => {
        const active = state.classes.includes(cls);
        const count = counts[cls];
        return (
          <button
            key={cls}
            type="button"
            onClick={() => toggleAssetClass(cls)}
            aria-pressed={active}
            title={
              active
                ? `Stop isolating ${ASSET_CLASS_LABEL[cls]} (showing all classes)`
                : `Isolate ${ASSET_CLASS_LABEL[cls]} (${count} pair${count === 1 ? "" : "s"})`
            }
            data-testid={`asset-class-${cls}`}
            className={cn(
              "text-[9px] sm:text-[10px] px-2 py-0.5 rounded-chip font-bold tracking-wider border cursor-pointer transition-[transform,background-color,color] duration-75 active:scale-90",
              active
                ? "bg-term-ink text-term-canvas border-term-ink"
                : "bg-transparent text-term-ink-faint border-transparent hover:text-term-ink-dim",
            )}
          >
            {ASSET_CLASS_LABEL[cls]}
            <span className="num-fig ml-1 opacity-70">{count}</span>
          </button>
        );
      })}

      {/* Explicit "show everything" — the multi-select set has no implicit
          "all" state, so the operator needs a one-click way back. */}
      <button
        type="button"
        onClick={() => setAssetClasses([])}
        disabled={showingAll}
        aria-pressed={showingAll}
        title={showingAll ? "Already showing every asset class" : "Show every asset class"}
        data-testid="asset-class-all"
        className={cn(
          "text-[9px] sm:text-[10px] px-2 py-0.5 rounded-chip font-bold tracking-wider border cursor-pointer transition-[transform,background-color,color] duration-75 active:scale-90",
          showingAll
            ? "bg-term-panel text-term-ink-dim border-term-line cursor-default"
            : "bg-transparent text-term-ink-faint border-transparent hover:text-term-ink-dim",
        )}
      >
        All
        <span className="num-fig ml-1 opacity-70">{visible}</span>
      </button>
    </div>
  );
};

/** Free-text search across pair symbol, either leg, or the compact form. */
export const AssetSymbolSearch: React.FC = () => {
  const query = useMarketTerminalStore((s) => s.symbolQuery);
  const setSymbolQuery = useMarketTerminalStore((s) => s.setSymbolQuery);
  return (
    <input
      type="search"
      value={query}
      onChange={(e) => setSymbolQuery(e.target.value)}
      placeholder="Filter pairs or currencies…"
      aria-label="Filter pairs or currencies"
      data-testid="asset-symbol-search"
      className="text-[9px] sm:text-[10px] px-2 py-0.5 rounded-chip bg-transparent text-term-ink placeholder:text-term-ink-faint border border-transparent focus:border-term-line focus:outline-none"
    />
  );
};

/** Isolate toggle: show ONLY pinned favorites. */
export const FavoritesOnlyToggle: React.FC = () => {
  const favoritesOnly = useMarketTerminalStore((s) => s.favoritesOnly);
  const favorites = useMarketTerminalStore((s) => s.favorites);
  const setFavoritesOnly = useMarketTerminalStore((s) => s.setFavoritesOnly);
  return (
    <button
      type="button"
      onClick={() => setFavoritesOnly(!favoritesOnly)}
      aria-pressed={favoritesOnly}
      disabled={favorites.length === 0}
      title={
        favorites.length === 0
          ? "Pin a pair (★) to build a favorites view"
          : favoritesOnly
            ? "Show every pair"
            : `Show only my ${favorites.length} favorite${favorites.length === 1 ? "" : "s"}`
      }
      data-testid="asset-favorites-only"
      className={cn(
        "text-[9px] sm:text-[10px] px-2 py-0.5 rounded-chip font-bold tracking-wider border cursor-pointer transition-[transform,background-color,color] duration-75 active:scale-90",
        favoritesOnly
          ? "bg-term-gold text-term-canvas border-term-gold"
          : "bg-transparent text-term-ink-faint border-transparent hover:text-term-ink-dim",
        favorites.length === 0 && "cursor-not-allowed opacity-40",
      )}
    >
      ★
      <span className="num-fig ml-1 opacity-70">{favorites.length}</span>
    </button>
  );
};

/**
 * "N of M shown" readout + Clear. Rendered by the terminal header so the
 * operator always knows whether an empty grid is the filter's doing.
 */
export const AssetFilterStatus: React.FC = () => {
  const state = useFilterState();
  const resetAssetFilter = useMarketTerminalStore((s) => s.resetAssetFilter);
  const universe = TOTAL_SYMBOL_COUNT;

  // Deliberately NOT subscribed to the quote stream. `countVisible` matches
  // against the symbol universe and the filter predicates only, so a tick
  // cannot change the result; subscribing to `_quoteVersion` here re-rendered
  // this readout on every price update for a number that never moved.
  const visible = React.useMemo(() => countVisible(ALL_MARKET_SYMBOLS, state), [state]);

  if (!isFilterActive(state)) return null;
  return (
    <span className="flex items-center gap-1.5 text-[9px] sm:text-[10px] text-term-ink-faint">
      <span className="num-fig">
        {visible} of {universe} shown
      </span>
      <button
        type="button"
        onClick={resetAssetFilter}
        title="Clear every asset filter"
        data-testid="asset-filter-clear"
        className="underline underline-offset-2 cursor-pointer hover:text-term-ink-dim transition-[color,opacity] duration-75 active:opacity-60"
      >
        Clear
      </button>
    </span>
  );
};

export default AssetClassFilterPills;
