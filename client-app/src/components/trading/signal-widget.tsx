"use client";

import React from "react";
import { TrendingUp, TrendingDown, Activity } from "lucide-react";
import { format } from "date-fns";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { detectLang } from "@/utils/i18n";
import { formatPairPrice } from "@/utils/format";
import { getPairLabel } from "@/constants/symbols";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";
import { TierBadge } from "@/components/shared/tier-badge";
import { BookAgreementDepthNote } from "@/components/shared/book-agreement-depth-note";
import {
  useTradingStore,
  selectSetActiveSymbol,
  selectGetPrediction,
} from "@/store/useTradingStore";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { QUOTE_PROVENANCE_STALE_MS } from "@/lib/quoteProvenance";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SignalProps {
  signal?: {
    id?: string;
    symbol?: string;
    signalType?: "BUY" | "SELL";
    price?: number | null;
    confidence?: number | null;
    /**
     * PART 19.2 [118] — raw confluence internals + "n/n books aligned" label.
     * PART 35.3 [358] — the 0-100 number is STRATEGY BOOK AGREEMENT, not a
     * calibrated probability and not order-book evidence.
     */
    book_agreement_detail?: {
      convergence_index?: number;
      alignment?: number;
      magnitude?: number;
      aligned_count?: number;
      active_count?: number;
      label?: string;
    } | null;
    /** AI Engine dispatch tier T1…T5 (PART 6). */
    tier?: string | null;
    createdAt?: string | null;
    indicators?: {
      adx?: number | null;
      atr?: number | null;
    };
    stop_loss?: number | null;
    take_profit?: number | null;
  };
}

