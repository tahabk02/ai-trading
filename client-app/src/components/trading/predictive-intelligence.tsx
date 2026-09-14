"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useTradingStore } from "@/store/useTradingStore";
import { useLangContext } from "@/hooks/useLangContext";
import {
  formatNumber,
  formatPercent,
  formatPairPrice,
  formatLocalTime,
  sanitizeConfidence,
} from "@/utils/format";
import apiClient, { type PredictionResponse } from "@/services/api";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";
import { searchSymbolUniverse } from "@/constants/symbols";

export interface PredictiveIntelligenceProps {
  symbol?: string;
}

export const PredictiveIntelligence: React.FC<PredictiveIntelligenceProps> = ({
  symbol: propSymbol,
}) => {
  const { t, rtl } = useLangContext();
  const storeSymbol = useTradingStore((s) => s.activeSymbol);
  const symbol = propSymbol ?? storeSymbol;
  const currentPrice = useTradingStore((s) => s.currentPrice);
  const predictionData = useTradingStore((s) => s.predictionData);
  const isLoading = useTradingStore((s) => s.isLoading);
  const error = useTradingStore((s) => s.error);
  const quoteStreamWaiting = useTradingStore((s) => s.quoteStreamWaiting);
  const selectedTimeframe = useTradingStore((s) => s.selectedTimeframe);
  const setSelectedTimeframe = useTradingStore((s) => s.setSelectedTimeframe);

  const [mounted, setMounted] = useState(false);
  const [liveTime, setLiveTime] = useState<string>("");
  const initialFetchDone = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    setLiveTime(formatLocalTime(new Date()));
    const interval = setInterval(() => {
      setLiveTime(formatLocalTime(new Date()));
    }, 1_000);
    return () => clearInterval(interval);
  }, [mounted]);

  useEffect(() => {
    if (!mounted || initialFetchDone.current) return;
    initialFetchDone.current = true;
    const cs = (symbol || "").trim().toUpperCase();
    if (cs) {
      useTradingStore.getState().getPrediction(cs, selectedTimeframe);
    }
  }, [mounted, symbol, selectedTimeframe]);

  const handleTimeframeSelect = (newTf: string) => {
    setSelectedTimeframe(newTf);
  };

  const displayPrice =
    Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 0;

  let deltaDisplay: string | null = null;
  const targetPrice = predictionData?.target_price;
  const currentPriceVal = displayPrice;
  if (
    targetPrice != null &&
    Number.isFinite(targetPrice) &&
    Number.isFinite(currentPriceVal) &&
    currentPriceVal > 0
  ) {
    const rawDelta =
      ((Number(targetPrice) - currentPriceVal) / currentPriceVal) * 100;
    if (Number.isFinite(rawDelta)) {
      const clampedDelta = Math.max(-100, Math.min(100, rawDelta));
      const prefix = clampedDelta >= 0 ? "+" : "";
      deltaDisplay = `${prefix}${clampedDelta.toFixed(2)}%`;
    }
  }

  const tfOptions = [
    { value: "S5", label: "S5" },
    { value: "S10", label: "S10" },
    { value: "S15", label: "S15" },
    { value: "S30", label: "S30" },
    { value: "M1", label: "M1" },
    { value: "M2", label: "M2" },
    { value: "M3", label: "M3" },
    { value: "M5", label: "M5" },
    { value: "M10", label: "M10" },
    { value: "M15", label: "M15" },
    { value: "M30", label: "M30" },
    { value: "H1", label: "H1" },
    { value: "H4", label: "H4" },
    { value: "D1", label: "D1" },
  ];

  if (!mounted) {
    return (
      <div className="bg-obsidian border border-slate-800 rounded-xl p-4 backdrop-blur-sm animate-pulse h-full">
        <div className="h-4 w-48 bg-slate-800 rounded mb-6" />
        <div className="h-20 w-full bg-slate-800/50 rounded" />
      </div>
    );
  }

  const displayConfidence = sanitizeConfidence(predictionData?.confidence);

  // ── THERMAL-QUARANTINE STATE (96.5% hard floor) ──
  // When the engine demotes a sub-thermal directional verdict to market-waiting
  // (CONFLUENCE_BELOW_THERMAL), the confidence gauge turns amber to make the
  // quarantine legible at a glance — the raw % stays honest, the name of the
  // gate replaces the generic "confidence" caption. The direction itself is
  // NEVER hidden: BUY/SELL always shown above.
  const thermallyGated =
    predictionData?.market_waiting === true &&
    predictionData.waiting_reason === "CONFLUENCE_BELOW_THERMAL";

  const indicators = predictionData?.indicators as
    | PredictionResponse["indicators"]
    | Record<string, number>
    | undefined;
  const scalpingInd = predictionData?.scalping_indicators;
  const rsiVal =
    indicators?.rsi_14 ??
    scalpingInd?.rsi_14 ??
    (indicators as any)?.rsi ??
    null;
  const sma20Val =
    indicators?.sma_20 ??
    scalpingInd?.sma_20 ??
    (indicators as any)?.sma20 ??
    null;
  const sma50Val =
    indicators?.sma_50 ??
    scalpingInd?.sma_50 ??
    (indicators as any)?.sma50 ??
    null;

  return (
    <div
      className="bg-obsidian border border-slate-800 rounded-xl p-4 sm:p-5 backdrop-blur-sm relative flex flex-col justify-between shadow-sm transition-colors duration-200"
      dir={rtl ? "rtl" : "ltr"}
    >
      <div>
        <div className="flex items-center justify-between mb-2 gap-2">
          <h3 className="text-white font-bold text-xs sm:text-sm uppercase tracking-wider flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            {t("predictiveIntelligence")}
          </h3>

          <div className="flex items-center gap-2 relative">
            <SymbolSearchInput />
          </div>
        </div>

        <p className="text-[10px] text-slate-500 font-mono mb-4">
          {t("mlInferenceSubtitle")}
        </p>

        {error && (
          <div className="mb-3 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl">
            <p className="text-[11px] text-rose-400 font-mono break-words">
              {error}
            </p>
          </div>
        )}

        {/* ── LIVE-QUOTE WAITING (503 / quote-stream timeout) ──
             A recoverable backend outage while /predict auto-re-polls with
             exponential backoff. Keeps the last good prediction on screen and
             shows a CALM amber banner instead of a red error. */}
        {quoteStreamWaiting && (
          <div className="mb-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <p className="text-[11px] text-amber-400 font-mono break-words">
              {t("waitingLiveStream")}
            </p>
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 my-6 justify-center py-4">
            <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-slate-400 font-mono">
              {t("runningInference")}
            </span>
          </div>
        )}

        {predictionData && !isLoading && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between bg-obsidian-950/60 p-3 rounded-xl border border-slate-800 gap-2">
              <span
                className={
                  "px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wider " +
                  (predictionData.signal === "BUY"
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                    : predictionData.signal === "SELL"
                      ? "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                      : "bg-slate-800 text-slate-300 border border-slate-600")
                }
              >
                {predictionData.signal}
              </span>

              {/* ── MARKET-WAITING FLAG — the dynamic confluence floor ── */}
              {predictionData.market_waiting === true &&
                !!predictionData.waiting_reason && (
                  <span
                    className={
                      "px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-wider " +
                      (predictionData.waiting_reason === "CONFLUENCE_BELOW_THERMAL"
                        ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                        : predictionData.waiting_reason === "AI_ENGINE_UNAVAILABLE"
                          ? "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                          : "bg-slate-800 text-slate-400 border border-slate-600")
                    }
                    title={predictionData.waiting_detail ?? predictionData.waiting_reason}
                  >
                    {predictionData.waiting_reason === "CONFLUENCE_BELOW_THERMAL"
                      ? "MARKET WAITING"
                      : predictionData.waiting_reason === "AI_ENGINE_UNAVAILABLE"
                        ? "ENGINE UNAVAILABLE"
                        : "WAITING"}
                  </span>
                )}

              <div className="flex items-center gap-4 font-mono text-xs">
                <span className="text-slate-400 font-bold">
                  {t("target")}:{" "}
                  <strong className="text-white">
                    ${formatPairPrice(predictionData.target_price, symbol)}
                  </strong>
                </span>
                <span className="text-slate-400 font-bold">
                  {t("current")}:{" "}
                  <strong className="text-white">
                    ${formatPairPrice(displayPrice, symbol)}
                  </strong>
                </span>
                {deltaDisplay != null && (
                  <span
                    className={
                      "font-bold px-1.5 py-0.5 rounded text-xs " +
                      (deltaDisplay.startsWith("+")
                        ? "text-emerald-400 bg-emerald-500/10"
                        : deltaDisplay.startsWith("-")
                          ? "text-rose-400 bg-rose-500/10"
                          : "text-slate-600 dark:text-slate-400 bg-slate-500/10")
                    }
                  >
                    {deltaDisplay}
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-1 bg-obsidian-950/60 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center text-center relative min-h-[180px]">
                <div
                  className={
                    "relative w-28 h-28 flex items-center justify-center rounded-full border-4 bg-obsidian-950 shadow-inner " +
                    (thermallyGated
                      ? "border-amber-400/50 shadow-[0_0_18px_rgba(245,158,11,0.25)]"
                      : "border-slate-800")
                  }
                >
                  <div className="flex flex-col items-center">
                    <span
                      className={
                        "text-xl font-bold font-mono " +
                        (thermallyGated
                          ? "text-amber-400"
                          : "text-white")
                      }
                    >
                      {displayConfidence}%
                    </span>
                    <span
                      className={
                        "text-[9px] font-mono tracking-wider uppercase font-bold " +
                        (thermallyGated
                          ? "text-amber-400"
                          : "text-slate-400")
                      }
                    >
                      {thermallyGated ? "MARKET WAITING" : t("confidence")}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between w-full mt-4 text-[9px] font-mono text-slate-400 border-t border-slate-800 pt-2">
                  <span>
                    {t("mlProb")}:{" "}
                    {predictionData.ml_probability != null
                      ? (predictionData.ml_probability * 100).toFixed(1) + "%"
                      : "--"}
                  </span>
                  <span>
                    {t("acc")}:{" "}
                    {predictionData.model_accuracy != null
                      ? formatPercent(predictionData.model_accuracy, 1)
                      : "--"}
                  </span>
                </div>
              </div>

              <div className="md:col-span-2 grid grid-cols-2 sm:grid-cols-2 gap-2">
                <MetricCard
                  label={t("rsi14")}
                  value={rsiVal != null ? formatNumber(rsiVal, 1) : "--"}
                />
                <MetricCard
                  label={t("sma20")}
                  value={
                    sma20Val != null
                      ? `$${formatPairPrice(sma20Val, symbol)}`
                      : "--"
                  }
                />
                <MetricCard
                  label={t("sma50")}
                  value={
                    sma50Val != null
                      ? `$${formatPairPrice(sma50Val, symbol)}`
                      : "--"
                  }
                />
                <div className="bg-obsidian-950/60 p-3 rounded-xl border border-slate-800 flex flex-col justify-between">
                  <p className="text-[9px] text-slate-500 uppercase font-black mb-1">
                    {t("timeframe")}
                  </p>
                  <select
                    value={selectedTimeframe}
                    onChange={(e) => handleTimeframeSelect(e.target.value)}
                    className="bg-obsidian-950 border border-slate-700 text-white font-mono text-xs font-bold rounded px-2 py-1 w-full focus:outline-none focus:border-emerald-500 cursor-pointer"
                  >
                    {tfOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <MetricCard
                  label={t("proxyLatency")}
                  value={
                    predictionData.proxyLatencyMs != null
                      ? predictionData.proxyLatencyMs + "ms"
                      : "--"
                  }
                />
                <MetricCard label={t("updated")} value={liveTime || "--"} />
              </div>
            </div>
          </div>
        )}

        {!predictionData && !isLoading && !error && !quoteStreamWaiting && (
          <div className="py-8 text-center">
            <p className="text-slate-500 text-xs font-mono">
              {t("enterSymbolPrompt")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-obsidian-950/60 p-3 rounded-xl border border-slate-800 flex flex-col justify-between min-h-[64px]">
      <p className="text-[9px] text-slate-500 uppercase font-black mb-1">
        {label}
      </p>
      <p className="text-xs text-white font-mono font-bold truncate">{value}</p>
    </div>
  );
}

function SymbolSearchInput() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    Array<{ symbol: string; name: string; type: string }>
  >([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const isFocusedRef = useRef(false);

  useEffect(() => {
    const currentSymbol = useTradingStore.getState().activeSymbol;
    setQuery(currentSymbol);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    const whitelist = searchSymbolUniverse(q, 12);
    setLoading(true);
    try {
      const data = await apiClient.getSymbols(q || undefined, undefined, 15);
      const merged = new Map<string, { symbol: string; name: string; type: string }>();
      for (const w of whitelist) merged.set(w.symbol.toUpperCase(), w);
      for (const r of data.symbols) {
        if (!merged.has(r.symbol.toUpperCase())) {
          merged.set(r.symbol.toUpperCase(), {
            symbol: r.symbol,
            name: r.name ?? r.symbol,
            type: r.type,
          });
        }
      }
      const list = Array.from(merged.values()).slice(0, 15);
      setResults(list);
      setIsOpen(list.length > 0 && isFocusedRef.current);
    } catch {
      // Backend /symbols unreachable / timing out / 400-504 — the strict
      // whitelist keeps search fully alive client-side, no fabricated pairs.
      setResults(whitelist);
      setIsOpen(whitelist.length > 0 && isFocusedRef.current);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 150);
  };

  const handleFocus = () => {
    isFocusedRef.current = true;
    doSearch(query);
  };

  const handleSelect = (sym: string) => {
    setQuery(sym);
    setIsOpen(false);
    useTradingStore.getState().setActiveSymbol(sym);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      const val = query.trim().toUpperCase();
      if (val) {
        setIsOpen(false);
        useTradingStore.getState().setActiveSymbol(val);
      }
    }
    if (e.key === "Escape") {
      setIsOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        placeholder="Search symbols..."
        value={query}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={() => {
          isFocusedRef.current = false;
          setTimeout(() => setIsOpen(false), 200);
        }}
        className="bg-obsidian-950 border border-slate-700 text-white text-xs font-bold rounded-lg px-2.5 py-1.5 w-32 focus:outline-none focus:border-emerald-500 font-mono shadow-sm"
      />
      {loading && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2">
          <div className="w-3 h-3 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {isOpen && results.length > 0 && (
        <div className="absolute top-full right-0 mt-1 w-64 bg-obsidian-950 border border-slate-700 rounded-xl shadow-2xl z-50 max-h-60 overflow-y-auto">
          {results.map((r) => (
            <button
              key={r.symbol}
              type="button"
              onMouseDown={() => handleSelect(r.symbol)}
              className="w-full text-left px-3 py-2 hover:bg-slate-800 text-white text-xs font-mono flex items-center justify-between gap-2 border-b border-slate-800 last:border-0"
            >
              <span className="font-bold text-emerald-400">{r.symbol}</span>
              <span className="text-slate-500 truncate text-[10px]">
                {r.name}
              </span>
              <AssetClassBadge symbol={r.symbol} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default PredictiveIntelligence;

