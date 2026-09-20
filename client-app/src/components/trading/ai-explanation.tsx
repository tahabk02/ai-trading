"use client";

import React, { useMemo, useState, useEffect } from "react";
import { useTradingStore } from "@/store/useTradingStore";
import { useLangContext } from "@/hooks/useLangContext";
import {
  buildSignalView,
  SIGNAL_CONFIDENCE_THRESHOLD,
} from "@/lib/realtimeCandleAggregator";
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Activity,
  Clock,
  Zap,
  BarChart3,
  Shield,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { getPairLabel } from "@/constants/symbols";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";
import { TierBadge } from "@/components/shared/tier-badge";
import {
  sanitizeConfidence,
  formatNumber,
  formatPairPrice,
  formatLocalTime,
} from "@/utils/format";

// ============================================================
// AI EXPLANATION WIDGET — Why the AI predicts CALL or PUT
// ============================================================

export const AIExplanation: React.FC = () => {
  // ── ALL HOOKS AT TOP LEVEL (before any early return) ──
  const [isMounted, setIsMounted] = useState(false);
  const { t } = useLangContext();
  const predictionData = useTradingStore((s) => s.predictionData);
  const currentPrice = useTradingStore((s) => s.currentPrice);
  const activeSymbol = useTradingStore((s) => s.activeSymbol);
  /** Real error surfaced by the store when the FastAPI engine fails. */
  const engineError = useTradingStore((s) => s.error);
  /** Recoverable 503 / live-quote timeout — auto-re-polling in the store. */
  const quoteStreamWaiting = useTradingStore((s) => s.quoteStreamWaiting);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // ── SHARED 96.5% SIGNAL GATE ──
  // The SAME buildSignalView + SIGNAL_CONFIDENCE_THRESHOLD the trading panel
  // and chart use. Below the gate a raw BUY/SELL is demoted to NO SIGNAL so
  // this widget never surfaces a directional call the rest of the app blocks.
  const signalView = buildSignalView(
    predictionData,
    SIGNAL_CONFIDENCE_THRESHOLD,
  );
  const signal =
    predictionData?.market_waiting === true ? null : signalView.gatedSignal;
  const indicators = predictionData?.indicators;
  const scalpingInd = predictionData?.scalping_indicators;

  // Resolve indicators from both normal and scalping paths
  const rsi = indicators?.rsi_14 ?? scalpingInd?.rsi_14 ?? null;
  const sma20 = indicators?.sma_20 ?? scalpingInd?.sma_20 ?? null;
  const sma50 = indicators?.sma_50 ?? scalpingInd?.sma_50 ?? null;
  const atr = scalpingInd?.atr_14 ?? null;
  const macd = scalpingInd?.macd_fast ?? null;

  const confidenceStr = useMemo(
    () => sanitizeConfidence(predictionData?.confidence),
    [predictionData?.confidence],
  );
  const confidenceNum = parseFloat(confidenceStr);
  // PART 19.2 [118] — the 0-100 number is BOOK AGREEMENT (confluence among
  // the ten strategy books on the same tape), not a calibrated probability.
  const booksA = predictionData?.book_agreement_detail?.aligned_count ?? null;
  const booksN = predictionData?.book_agreement_detail?.active_count ?? null;

  // Generate reasoning text based on technical indicators
  const reasoning = useMemo(() => {
    if (!predictionData) return null;

    const reasons: string[] = [];

    // RSI reasoning — pair-agnostic, RSI is always 0-100
    if (rsi !== null) {
      const rsiStr = rsi.toFixed(1);
      if (rsi >= 70)
        reasons.push(
          `RSI at ${rsiStr} — overbought, suggesting downward reversal`,
        );
      else if (rsi <= 30)
        reasons.push(`RSI at ${rsiStr} — oversold, suggesting upward reversal`);
      else reasons.push(`RSI at ${rsiStr} — neutral momentum`);
    }

    // SMA crossover reasoning — use pair-aware precision for price levels
    if (sma20 !== null && sma50 !== null) {
      const sma20Str = formatPairPrice(sma20, activeSymbol);
      const sma50Str = formatPairPrice(sma50, activeSymbol);
      if (sma20 > sma50)
        reasons.push(
          `SMA20 (${sma20Str}) above SMA50 (${sma50Str}) — bullish crossover`,
        );
      else
        reasons.push(
          `SMA20 (${sma20Str}) below SMA50 (${sma50Str}) — bearish crossover`,
        );
    }

    // Signal direction reasoning
    if (signal === "BUY") {
      reasons.unshift("Bullish momentum detected across multiple timeframes");
      if (currentPrice > 0 && predictionData.target_price > 0) {
        const upside = (
          ((predictionData.target_price - currentPrice) / currentPrice) *
          100
        ).toFixed(2);
        reasons.push(
          `Projected upside: +${upside}% to target $${formatPairPrice(predictionData.target_price, activeSymbol)}`,
        );
      }
    } else if (signal === "SELL") {
      reasons.unshift("Bearish momentum detected across multiple timeframes");
      if (currentPrice > 0 && predictionData.target_price > 0) {
        const downside = (
          ((currentPrice - predictionData.target_price) / currentPrice) *
          100
        ).toFixed(2);
        reasons.push(
          `Projected downside: -${downside}% to target $${formatPairPrice(predictionData.target_price, activeSymbol)}`,
        );
      }
    }

    // Volatility via ATR — pair-aware precision (never rounds to 2 decimals for low-value pairs)
    if (atr !== null && atr > 0) {
      const volLevel =
        atr > currentPrice * 0.02
          ? "High"
          : atr > currentPrice * 0.01
            ? "Medium"
            : "Low";
      const atrDisplay = formatPairPrice(atr, activeSymbol);
      reasons.push(`Volatility: ${volLevel} (ATR: ${atrDisplay})`);
    }

    // Book-agreement level statement (PART 19.2 — a confluence score, not a
    // probability; the wording says what the number IS).
    if (confidenceNum >= 96.5)
      reasons.push("Strong book agreement — all strategy books aligned");
    else if (confidenceNum >= 80)
      reasons.push("Partial book agreement — most strategy books aligned");
    else
      reasons.push("Weak book agreement — divergent indicators, trade with caution");

    // ── GATED-DIRECTION NOTICE ──
    // When the engine emitted a raw BUY/SELL below the 96.5% gate, say so
    // explicitly instead of quietly showing nothing.
    if (signalView.gated && confidenceNum > 0) {
      reasons.push(
        `Signal gate: book agreement ${confidenceStr}% < ${Math.round(SIGNAL_CONFIDENCE_THRESHOLD * 1000) / 10}% — no directional call`,
      );
    }

    return reasons;
  }, [
    predictionData,
    signal,
    signalView,
    currentPrice,
    rsi,
    sma20,
    sma50,
    atr,
    confidenceNum,
    confidenceStr,
    activeSymbol,
  ]);

  // ── ZERO-FABRICATION HORIZON LABEL ──
  // Reflects the EXACT timeframe dispatched to the backend. The previous
  // hardcoded "1-2 minutes"/"5-10 minutes" ranges were client-invented
  // fiction with no basis in the AI engine's output — removed.
  const horizonLabel = predictionData?.timeframe
    ? predictionData.timeframe.toUpperCase()
    : "--";

  // Volatility metric
  const volatilityLabel = useMemo(() => {
    if (atr !== null && currentPrice > 0) {
      const atrPct = (atr / currentPrice) * 100;
      if (atrPct > 2)
        return { label: "High", color: "text-rose-400", bg: "bg-rose-500/20" };
      if (atrPct > 1)
        return {
          label: "Medium",
          color: "text-amber-400",
          bg: "bg-amber-500/20",
        };
      return {
        label: "Low",
        color: "text-emerald-400",
        bg: "bg-emerald-500/20",
      };
    }
    return { label: "—", color: "text-slate-400", bg: "bg-slate-500/20" };
  }, [atr, currentPrice]);

  // ── SSR/CSR HYDRATION GUARD ──
  // All hooks called above. Early return HERE is safe.
  if (!isMounted) {
    return (
      <div className="bg-obsidian-900/60 border border-slate-800/80 rounded-2xl p-5 animate-pulse" />
    );
  }

  if (!predictionData) {
    return (
      <div className="bg-obsidian-900/60 border border-slate-800/80 rounded-2xl p-5 backdrop-blur-sm">
        <div className="flex items-center gap-2 mb-4">
          <Brain className="w-4 h-4 text-blue-400" />
          <h3 className="text-white font-bold text-xs uppercase tracking-wider">
            AI Analysis
          </h3>
        </div>
        {/* ── VISIBLE ERROR STATE — never lie to the user ── */}
        {/* When the FastAPI engine fails, surface the REAL error instead of */}
        {/* an endless "awaiting..." spinner that masks the outage. A */}
        {/* recoverable 503 / live-quote timeout is NOT an outage: it shows the */}
        {/* calm waiting banner while the store re-polls with backoff. */}
        {quoteStreamWaiting ? (
          <div className="py-4 px-3 bg-amber-500/10 border border-amber-800/40 rounded-lg">
            <p className="text-[10px] text-amber-300 font-black uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              Live Asset Stream
            </p>
            <p className="text-[11px] text-amber-300/90 font-mono break-words">
              Waiting for live asset stream...
            </p>
          </div>
        ) : engineError ? (
          <div className="py-4 px-3 bg-rose-500/10 border border-rose-800/50 rounded-lg">
            <p className="text-[10px] text-rose-300 font-black uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
              AI Engine Unavailable
            </p>
            <p className="text-[11px] text-rose-400 font-mono break-words">
              {engineError}
            </p>
          </div>
        ) : (
          <p className="text-slate-500 text-xs font-mono text-center py-4">
            Awaiting prediction data for analysis...
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-obsidian-900/60 border border-slate-800/80 rounded-2xl p-5 backdrop-blur-sm">
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-blue-400" />
          <h3 className="text-white font-bold text-xs uppercase tracking-wider">
            AI Analysis
          </h3>
        </div>
        <span
          className={cn(
            "text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider",
            signal === "BUY"
              ? "bg-emerald-500/20 text-emerald-400"
              : signal === "SELL"
                ? "bg-rose-500/20 text-rose-400"
                : "bg-slate-500/20 text-slate-300",
          )}
        >
          {signal === "BUY"
            ? "BUY"
            : signal === "SELL"
              ? "SELL"
              : signalView.badgeText
                ? signalView.badgeText
                : "—"}
        </span>
        {/* ── PART 6: HONEST TIER BADGE (engine-dispatched) ── */}
        <TierBadge
          tier={predictionData.tier}
          confidence={confidenceNum}
          size="sm"
        />
      </div>

      {/* ── Signal + Book Agreement Bar ── */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">
            Book Agreement
          </span>
          <span
            className={cn(
              "text-sm font-black font-mono",
              signal === "BUY" || signal === "SELL"
                ? "text-emerald-400"
                : "text-slate-400",
            )}
          >
            {confidenceStr}%
            {booksN && booksN > 0 ? ` (${booksA}/${booksN})` : ""}
          </span>
        </div>
        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              signal === "BUY" || signal === "SELL"
                ? "bg-emerald-500"
                : "bg-slate-600",
            )}
            style={{ width: `${confidenceNum}%` }}
          />
        </div>
      </div>

      {/* ── Reasoning List ── */}
      <div className="mb-4">
        <div className="flex items-center gap-1.5 mb-2">
          <Activity className="w-3 h-3 text-slate-400" />
          <span className="text-[9px] text-slate-500 uppercase font-bold tracking-wider">
            Technical Reasoning
          </span>
        </div>
        {reasoning && reasoning.length > 0 ? (
          <ul className="space-y-1.5">
            {reasoning.map((reason, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[11px] text-slate-300 font-mono leading-relaxed"
              >
                <span className="text-blue-400 mt-0.5 shrink-0">→</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-slate-600 text-xs font-mono">
            Analyzing technical indicators...
          </p>
        )}
      </div>

      {/* ── Metrics Grid ── */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <MetricItem
          icon={<Clock className="w-3 h-3" />}
          label="Horizon"
          value={horizonLabel}
        />
        <MetricItem
          icon={<Zap className="w-3 h-3" />}
          label="Volatility"
          value={volatilityLabel.label}
          valueColor={volatilityLabel.color}
          valueBg={volatilityLabel.bg}
        />
        <MetricItem
          icon={<BarChart3 className="w-3 h-3" />}
          label="ML Model"
          value="Random Forest"
        />
        <MetricItem
          icon={<Shield className="w-3 h-3" />}
          label="Accuracy"
          value={
            predictionData.model_accuracy != null
              ? `${(predictionData.model_accuracy * 100).toFixed(1)}%`
              : "—"
          }
        />
      </div>

      {/* ── Key Levels ── */}
      <div className="bg-black/30 rounded-xl border border-slate-800/40 p-3">
        <span className="text-[9px] text-slate-600 uppercase font-bold tracking-wider block mb-2">
          Key Levels
        </span>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[8px] text-slate-600 uppercase font-mono">
              Entry
            </p>
            <p className="text-xs font-bold font-mono text-white">
              {currentPrice > 0
                ? `$${formatPairPrice(currentPrice, activeSymbol)}`
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-[8px] text-slate-600 uppercase font-mono">
              Target
            </p>
            <p
              className={cn(
                "text-xs font-bold font-mono",
                signal === "BUY"
                  ? "text-emerald-400"
                  : signal === "SELL"
                    ? "text-rose-400"
                    : "text-slate-400",
              )}
            >
              {predictionData.target_price > 0
                ? `$${formatPairPrice(predictionData.target_price, activeSymbol)}`
                : "—"}
            </p>
          </div>
          {/* ── ZERO-FABRICATED STOP LEVEL ── */}
          {/* The previous formula (entry − 0.5 × delta) was CLIENT-INVENTED */}
          {/* data presented as a real stop. Stop levels come exclusively */}
          {/* from the backend risk engine; until it exposes one we render */}
          {/* an honest em-dash — never a fabricated price. */}
          <div>
            <p className="text-[8px] text-slate-600 uppercase font-mono">
              Stop
            </p>
            <p className="text-xs font-bold font-mono text-slate-400">—</p>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="mt-3 pt-3 border-t border-slate-800/40">
        <div className="flex items-center justify-between text-[9px] text-slate-600 font-mono">
          <span className="flex items-center gap-1.5">
            {getPairLabel(activeSymbol)}
            <AssetClassBadge symbol={activeSymbol} />
          </span>
          <span>
            {predictionData.timeframe} ·{" "}
            {formatLocalTime(predictionData.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
};

// ── Metric Item Sub-Component ──

function MetricItem({
  icon,
  label,
  value,
  valueColor = "text-white",
  valueBg,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueColor?: string;
  valueBg?: string;
}) {
  return (
    <div className="bg-black/30 rounded-xl border border-slate-800/30 p-3 flex items-center gap-2.5">
      <div className="text-slate-500 shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-[9px] text-slate-600 uppercase font-bold tracking-wider">
          {label}
        </p>
        <span
          className={cn(
            "text-xs font-bold font-mono",
            valueColor,
            valueBg && `${valueBg} px-1.5 py-0.5 rounded`,
          )}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

export default AIExplanation;