export const SignalWidget: React.FC<SignalProps> = ({ signal }) => {
  const rawType = signal?.signalType ?? "";
  const isBuy = rawType === "BUY";
  const isSell = rawType === "SELL";
  // ── EXACT ENGINE LABELS ──
  // Side asset cards reflect the AI engine's literal verdict: BUY / SELL. The
  // legacy CALL/PUT broker jargon was a lossy rename that hid the true signal.
  // No HOLD state exists — before the first verdict lands the card is neutral.
  const displayType = isBuy ? "BUY" : isSell ? "SELL" : "—";
  const symbol = signal?.symbol ?? "--";
  const createdAt = signal?.createdAt ?? null;

  const setActiveSymbol = useTradingStore(selectSetActiveSymbol);
  const getPrediction = useTradingStore(selectGetPrediction);
  /** PART 35.3 [359][360] — engine's order-book depth flag for this score. */
  const bookConfluence = useTradingStore((s) => s.predictionData?.book_confluence);
  // PART 35.3 [360] — the rail renders ONE WIDGET PER LIVE SIGNAL, but
  // `predictionData` is the REST prediction for the ACTIVE symbol only. Left
  // ungated, every widget in the rail inherits that one symbol's depth evidence
  // and stamps it onto other instruments' scores. Only the widget whose symbol
  // IS the predicted symbol may claim the evidence; the others render nothing.
  const predictionSymbol = useTradingStore(
    (s) => s.predictionData?.symbol ?? null,
  );
  const normalizeSymbol = (v: string | null | undefined) =>
    (v ?? "").replace(/[\/\s_-]/g, "").toUpperCase();
  const ownsDepthEvidence =
    !!normalizeSymbol(predictionSymbol) &&
    normalizeSymbol(predictionSymbol) === normalizeSymbol(symbol);

  const invert = normalizeSymbol(symbol) === normalizeSymbol(displayType);

  // ════════════════════════════════════════════════════════════════════
  // PART 41 [398] — PER-CARD PRICE, NEVER THE ACTIVE SYMBOL'S.
  // Every card used to read `selectCurrentPrice` (the ACTIVE symbol) and stamp
  // it as its own execution price — a GBP/USD active session printed ~1.32 on
  // the BTC/USD card. The card price now resolves from its OWN symbol: the
  // signal payload price first, then the per-symbol quote map keyed by
  // `signal.symbol`. Unknown → "--". There is intentionally NO fallback to the
  // active symbol's price.
  // ════════════════════════════════════════════════════════════════════
  const railSymbol = (signal?.symbol ?? "").trim().toUpperCase();
  const payloadPrice =
    typeof signal?.price === "number" &&
    Number.isFinite(signal.price) &&
    signal.price > 0
      ? signal.price
      : 0;
  const symbolQuote = useMarketTerminalStore((s) => {
    if (!railSymbol) return undefined;
    // Direct key first — the backend keys quotes by the canonical symbol.
    if (s.quotes?.[railSymbol]) return s.quotes[railSymbol];
    // Slash/spacing variants ("BTC / USD" → "BTC/USD") fall back to a compact
    // match across the whole map. Cheap: this path only runs for variant keys.
    const compact = railSymbol.replace(/[\/\s_-]/g, "");
    for (const q of Object.values(s.quotes ?? {})) {
      if (q?.symbol && q.symbol.replace(/[\/\s_-]/g, "").toUpperCase() === compact) {
        return q;
      }
    }
    return undefined;
  });
  const quotePrice =
    typeof symbolQuote?.price === "number" &&
    Number.isFinite(symbolQuote.price) &&
    symbolQuote.price > 0
      ? symbolQuote.price
      : 0;
  const price = payloadPrice > 0 ? payloadPrice : quotePrice;
  const priceUnknown = !(price > 0);

  // PART 41 [399] — the rail carries the SAME stale marker as the panel.
  // A verdict built on a quote older than the provenance threshold (15s) or
  // flagged stale/held by the backend must not wear PREMIUM styling. We report
  // the age outright ("STALE Ns") instead of silently downgrading the tier.
  const quoteAgeMs =
    typeof symbolQuote?.freshAgeMs === "number" &&
    Number.isFinite(symbolQuote.freshAgeMs)
      ? symbolQuote.freshAgeMs
      : typeof symbolQuote?.ageMs === "number" &&
          Number.isFinite(symbolQuote.ageMs)
        ? symbolQuote.ageMs
        : symbolQuote?.lastTickAt && !Number.isNaN(Date.parse(symbolQuote.lastTickAt))
          ? Date.now() - Date.parse(symbolQuote.lastTickAt)
          : null;
  const stale =
    !!symbolQuote &&
    (symbolQuote.staleLive === true ||
      symbolQuote.stale === true ||
      (quoteAgeMs != null && quoteAgeMs > QUOTE_PROVENANCE_STALE_MS));
  const staleSeconds =
    quoteAgeMs != null && stale
      ? Math.max(1, Math.round(quoteAgeMs / 1000))
      : null;

  // ════════════════════════════════════════════════════════════════
  // ABSOLUTE CONFIDENCE SANITIZER — KILLS OVERFLOW AT CLIENT BOUNDARY
  const rawConf = Number(signal?.confidence) || 0;
  const normalizedConf = rawConf > 100 ? rawConf / 100 : rawConf;
  const displayConfidence = Math.min(
    Math.max(normalizedConf > 1 ? normalizedConf : normalizedConf * 100, 0),
    100,
  );
  // PART 19.2 [118] — book agreement internals: how many of the ten strategy
  // books actually aligned with the dispatched direction. Rendered next to the
  // % so the number reads as AGREEMENT, never as a probability.
  const booksA = signal?.book_agreement_detail?.aligned_count ?? null;
  const booksN = signal?.book_agreement_detail?.active_count ?? null;
  // ── PART 6 TIER-COLORED CONFIDENCE — palette mirrors the engine ladder ──
  // T1 emerald (>=96.5), T2 teal (>=90), T3 amber (>=80), T4 orange (>=70),
  // T5 gray. Replaces the old ad-hoc >90/>80/>72 bands with the canonical
  // T1-T5 tiers the engine dispatches.
  const unknownTierColor =
    displayConfidence >= 96.5
      ? "text-st-pos"
      : displayConfidence >= 90
        ? "text-st-teal"
        : displayConfidence >= 80
          ? "text-st-warn"
          : displayConfidence >= 70
            ? "text-st-caution"
            : "text-slate-400";

  const handleViewChart = () => {
    if (symbol && symbol !== "--") {
      const cleanSym = symbol.trim().toUpperCase();
      setActiveSymbol(cleanSym);
      getPrediction(cleanSym, "1d");
    }
  };

  return (
    <div
      onClick={handleViewChart}
      className="bg-obsidian-900 border border-slate-800 rounded-xl p-3 sm:p-5 shadow-card dark:shadow-2xl hover:border-blue-500/50 transition-all duration-300 cursor-pointer"
    >
      {/* ── Header: Symbol + Badge (BUY 🟢 / SELL 🔴) ── */}
      <div className="flex justify-between items-start mb-3 sm:mb-4 gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-base sm:text-xl font-bold text-slate-50 tracking-tight truncate flex items-center gap-2">
            {getPairLabel(symbol)}
            <AssetClassBadge symbol={symbol} />
          </h3>
          <p
            className="text-ink-muted text-[10px] sm:text-xs uppercase font-semibold mt-0.5"
            dir={detectLang() === "ar" ? "rtl" : "ltr"}
          >
            {createdAt ? format(new Date(createdAt), "HH:mm:ss") : "--"} · LOCAL
          </p>
        </div>
        <div
          className={cn(
            "shrink-0 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-[10px] sm:text-xs font-bold flex items-center gap-1 min-h-[28px] sm:min-h-[32px]",
            isBuy
              ? "bg-st-pos/10 text-st-pos"
              : isSell
                ? "bg-st-neg/10 text-st-neg"
                : "bg-slate-500/10 text-slate-300",
          )}
        >
          {isBuy ? (
            <TrendingUp size={14} className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
          ) : isSell ? (
            <TrendingDown size={14} className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
          ) : (
            <span className="text-xs">⚪</span>
          )}
          <span className="hidden xs:inline">{displayType}</span>
        </div>
      </div>

      {/* ── Price & Confidence Grid ── */}
      <div className="grid grid-cols-2 gap-2 sm:gap-4">
        <div className="bg-obsidian-950/60 rounded-lg p-2 sm:p-3">
          <p className="text-ink-muted text-[9px] sm:text-[10px] uppercase font-bold mb-0.5 sm:mb-1">
            Execution Price
          </p>
          <p className="text-slate-50 font-mono text-sm sm:text-lg truncate">
            {priceUnknown ? (
              "--"
            ) : (
              <>${formatPairPrice(price, symbol)}</>
            )}
          </p>
          {/* PART 41 [399] — same stale marker as the panel: age the quote out
              loud instead of showing PREMIUM styling on a stale-built verdict. */}
          {stale ? (
            <p
              data-testid="rail-stale-marker"
              className="text-st-caution text-[9px] sm:text-[10px] font-bold uppercase tracking-wider truncate mt-0.5"
            >
              STALE {staleSeconds != null ? `${staleSeconds}s` : ""}
            </p>
          ) : null}
        </div>
        <div className="bg-obsidian-950/60 rounded-lg p-2 sm:p-3">
          <p className="text-ink-muted text-[9px] sm:text-[10px] uppercase font-bold mb-0.5 sm:mb-1">
            Strategy Book Agreement
          </p>
          {/* ── REAL DYNAMIC BOOK AGREEMENT — tier colors reflect the exact ──
              ── floating-point value returned by the unbiased engine. This  ──
              ── number is a CONFLUENCE SCORE (agreement among ten strategy  ──
              ── books on the same tape), NOT a calibrated probability.     ── */}
          <p
            className={cn(
              "text-sm sm:text-lg font-bold truncate tabular-nums",
              unknownTierColor,
            )}
          >
            {displayConfidence.toFixed(1)}%
          </p>
          {booksN && booksN > 0 ? (
            <p className="text-ink-muted text-[8px] sm:text-[9px] uppercase font-semibold truncate tabular-nums mt-0.5">
              {booksA}/{booksN} books
            </p>
          ) : null}
          {/* PART 35.3 [359][360] — depth provenance, visible not tooltip-only. */}
          <div className="mt-1 flex justify-end">
            <BookAgreementDepthNote
              bookConfluence={ownsDepthEvidence ? bookConfluence : null}
            />
          </div>
        </div>
      </div>

      {/* ── PART 6: HONEST TIER BADGE ── */}
      <div className="mt-2 flex items-center justify-end">
        <TierBadge
          tier={signal?.tier}
          confidence={displayConfidence}
          size="sm"
          degraded={stale}
        />
      </div>

      {/* ── Footer: Analysis + View Chart button ── */}
      <div className="mt-3 sm:mt-4 pt-3 sm:pt-4 border-t border-slate-800 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <Activity
            size={14}
            className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-blue-500 shrink-0"
          />
          <span className="text-slate-400 text-[10px] sm:text-xs truncate">
            High Frequency Analysis
          </span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation(); // Bash ma-t-dirch double trigger m3a div
            handleViewChart();
          }}
          className="shrink-0 text-[10px] sm:text-xs bg-blue-600 hover:bg-blue-500 text-white font-bold py-1.5 sm:py-2 px-2.5 sm:px-3 rounded-md transition-colors min-h-[36px] sm:min-h-[40px]"
        >
          View Chart
        </button>
      </div>
    </div>
  );
};
