"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { TrendingUp, TrendingDown, Activity, ChevronDown, Filter } from "lucide-react";
import { cn } from "@/utils/cn";
import { getPairLabel, getQuoteCurrency } from "@/constants/symbols";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";
import { HorizonSelector } from "./horizon-selector";
import { useMarketTerminalStore, type HorizonMinutes } from "@/store/useMarketTerminalStore";
import { buildProHref, suppressCardNav } from "@/lib/pro-deep-link";
import { realForexCardBehavior } from "@/lib/realForexRegime";
import {
  cardEffectiveConfidence,
  isBelowConfidenceBar,
} from "@/lib/minConfidenceFilter";
import { resolveCardTier, tierClearsSelection } from "@/lib/tierFilter";
import { quoteProvenance } from "@/lib/quoteProvenance";
import { TierBadge } from "@/components/shared/tier-badge";

interface AssetCardProps {
  symbol: string;
  onHorizonChange?: (symbol: string, horizon: HorizonMinutes) => void;
}

/**
 * MARKET TERMINAL CELL — PART 16 flat-obsidian blotter matrix redesign.
 *
 * Four ruled rows, hairline-separated, one flat panel tone, NO card shadow
 * and NO hover-lift anywhere in the grid:
 *
 *   ┌─────────────────────────────────────┐
 *   │ EUR/USD OTC                [OTC]    │  row 1 — symbol + class chip
 *   │ 1.08452              ▲ +0.00012 s   │  row 2 — tabular PRICE (flash on
 *   │                                        tick) + delta / spread / ticks
 *   │ [CALL 62.4%]  [H5m SYNC]            │  row 3 — verdict strip (LIVE +
 *   │ ███████████▌ (confidence bar)       │          horizon) + confidence bar
 *   │ ─────────────────────────────────── │
 *   │ 1m 2m 3m 5m 10m          PRO ▾      │  row 4 — expiry pills + Pro deep-link
 *   └─────────────────────────────────────┘
 *
 * Everything a trader needs stays on the card — live + horizon verdicts,
 * confidence bar + %, spread, delta, tick-pressure count, expiry selector and
 * the Pro deep-link are all preserved. What changed is the container: flat
 * panel, hairline rules, 4px terminal radius, one deliberate palette, and the
 * ONE motion moment = price-tick flash (tabular figures, so digits never
 * jitter and columns hold steady).
 *
 * PART 15 [51] REAL-FOREX REGIME GATE is untouched (HARD RULE):
 *   • scored-only cards keep role=undefined, tabIndex=-1, aria-disabled,
 *     NO PRO button, NO horizon pills, NO confidence bar, NO hover strip;
 *   • the card reads price + SCORED-ONLY/REGIME status only.
 *   • realForexCardBehavior / resolveRealForexRegimeDisplay drive it exactly
 *     as before — the redesign must not silently re-introduce an interactive
 *     affordance on a scored-only card.
 */
