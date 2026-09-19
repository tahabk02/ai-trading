"use client";

import React from "react";
import { useRouter } from "next/navigation";
import {
  TrendingUp,
  TrendingDown,
  Activity,
  ChevronDown,
} from "lucide-react";
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
 * The terminal never shows "MARKET WAITING" once minimum bars are met: the 60%
 * gate + micro-quant fast-path stream directional verdicts from 2 real bars, so
 * a card paints a LIVE CALL/PUT almost immediately. The heavier /multi-predict
 * refresh on horizon change upgrades that with the per-horizon confidence.
 *
 * PART 15 [51] REAL-FOREX REGIME GATE: the 10 REAL_FOREX_PAIRS cards resolve
 * their display through resolveRealForexRegimeDisplay(). Until [47]/[48] are
 * explicitly confirmed, EVERY real pair renders SCORED-ONLY: price + REAL badge
 * only, no CALL/PUT badge, no target candle, and the card is NON-INTERACTIVE
 * (no card-wide navigation, no PRO button) — the UI must never visually invite
 * a trade action while the underlying regime classification is under review.
 *
 * DEEP-LINK: a tradable card navigates to
 * /dashboard/pro?symbol=<CANONICAL>&tf=<HORIZON_IN_SECONDS> so the Pro chart
 * opens on the SAME expiration the card is displaying. The nested horizon pills
 * and the PRO button call `e.stopPropagation()` so they never trigger that
 * card-wide navigation (a whole-card <Link> was not viable — the nested
 * controls would swallow every click).
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

  const hasAnySignal = Boolean(liveDir) || Boolean(horizonDir);

  const liveBadge = liveDir ? (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-black text-white text-[9px] tracking-wider",
        liveDir === "BUY" ? "bg-emerald-500/90" : "bg-rose-500/90",
      )}
    >
      {liveDir === "BUY" ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
      {liveDir === "BUY" ? "CALL" : "PUT"}
    </span>
  ) : liveWaiting ? (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold text-amber-400/90 text-[9px] tracking-wider bg-amber-500/10 border border-amber-500/30">
      <Activity size={10} />
      WAITING
    </span>
  ) : null;

  const horizonBadge =
    horizonPending ? (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold text-slate-300 text-[9px] tracking-wider bg-slate-700/40">
        <span className="w-2.5 h-2.5 border border-slate-300 border-t-transparent rounded-full animate-spin" />
        {horizon}m&nbsp;SYNC
      </span>
    ) : horizonDir ? (
      <span
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-black text-white text-[9px] tracking-wider",
          horizonDir === "BUY" ? "bg-emerald-500/80" : "bg-rose-500/80",
        )}
      >
        {horizonDir === "BUY" ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
        H{horizon}m {horizonDir === "BUY" ? "CALL" : "PUT"}
      </span>
    ) : horizonWaiting ? (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold text-amber-400/90 text-[9px] tracking-wider bg-amber-500/10 border border-amber-500/30">
        H{horizon}m WAITING
      </span>
    ) : null;

  const confBarWidth = Math.max(0, Math.min(100, liveConf));
  const confText =
    (liveDir && liveConf > 0
      ? `${liveConf.toFixed(1)}%`
      : hasAnySignal
        ? "--"
        : "--");

  return (
    <div
      role={scoredOnly ? undefined : "link"}
      tabIndex={scoredOnly ? -1 : 0}
      aria-label={regime.ariaLabel}
      aria-disabled={scoredOnly ? true : undefined}
      onClick={openPro}
      onKeyDown={handleCardKeyDown}
      className={cn(
        "flex flex-col bg-obsidian-900/70 border border-slate-800 rounded-xl p-2.5 shadow-sm min-w-0 select-none",
        scoredOnly
          ? "border-violet-500/20 opacity-90 cursor-default"
          : "hover:border-blue-500/40 hover:shadow-card-lift hover:-translate-y-0.5 transition-all duration-150 cursor-pointer",
      )}
    >
      {/* ── Header: pair + live price ── */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="text-slate-100 font-bold text-[11px] tracking-tight truncate">
              {symbol}
            </h4>
            <AssetClassBadge symbol={symbol} />
          </div>
          <p className="text-slate-600 text-[8px] uppercase font-semibold truncate">
            {getPairLabel(symbol)}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p
            className={cn(
              "font-mono text-sm font-bold tabular-nums leading-tight",
              price != null ? "text-emerald-400" : "text-slate-600",
            )}
          >
            {priceText}
          </p>
          <p className="text-slate-600 text-[8px] font-mono tabular-nums">
            {quoteCcy} · {spreadText} spr · {quote?.tickCount ?? 0} ticks
          </p>
        </div>
      </div>

      {scoredOnly ? (
        // ── PART 15 [51] — scored-only real pair: price shown, NO signal,
        //    NO BUY/SELL action, NO target candle. Same SCORED-ONLY pattern
        //    the PART 9/14 suppression HUD already uses for random_walk. ──
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-black text-violet-300 text-[9px] tracking-wider bg-violet-500/10 border border-violet-500/30">
            <Activity size={10} />
            SCORED-ONLY
          </span>
          <span className="ml-auto text-slate-500 text-[8px] font-mono whitespace-nowrap">
            {regime.reason === "regime_scored_only"
              ? "RANDOM WALK"
              : "REGIME REVIEW"}
          </span>
        </div>
      ) : (
        <>
          {/* ── Signal row: LIVE + HORIZON verdicts ── */}
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            {liveBadge}
            {horizonBadge}
            <span className="ml-auto text-slate-500 text-[8px] font-mono whitespace-nowrap">
              {hasAnySignal ? confText : "LIVE <0.5m"}
            </span>
          </div>

          {/* ── Confidence meter ── */}
          {hasAnySignal && (
            <div className="mt-1.5 h-1 w-full bg-slate-800/80 rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  liveDir === "SELL"
                    ? "bg-rose-500/80"
                    : liveDir === "BUY"
                      ? "bg-emerald-500/80"
                      : horizonDir === "SELL"
                        ? "bg-rose-500/60"
                        : horizonDir === "BUY"
                          ? "bg-emerald-500/60"
                          : "bg-slate-600",
                )}
                style={{ width: `${confBarWidth}%` }}
              />
            </div>
          )}

          {/* ── Footer: per-card horizon + pro deep-dive ── */}
          <div className="mt-2 pt-2 border-t border-slate-800/60 flex items-center justify-between gap-1">
            {/* stopPropagation: horizon pills must never trigger card navigation */}
            <div onClickCapture={(e) => suppressCardNav(e)}>
              <HorizonSelector
                value={horizon}
                onChange={handleHorizonChange}
              />
            </div>
            <button
              type="button"
              aria-label={`Open Pro Terminal for ${symbol}`}
              onClick={(e) => {
                suppressCardNav(e);
                openPro();
              }}
              className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-500 hover:text-emerald-400 transition-colors shrink-0 cursor-pointer"
            >
              PRO <ChevronDown size={9} />
            </button>
          </div>
        </>
      )}
    </div>
  );
};
