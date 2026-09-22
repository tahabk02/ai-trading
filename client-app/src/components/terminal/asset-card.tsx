"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { TrendingUp, TrendingDown, Activity, ChevronDown } from "lucide-react";
import { cn } from "@/utils/cn";
import { getPairLabel, getQuoteCurrency } from "@/constants/symbols";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";
import { HorizonSelector } from "./horizon-selector";
import { useMarketTerminalStore, type HorizonMinutes } from "@/store/useMarketTerminalStore";
import { buildProHref, suppressCardNav } from "@/lib/pro-deep-link";
import { realForexCardBehavior } from "@/lib/realForexRegime";

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
export const AssetCard: React.FC<AssetCardProps> = ({ symbol, onHorizonChange }) => {
  const router = useRouter();
  const quote = useMarketTerminalStore((s) => s.quotes[symbol]);
  const verdict = useMarketTerminalStore((s) => s.verdicts[symbol]);
  const prediction = useMarketTerminalStore((s) => s.predictions[symbol]);
  const horizon = useMarketTerminalStore((s) => s.resolveHorizon(symbol));

  // PART 15 [51] — real-forex regime display (payload regime_gate + the
  // [47]/[48] confirmation gate). Scored-only unless explicitly confirmed.
  const regime = realForexCardBehavior(
    symbol,
    (prediction?.data as { regime_gate?: string | null } | null)?.regime_gate,
  );
  const scoredOnly = regime.scoredOnly;

  const proHref = React.useMemo(
    () => buildProHref(symbol, horizon * 60),
    [symbol, horizon],
  );

  const handleHorizonChange = (h: HorizonMinutes) => {
    if (scoredOnly) return; // real scored-only cards never re-aim an expiration
    if (onHorizonChange) {
      onHorizonChange(symbol, h);
      return;
    }
    useMarketTerminalStore.getState().setCardHorizon(symbol, h);
  };

  const openPro = React.useCallback(() => {
    if (scoredOnly) return; // non-interactive — no trade action from this card
    router.push(proHref);
  }, [router, proHref, scoredOnly]);

  const handleCardKeyDown = (e: React.KeyboardEvent) => {
    if (scoredOnly) return;
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

  const spreadLine = !scoredOnly ? (
    <span className="num-fig text-[8px] leading-tight text-term-ink-faint">
      {spreadText} spr · {ticksText}
    </span>
  ) : null;

  return (
    <div
      role={scoredOnly ? undefined : "link"}
      tabIndex={scoredOnly ? -1 : 0}
      aria-label={regime.ariaLabel}
      aria-disabled={scoredOnly ? true : undefined}
      aria-description={scoredOnly ? regime.nonInteractiveTitle : undefined}
      title={scoredOnly ? regime.nonInteractiveTitle : undefined}
      onClick={openPro}
      onKeyDown={handleCardKeyDown}
      className={cn(
        "group relative flex flex-col rounded-cell px-2 py-1 min-w-0 select-none",
        scoredOnly
          ? "border border-term-line bg-term-panel/80 cursor-not-allowed"
          : "border border-term-line bg-term-panel cursor-pointer transition-colors duration-150 hover:border-bull/40",
      )}
    >
      {/* ── PART 16 [66] 2px left-lead ALIGN STRIP — hover only, tradable only ── */}
      {!scoredOnly && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-bull opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        />
      )}

      {/* ── ROW 1 — pair + class chip ── */}
      <div className="flex items-center justify-between gap-1 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className={cn("font-sans font-semibold text-[11px] tracking-tight truncate", scoredOnly ? "text-term-ink-dim" : "text-term-ink")}>
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
            key={scoredOnly ? undefined : `${symbol}::${priceText}`}
            className={cn(
              "num-fig text-[16px] font-bold leading-tight truncate block",
              scoredOnly ? "text-term-ink-faint" : "text-term-ink",
              !scoredOnly && flashDir === "up" && "price-flash-up",
              !scoredOnly && flashDir === "down" && "price-flash-down",
            )}
          >
            {priceText}
          </span>
        </div>
        <div className="shrink-0 text-right min-w-0">
          {!scoredOnly && (
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
              title={`Book Agreement ${confPct}%`}
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
      {!scoredOnly && (
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
    </div>
  );
};