const AssetCardImpl: React.FC<AssetCardProps> = ({ symbol, onHorizonChange }) => {
  const router = useRouter();
  const quote = useMarketTerminalStore((s) => s.quotes[symbol]);
  const verdict = useMarketTerminalStore((s) => s.verdicts[symbol]);
  const prediction = useMarketTerminalStore((s) => s.predictions[symbol]);
  const horizon = useMarketTerminalStore((s) => s.resolveHorizon(symbol));
  const minConfidencePct = useMarketTerminalStore((s) => s.minConfidencePct);
  const minTier = useMarketTerminalStore((s) => s.minTier);

  // ── FILTER PINS (view-only curation, independent of tradability) ──
  const isFavorite = useMarketTerminalStore((s) => s.favorites.includes(symbol));
  const isHidden = useMarketTerminalStore((s) => s.hiddenSymbols.includes(symbol));
  const toggleFavorite = useMarketTerminalStore((s) => s.toggleFavorite);
  const toggleHidden = useMarketTerminalStore((s) => s.toggleHidden);

  // PART 15 [51] / PART 28.2 [214]/[215] — real-forex regime display driven
  // by the payload regime_gate (intraday engine verdict). Tradable →
  // interactive like OTC; random_walk → scored-only; null → pending.
  const regime = realForexCardBehavior(
    symbol,
    (prediction?.data as { regime_gate?: string | null } | null)?.regime_gate,
  );
  const scoredOnly = regime.scoredOnly;

  // ── CONFIDENCE FILTER DEMOTION ──
  // A pair whose measurable confidence is strictly below the operator's bar
  // renders SCORED-ONLY-style (non-interactive, "BELOW {bar}% BAR") until the
  // bar is lowered — mirroring the engine's executable:false verdict sent on
  // the same filter. No measurable confidence (waiting) is never demoted.
  const filterConf = cardEffectiveConfidence(
    prediction?.confidence,
    verdict?.confidence,
  );
  const demotedByFilter =
    !scoredOnly && isBelowConfidenceBar(filterConf, minConfidencePct);

  // ── TIER SELECTOR DEMOTION (flexible tiers) ──
  // A verdict whose HONEST band sits below the operator's selected floor is
  // shown, but not interactive — the same treatment a below-bar confidence
  // gets. Crucially the card still DISPLAYS its real tier/tier_label: we never
  // relabel it, so a T3 signal reads "T3 MEDIUM", not a rewritten T5.
  const cardTier = resolveCardTier(prediction?.data, verdict);
  const demotedByTier =
    !scoredOnly && !demotedByFilter && !tierClearsSelection(cardTier, minTier);
  const interactive = !scoredOnly && !demotedByFilter && !demotedByTier;
  const nonInteractiveTitle = scoredOnly
    ? regime.nonInteractiveTitle
    : demotedByFilter
      ? `Confidence below the ${minConfidencePct.toFixed(1)}% filter bar — lower the Confidence Filter to trade.`
      : demotedByTier
        ? `${cardTier ?? "This"} is below your ${minTier} trade floor — select a lower tier to trade it.`
        : undefined;

  const proHref = React.useMemo(
    () => buildProHref(symbol, horizon * 60),
    [symbol, horizon],
  );

  const handleHorizonChange = (h: HorizonMinutes) => {
    if (!interactive) return; // scored-only / below-bar cards never re-aim an expiration
    if (onHorizonChange) {
      onHorizonChange(symbol, h);
      return;
    }
    useMarketTerminalStore.getState().setCardHorizon(symbol, h);
  };

  const openPro = React.useCallback(() => {
    if (!interactive) return; // non-interactive — no trade action from this card
    router.push(proHref);
  }, [router, proHref, interactive]);

  const handleCardKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPro();
    }
  };

  // ── LIVE (1Hz micro-quant) verdict ──
  const liveWaiting = verdict?.market_waiting === true;
  const liveDir = !liveWaiting && verdict?.direction ? verdict.direction : null;
  const liveConf =
    verdict && Number.isFinite(verdict.confidence) ? verdict.confidence : 0;

  // ── HORIZON (heavier /multi-predict) verdict ──
  const horizonPending = prediction?.status === "pending";
  const horizonData = prediction?.status === "ok" ? prediction : null;
  const horizonDir = horizonData?.direction ?? null;
  const horizonConf = horizonData?.confidence ?? null;
  const horizonWaiting = horizonData?.market_waiting === true;

  const price = quote?.price ?? null;
  const digits = quote?.digits ?? 5;
  const priceText = price != null ? price.toFixed(digits) : "--";
  const spreadText = quote?.spread != null ? quote.spread.toFixed(digits) : "--";
  const quoteCcy = getQuoteCurrency(symbol);
  const tickCount = quote?.tickCount ?? 0;
  const ticksText = tickCount >= 1000 ? `${(tickCount / 1000).toFixed(1)}k` : String(tickCount);

  // ── PART 16 [58] PRICE-TICK FLASH (the ONE motion moment) ──
  // A ref holds the PREVIOUS price; when the new price differs we stamp a
  // direction and key the rendered <span> on the price string so React
  // restates the element → the 450ms CSS flash replays per tick. The flash
  // colours ARE the candle hues (bull/bear). prefers-reduced-motion degrades
  // it to a static colour change (see the .price-flash-* guards in globals).
  const prevPriceRef = React.useRef<number | null>(null);
  const prevPrice = prevPriceRef.current;
  let flashDir: "up" | "down" | null = null;
  if (price != null) {
    if (prevPrice != null && prevPrice !== price) {
      flashDir = prevPrice < price ? "up" : "down";
    }
    prevPriceRef.current = price;
  }
  const delta = price != null && prevPrice != null ? price - prevPrice : null;

  const hasAnySignal = Boolean(liveDir) || Boolean(horizonDir);

  const liveBadge = liveDir ? (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-chip font-bold text-[9px] leading-none",
        liveDir === "BUY" ? "bg-bull/15 text-bull border border-bull/40" : "bg-bear/15 text-bear border border-bear/40",
      )}
    >
      {liveDir === "BUY" ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
      {liveDir === "BUY" ? "CALL" : "PUT"}
    </span>
  ) : liveWaiting ? (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-chip font-bold text-[9px] leading-none text-gold bg-gold/10 border border-gold/40">
      <Activity size={10} />
      WAITING
    </span>
  ) : null;

  const horizonBadge =
    horizonPending ? (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-chip font-semibold text-[9px] leading-none text-term-ink-dim border border-term-line bg-term-panel">
        <span className="w-2.5 h-2.5 border border-term-ink-dim border-t-transparent rounded-full animate-spin" />
        H{horizon}m SYNC
      </span>
    ) : horizonDir ? (
      <span
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-chip font-bold text-[9px] leading-none",
          horizonDir === "BUY" ? "bg-bull/12 text-bull border border-bull/35" : "bg-bear/12 text-bear border border-bear/35",
        )}
      >
        {horizonDir === "BUY" ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
        H{horizon}m {horizonDir === "BUY" ? "CALL" : "PUT"}
      </span>
    ) : horizonWaiting ? (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-chip font-semibold text-[9px] leading-none text-gold bg-gold/10 border border-gold/40">
        <Activity size={10} />
        H{horizon}m WAITING
      </span>
    ) : null;

  const confPct = liveDir && liveConf > 0 ? liveConf.toFixed(1) : null;
  const confBarWidth = confPct != null ? Math.max(0, Math.min(100, liveConf)) : 0;

  const spreadLine = interactive ? (
    <span className="num-fig text-[8px] leading-tight text-term-ink-faint">
      {spreadText} spr · {ticksText}
    </span>
  ) : null;

  // ── PART 38.2 QUOTE PROVENANCE — WHICH FEED WROTE THIS PRICE, AND IS IT
  // LIVE? A held/fallback print must never paint like a genuine PO tick.
  const provenance = quote ? quoteProvenance(quote) : null;

  return (
    <div
      data-testid="asset-card"
      role={interactive ? "link" : undefined}
      tabIndex={interactive ? 0 : -1}
      aria-label={regime.ariaLabel}
      aria-disabled={interactive ? undefined : true}
      aria-description={nonInteractiveTitle}
      title={nonInteractiveTitle}
      onClick={openPro}
      onKeyDown={handleCardKeyDown}
      className={cn(
        "group relative flex flex-col rounded-cell px-2 py-1 min-w-0 select-none",
        interactive
          ? "border border-term-line bg-term-panel cursor-pointer transition-colors duration-150 hover:border-bull/40"
          : "border border-term-line bg-term-panel/80 cursor-not-allowed",
      )}
    >
      {/* ── PART 16 [66] 2px left-lead ALIGN STRIP — hover only, tradable only ── */}
      {interactive && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-bull opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        />
      )}

      {/* ── ROW 1 — pair + class chip ── */}
      <div className="flex items-center justify-between gap-1 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className={cn("font-sans font-semibold text-[11px] tracking-tight truncate", interactive ? "text-term-ink" : "text-term-ink-dim")}>
              {symbol}
            </h4>
            <AssetClassBadge symbol={symbol} />
          </div>
          <p className="font-sans text-[8px] text-term-ink-faint truncate">
            {getPairLabel(symbol)}
          </p>
        </div>
      </div>

      {/* ── ROW 2 — price (star) + delta + spread/ticks —─ */}
      <div className="mt-1 flex items-end justify-between gap-1 min-w-0">
        <div className="min-w-0">
          <span
            key={interactive ? `${symbol}::${priceText}` : undefined}
            className={cn(
              "num-fig text-[16px] font-bold leading-tight truncate block",
              interactive ? "text-term-ink" : "text-term-ink-faint",
              interactive && flashDir === "up" && "price-flash-up",
              interactive && flashDir === "down" && "price-flash-down",
            )}
          >
            {priceText}
          </span>
        </div>
        <div className="shrink-0 text-right min-w-0">
          {interactive && (
            <p
              className={cn(
                "num-fig text-[9px] font-semibold leading-tight",
                delta == null ? "text-term-ink-faint" : delta >= 0 ? "text-bull" : "text-bear",
              )}
            >
              {delta == null ? "" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(5)}`}
            </p>
          )}
          {spreadLine}
        </div>
      </div>

      {/* ── ROW 2b (PART 38.2) — data provenance / staleness strip ── */}
      {provenance && (
        <div className="mt-0.5 flex items-center justify-between gap-1 min-w-0">
          <span
            data-testid="quote-provenance"
            title={provenance.title}
            className={cn(
              "num-fig text-[8px] leading-none truncate cursor-help",
              provenance.tone === "held" && "text-bear font-semibold",
              provenance.tone === "fallback" && "text-gold",
              provenance.tone === "live" && "text-term-ink-faint",
              provenance.tone === "unknown" && "text-term-ink-dim",
            )}
          >
            {provenance.label}
          </span>
        </div>
      )}

      {/* ── ROW 3 — verdict strip (LIVE + horizon) ── */}
      {scoredOnly ? (
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-chip font-bold text-[9px] leading-none text-gold bg-gold/10 border border-gold/40"
              title={regime.nonInteractiveTitle}
            >
              <Activity size={10} />
              SCORED-ONLY
            </span>
            <span className="num-fig ml-auto text-[8px] uppercase tracking-tight text-term-ink-faint whitespace-nowrap">
              REGIME REVIEW
            </span>
          </div>
          <span className="text-[8px] leading-tight text-term-ink-faint">
            {regime.scoredOnlyCaption}
          </span>
        </div>
      ) : demotedByFilter ? (
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* ── HONEST DISPLAY (PART 38.1 [377]) ──
                The bar gates TRADABILITY (row 4 pills, PRO, the link role) —
                it must never hide what the feeds actually believe. A live
                1Hz direction that clears 0 but not 96.5 still renders its
                CALL/PUT here, next to the reason the card cannot be traded,
                so "BELOW BAR" is a state of the verdict and not the absence
                of one. */}
            {liveBadge}
            {horizonBadge}
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-chip font-bold text-[9px] leading-none text-amber-400 bg-amber-500/10 border border-amber-500/40"
              title={nonInteractiveTitle}
            >
              <Filter size={10} />
              BELOW {minConfidencePct.toFixed(1)}% BAR
            </span>
            <span className="num-fig ml-auto text-[9px] font-semibold text-term-ink-dim whitespace-nowrap">
              {filterConf != null ? `${filterConf.toFixed(1)}%` : ""}
            </span>
          </div>
          <span className="text-[8px] leading-tight text-term-ink-faint">
            Confidence under the filter — lower the bar to activate.
          </span>
        </div>
      ) : demotedByTier ? (
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Same rule as the confidence demotion: the direction stays on
                screen, only the action is withheld. */}
            {liveBadge}
            {horizonBadge}
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-chip font-bold text-[9px] leading-none text-slate-300 bg-slate-500/10 border border-slate-500/40"
              title={nonInteractiveTitle}
            >
              <Filter size={10} />
              BELOW {minTier} FLOOR
            </span>
            {/* The engine's HONEST band is still shown — a T3 reads T3, never
                a rewritten T5 — so the trader can see exactly what they are
                choosing to include. */}
            {cardTier && <TierBadge tier={cardTier} />}
            <span className="num-fig ml-auto text-[9px] font-semibold text-term-ink-dim whitespace-nowrap">
              {filterConf != null ? `${filterConf.toFixed(1)}%` : ""}
            </span>
          </div>
          <span className="text-[8px] leading-tight text-term-ink-faint">
            Below your selected trade floor — pick a lower tier to activate.
          </span>
        </div>
      ) : (
        <>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            {liveBadge}
            {confPct != null && (
              <span className="num-fig text-[9px] font-semibold text-term-ink-dim">
                {confPct}%
              </span>
            )}
            {horizonBadge}
            {/* Honest band for an actionable card too — every tier is
                visible, not just T1. */}
            {cardTier && <TierBadge tier={cardTier} />}
            <span className="num-fig ml-auto text-[8px] text-term-ink-faint whitespace-nowrap">
              {hasAnySignal
                ? ""
                : horizonPending
                  ? "SYNC"
                  : liveWaiting
                    ? "WAITING FOR TAPE"
                    : "LIVE <0.5m"}
            </span>
          </div>

          {/* Book agreement bar (PART 19.2) — functional, thin, flat. The 0-100
              number is a confluence score (agreement among the strategy
              books on the same tape), never a calibrated probability. */}
          {confPct != null && (
            <div
              className="mt-1 h-[3px] w-full bg-term-line/60 overflow-hidden rounded-full"
              title={`Strategy Book Agreement ${confPct}%`}
            >
              <div
                className={cn(
                  "h-full rounded-full",
                  liveDir === "BUY" ? "bg-bull" : "bg-bear",
                )}
                style={{ width: `${confBarWidth}%` }}
              />
            </div>
          )}
        </>
      )}

      {/* ── ROW 4 — expiry pills + Pro deep-link (tradable only) ── */}
      {interactive && (
        <div className="mt-1 pt-1 border-t border-term-line flex items-center justify-between gap-1">
          {/* stopPropagation: horizon pills must never trigger card navigation */}
          <div onClickCapture={(e) => suppressCardNav(e)}>
            <HorizonSelector size="sm" value={horizon} onChange={handleHorizonChange} />
          </div>
          <button
            type="button"
            aria-label={`Open Pro Terminal for ${symbol}`}
            onClick={(e) => {
              suppressCardNav(e);
              openPro();
            }}
            className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-tight text-term-ink-dim hover:text-bull transition-colors shrink-0 cursor-pointer"
          >
            PRO <ChevronDown size={9} />
          </button>
        </div>
      )}

      {/* ── ROW 5 — filter pins ──────────────────────────────────────────────
          Rendered for EVERY card, including scored-only ones. Pinning is a
          VIEW/curation action with no trading consequence, so it must never
          be hidden behind the tradability gate — otherwise a scored-only pair
          could never be favorited, which is exactly when an operator most
          wants to keep an eye on it. */}
      <div
        className="mt-1 flex items-center justify-end gap-0.5"
        onClickCapture={(e) => suppressCardNav(e)}
      >
        <button
          type="button"
          aria-pressed={isFavorite}
          aria-label={
            isFavorite
              ? `Remove ${symbol} from favorites`
              : `Add ${symbol} to favorites`
          }
          title={isFavorite ? "Remove from favorites" : "Pin to favorites"}
          data-testid={`asset-pin-${symbol}`}
          onClick={(e) => {
            suppressCardNav(e);
            toggleFavorite(symbol);
          }}
          className={cn(
            "text-[10px] leading-none px-1 py-0.5 rounded-chip transition-colors cursor-pointer",
            isFavorite
              ? "text-term-gold"
              : "text-term-ink-faint hover:text-term-ink-dim",
          )}
        >
          {isFavorite ? "★" : "☆"}
        </button>
        <button
          type="button"
          aria-pressed={isHidden}
          aria-label={
            isHidden ? `Show ${symbol} in the grid` : `Hide ${symbol} from the grid`
          }
          title={isHidden ? "Show in grid" : "Hide from grid"}
          data-testid={`asset-hide-${symbol}`}
          onClick={(e) => {
            suppressCardNav(e);
            toggleHidden(symbol);
          }}
          className={cn(
            "text-[9px] font-bold uppercase tracking-tight transition-colors cursor-pointer",
            isHidden
              ? "text-term-ink-dim line-through"
              : "text-term-ink-faint hover:text-term-ink-dim",
          )}
        >
          {isHidden ? "HIDDEN" : "HIDE"}
        </button>
      </div>
    </div>
  );
};

/**
 * Memoised so an unchanged symbol keeps its object identity through the
 * `setQuotes` structural-sharing bail-out and React skips the render entirely.
 * `onHorizonChange` arrives inline from the grid, so compare it by identity-
 * insensitive value: the parent handler is stable across renders.
 */
export const AssetCard = React.memo(
  AssetCardImpl,
  (prev, next) =>
    prev.symbol === next.symbol &&
    prev.onHorizonChange === next.onHorizonChange,
);