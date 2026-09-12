import codecs

path = r'c:\Users\hp\trading-ai-platform\client-app\src\components\trading\predictive-intelligence.tsx'

content = '''"use client";

import { useEffect, useState, useRef } from "react";
import { useTradingStore } from "@/store/useTradingStore";
import { formatCurrency, formatNumber, formatPercent } from "@/utils/format";

export interface PredictiveIntelligenceProps {
  symbol?: string;
  selectedTimeframe?: string;
  onTimeframeChange?: (timeframe: string) => void;
}

export const PredictiveIntelligence: React.FC<PredictiveIntelligenceProps> = ({
  symbol: propSymbol,
  selectedTimeframe = "1d",
  onTimeframeChange,
}) => {
  const storeSymbol = useTradingStore((s) => s.activeSymbol);
  const symbol = propSymbol ?? storeSymbol;
  const currentPrice = useTradingStore((s) => s.currentPrice);
  const predictionData = useTradingStore((s) => s.predictionData);
  const isLoading = useTradingStore((s) => s.isLoading);
  const error = useTradingStore((s) => s.error);
  const lastPriceUpdate = useTradingStore((s) => s.lastPriceUpdate);
  const getPrediction = useTradingStore((s) => s.getPrediction);
  const priceVersion = useTradingStore((s) => s._priceVersion);
  const [mounted, setMounted] = useState(false);
  const isMountedRef = useRef(true);
  useEffect(() => { setMounted(true); return () => { isMountedRef.current = false; }; }, []);
  useEffect(() => {
    const cs = symbol?.trim().toUpperCase();
    if (!cs || !mounted) return;
    getPrediction(cs, selectedTimeframe);
  }, [symbol, selectedTimeframe, getPrediction, mounted]);
  const displayPrice = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 0;

  let deltaPct: string | null = null;
  if (predictionData?.target_price != null && Number.isFinite(predictionData.target_price) && Number.isFinite(displayPrice) && displayPrice > 0) {
    const rawDelta = ((predictionData.target_price - displayPrice) / displayPrice) * 100;
    if (Number.isFinite(rawDelta)) {
      deltaPct = Math.max(-100, Math.min(100, rawDelta)).toFixed(2);
    }
  }

  const displayTimestamp = lastPriceUpdate ?? predictionData?.timestamp ?? null;
  const tfOptions = [
    { value: "1m", label: "1m" },
    { value: "5m", label: "5m" },
    { value: "15m", label: "15m" },
    { value: "1h", label: "1h" },
    { value: "1d", label: "1d" },
  ];

  if (!mounted) {
    return (
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 sm:p-5 md:p-6 backdrop-blur-sm animate-pulse">
        <div className="h-4 w-48 bg-slate-800 rounded mb-6" />
        <div className="h-3 w-full bg-slate-800 rounded mb-3" />
        <div className="h-3 w-3/4 bg-slate-800 rounded mb-3" />
        <div className="h-20 w-full bg-slate-800 rounded" />
      </div>
    );
  }

  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 sm:p-5 md:p-6 backdrop-blur-sm">
      {/* Header row with title + timeframe selector */}
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <h3 className="text-white font-bold text-xs sm:text-sm uppercase tracking-wider flex items-center flex-wrap gap-2">
          Predictive Intelligence
          <span className="text-blue-400 text-[10px] sm:text-xs font-mono"> &middot; {symbol}</span>
          {priceVersion > 0 && <span className="text-[8px] text-slate-600 font-mono ml-2">v{priceVersion}</span>}
        </h3>
        <select
          value={selectedTimeframe}
          onChange={(e) => onTimeframeChange?.(e.target.value)}
          className="bg-gray-800 text-white text-xs sm:text-sm rounded-lg px-3 py-2 border border-gray-600 focus:outline-none focus:border-emerald-500 cursor-pointer font-mono pointer-events-auto relative z-20"
          aria-label="Select timeframe"
        >
          {tfOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mb-3 sm:mb-4 p-2 sm:p-3 bg-rose-500/10 border border-rose-800/50 rounded-lg">
          <p className="text-[10px] sm:text-[11px] text-rose-400 font-mono break-words">{error}</p>
          <button onClick={() => { const s = symbol?.trim().toUpperCase(); if (s) getPrediction(s, selectedTimeframe); }} className="mt-2 text-[9px] text-blue-400 hover:text-blue-300 font-mono underline">Retry</button>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4">
          <div className="w-3 h-3 sm:w-4 sm:h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-[10px] sm:text-[11px] text-slate-500 font-mono">Training model on {symbol} data...</span>
        </div>
      )}

      {predictionData && !isLoading && (
        <div className="space-y-4 sm:space-y-6">
          {/* Signal badge + prices row */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className={`px-2 sm:px-3 py-1 rounded-full text-[9px] sm:text-[10px] font-black uppercase tracking-wider ${predictionData.signal === "BUY" ? "bg-emerald-500/20 text-emerald-400" : predictionData.signal === "SELL" ? "bg-rose-500/20 text-rose-400" : "bg-slate-500/20 text-slate-400"}`}>{predictionData.signal}</span>
            <span className="text-[10px] sm:text-xs text-slate-500 font-mono">Target: {formatCurrency(predictionData.target_price)}</span>
            <span className="text-[10px] sm:text-xs text-slate-500 font-mono">Current: {formatCurrency(displayPrice)}</span>
            {deltaPct != null && (
              <span className={`text-[10px] sm:text-xs font-bold font-mono px-2 py-0.5 rounded ${Number(deltaPct) > 0 ? "text-emerald-400 bg-emerald-500/10" : Number(deltaPct) < 0 ? "text-rose-400 bg-rose-500/10" : "text-slate-400 bg-slate-500/10"}`}>
                Delta {Number(deltaPct) > 0 ? "+" : ""}{deltaPct}%
              </span>
            )}
          </div>

          {/* ML Confidence bar */}
          <div>
            <div className="flex justify-between text-[9px] sm:text-[10px] font-bold mb-1.5 sm:mb-2">
              <span className="text-slate-500">ML CONFIDENCE SCORE</span>
              <span className="text-emerald-400">{predictionData.confidence != null ? (predictionData.confidence * 100).toFixed(1) + "%" : "--"}</span>
            </div>
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: predictionData.confidence != null ? (predictionData.confidence * 100).toFixed(1) + "%" : "0%" }} />
            </div>
          </div>

          {/* Metrics grid (2-col mobile, 4-col desktop) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
            <MetricCard label="Signal" value={predictionData.signal} />
            <MetricCard label="ML Prob" value={predictionData.ml_probability != null ? formatNumber(predictionData.ml_probability, 4) : "--"} />
            <MetricCard label="Model Acc" value={predictionData.model_accuracy != null ? formatPercent(predictionData.model_accuracy, 1) : "--"} />
            <MetricCard label="RSI(14)" value={predictionData.indicators?.rsi_14 != null ? formatNumber(predictionData.indicators.rsi_14, 1) : "--"} />
            <MetricCard label="SMA(20)" value={predictionData.indicators?.sma_20 != null ? formatCurrency(predictionData.indicators.sma_20) : "--"} />
            <MetricCard label="SMA(50)" value={predictionData.indicators?.sma_50 != null ? formatCurrency(predictionData.indicators.sma_50) : "--"} />
            <MetricCard label="Timeframe" value={predictionData.timeframe ?? selectedTimeframe} />
            <MetricCard label="Latency" value={predictionData.proxyLatencyMs != null ? predictionData.proxyLatencyMs + "ms" : "--"} />
          </div>

          <div className="text-[9px] text-slate-600 font-mono">Updated: {displayTimestamp ? new Date(displayTimestamp).toLocaleString() : "--"}</div>
        </div>
      )}

      {!predictionData && !isLoading && !error && (
        <div className="py-6 sm:py-8 text-center"><p className="text-slate-600 text-[11px] sm:text-xs font-mono">Enter a symbol above and click Go</p></div>
      )}
    </div>
  );
};

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-black/40 p-2 sm:p-3 rounded-lg border border-white/5">
      <p className="text-[8px] sm:text-[9px] text-slate-500 uppercase font-black mb-0.5 sm:mb-1">{label}</p>
      <p className="text-[10px] sm:text-xs text-white font-mono truncate">{value}</p>
    </div>
  );
}

export default PredictiveIntelligence;
'''

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'Written {len(content)} chars')