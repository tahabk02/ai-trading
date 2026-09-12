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
import {
  useTradingStore,
  selectCurrentPrice,
  selectSetActiveSymbol,
  selectGetPrediction,
} from "@/store/useTradingStore";

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

  const unifiedPrice = useTradingStore(selectCurrentPrice);
  const price = unifiedPrice > 0 ? unifiedPrice : 0;

  // ════════════════════════════════════════════════════════════════
  // ABSOLUTE CONFIDENCE SANITIZER — KILLS OVERFLOW AT CLIENT BOUNDARY
  const rawConf = Number(signal?.confidence) || 0;
  const normalizedConf = rawConf > 100 ? rawConf / 100 : rawConf;
  const displayConfidence = Math.min(
    Math.max(normalizedConf > 1 ? normalizedConf : normalizedConf * 100, 0),
    100,
  );

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
      className="bg-obsidian-900 border border-slate-800 rounded-xl p-3 sm:p-5 shadow-2xl hover:border-blue-500/50 transition-all duration-300 cursor-pointer"
    >
      {/* ── Header: Symbol + Badge (BUY 🟢 / SELL 🔴) ── */}
      <div className="flex justify-between items-start mb-3 sm:mb-4 gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-base sm:text-xl font-bold text-white tracking-tight truncate flex items-center gap-2">
            {getPairLabel(symbol)}
            <AssetClassBadge symbol={symbol} />
          </h3>
          <p
            className="text-slate-500 text-[10px] sm:text-xs uppercase font-semibold mt-0.5"
            dir={detectLang() === "ar" ? "rtl" : "ltr"}
          >
            {createdAt ? format(new Date(createdAt), "HH:mm:ss") : "--"} · LOCAL
          </p>
        </div>
        <div
          className={cn(
            "shrink-0 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-[10px] sm:text-xs font-bold flex items-center gap-1 min-h-[28px] sm:min-h-[32px]",
            isBuy
              ? "bg-emerald-500/10 text-emerald-400"
              : isSell
                ? "bg-rose-500/10 text-rose-400"
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
          <p className="text-slate-500 text-[9px] sm:text-[10px] uppercase font-bold mb-0.5 sm:mb-1">
            Execution Price
          </p>
          <p className="text-white font-mono text-sm sm:text-lg truncate">
            ${formatPairPrice(price, symbol)}
          </p>
        </div>
        <div className="bg-obsidian-950/60 rounded-lg p-2 sm:p-3">
          <p className="text-slate-500 text-[9px] sm:text-[10px] uppercase font-bold mb-0.5 sm:mb-1">
            AI Confidence
          </p>
          {/* ── REAL DYNAMIC CONFIDENCE — tier colors reflect the exact ──
              ── floating-point value returned by the unbiased engine. ── */}
          <p
            className={cn(
              "text-sm sm:text-lg font-bold truncate tabular-nums",
              displayConfidence > 90
                ? "text-emerald-400"
                : displayConfidence >= 80
                  ? "text-blue-400"
                  : displayConfidence >= 72
                    ? "text-amber-400"
                    : "text-slate-300",
            )}
          >
            {displayConfidence.toFixed(1)}%
          </p>
        </div>
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
