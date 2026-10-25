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
import { TierBadge } from "@/components/shared/tier-badge";
import { PredictiveMicrostructure } from "@/components/trading/predictive-microstructure";
import { getAssetSubType, searchSymbolUniverse } from "@/constants/symbols";
import {
  classifyVerdictState,
  errorHeadline,
  withheldHeadline,
} from "@/lib/verdict-state";

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
    { value: "W1", label: "W1" },
    { value: "MN1", label: "MN1" },
  ];

  if (!mounted) {
    return (
      <div className="bg-surface border border-line rounded-card p-4 backdrop-blur-sm animate-pulse h-full">
        <div className="h-4 w-48 bg-elevated rounded mb-6" />
        <div className="h-20 w-full bg-elevated rounded" />
      </div>
    );
  }

  const displayConfidence = sanitizeConfidence(predictionData?.confidence);
  // PART 19.2 [118] — the gauge is a BOOK AGREEMENT confluence score, never a
  // probability; the n/n books-aligned label sits under the % (when known).
  const bookA = predictionData?.book_agreement_detail?.aligned_count ?? null;
  const bookN = predictionData?.book_agreement_detail?.active_count ?? null;

  // ── SINGLE SOURCE OF TRUTH for the banner ──
  // A transport failure outranks any verdict: after a failed request the
  // verdict on screen is STALE, and showing its tier/confidence alongside an
  // error is what made a dead backend look like a confident market. The
  // confidence gauge and tier badge are suppressed on ERROR because no
  // authoritative number exists for that cycle.
  const verdictState = classifyVerdictState(
    predictionData as unknown as Parameters<typeof classifyVerdictState>[0],
    error,
    isLoading,
  );
  const transportFailed = verdictState.kind === "ERROR";
  const withheldState =
    verdictState.kind === "WITHHELD" ? verdictState : null;

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
      className="bg-surface border border-line rounded-card p-4 sm:p-5 backdrop-blur-sm relative flex flex-col justify-between shadow-sm transition-colors duration-200"
      dir={rtl ? "rtl" : "ltr"}
    >
      <div>
        <div className="flex items-center justify-between mb-2 gap-2">
          <h3 className="text-ink font-bold text-xs sm:text-sm uppercase tracking-wider flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-st-pos inline-block shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            {t("predictiveIntelligence")}
          </h3>

          <div className="flex items-center gap-2 relative">
            <SymbolSearchInput />
          </div>
        </div>

        <p className="text-[10px] text-ink-faint font-mono mb-4">
          {t("mlInferenceSubtitle")}
        </p>

        {error && (
          <div className="mb-3 p-3 bg-st-neg/10 border border-st-neg/30 rounded-card">
            <p className="text-[11px] text-st-neg font-mono break-words">
              {error}
            </p>
          </div>
        )}

        {/* ── LIVE-QUOTE WAITING (503 / quote-stream timeout) ──
             A recoverable backend outage while /predict auto-re-polls with
             exponential backoff. Keeps the last good prediction on screen and
             shows a CALM amber banner instead of a red error. */}
        {quoteStreamWaiting && (
          <div className="mb-3 p-3 bg-st-warn/10 border border-st-warn/30 rounded-card flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-st-warn animate-pulse shrink-0" />
            <p className="text-[11px] text-st-warn font-mono break-words">
              {t("waitingLiveStream")}
            </p>
          </div>
        )}

        {/* ── P1-2026-09-24 — non-blocking ──
             The full-panel ML spinner only appears when there is NO verdict to
             show yet (an initial cold /predict). Once a verdict exists it stays
             on screen even while a re-fetch runs — a subtle "RECOMPUTING…"
             chip signals the background refresh instead of swapping the panel
             for a spinner (which previously froze the component tree). */}
        {isLoading && !predictionData && (
          <div className="flex items-center gap-2 my-6 justify-center py-4">
            <div className="w-4 h-4 border-2 border-st-pos border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-ink-muted font-mono">
              {t("runningInference")}
            </span>
          </div>
        )}

        {predictionData && (
          <div className="space-y-4">
            {/* ── WITHHELD vs ERROR: the two states that must never be confused ──
                 ERROR (transport/gateway/timeout) renders a ROSE banner and
                 SUPPRESSES the tier badge + confidence gauge entirely — the
                 verdict in the store is stale for this cycle, so its number is
                 not shown at all. WITHHELD (risk gate declined) renders a calm
                 SLATE banner and KEEPS the real confluence number visible,
                 because that number is genuine and auditable. */}
            {transportFailed && verdictState.kind === "ERROR" && (
              <div
                data-testid="verdict-error-banner"
                role="alert"
                className="mb-3 p-3 bg-st-neg/10 border border-st-neg/30 rounded-card"
              >
                <p className="text-[11px] text-st-neg font-mono break-words">
                  {errorHeadline(verdictState.errorKind)}
                </p>
                {verdictState.detail && (
                  <p className="text-[10px] text-st-neg/70 font-mono mt-1 break-words">
                    {verdictState.detail}
                  </p>
                )}
              </div>
            )}

            {withheldState && (
              <div
                data-testid="verdict-withheld-banner"
                className="mb-3 p-3 bg-elevated border border-line rounded-card"
              >
                <p className="text-[11px] text-ink-muted font-mono break-words">
                  {withheldHeadline(withheldState.reason)}
                </p>
                {withheldState.detail && (
                  <p className="text-[10px] text-ink-faint font-mono mt-1 break-words">
                    {withheldState.detail}
                  </p>
                )}
              </div>
            )}

            {(isLoading && predictionData) && (
              <div className="flex items-center justify-end gap-2">
                <div className="w-3 h-3 border-2 border-st-warn border-t-transparent rounded-full animate-spin" />
                <span className="text-[10px] text-st-warn font-mono uppercase tracking-wider">
                  {t("recomputingSignal")}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between bg-well p-3 rounded-card border border-line gap-2">
              <span
                className={
                  "px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wider " +
                  (predictionData.signal === "BUY"
                    ? "bg-st-pos/15 text-st-pos border border-st-pos/30"
                    : predictionData.signal === "SELL"
                      ? "bg-st-neg/15 text-st-neg border border-st-neg/30"
                      : "bg-elevated text-ink-muted border border-line-strong")
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
                      (predictionData.waiting_reason ===
                      "CONFLUENCE_BELOW_THERMAL"
                        ? "bg-st-warn/15 text-st-warn border border-st-warn/30"
                        : predictionData.waiting_reason ===
                            "AI_ENGINE_UNAVAILABLE"
                          ? "bg-st-neg/15 text-st-neg border border-st-neg/30"
                          : "bg-elevated text-ink-muted border border-line-strong")
                    }
                    title={
                      predictionData.waiting_detail ??
                      predictionData.waiting_reason
                    }
                  >
                    {predictionData.waiting_reason ===
                    "CONFLUENCE_BELOW_THERMAL"
                      ? "MARKET WAITING"
                      : predictionData.waiting_reason ===
                          "AI_ENGINE_UNAVAILABLE"
                        ? "ENGINE UNAVAILABLE"
                        : "WAITING"}
                  </span>
                )}

              {/* ── PART 6: HONEST TIER BADGE (engine-dispatched) ──
                   Suppressed on a transport ERROR: the verdict behind it is
                   stale, and a tier badge next to a dead-connection banner is
                   the exact "false premium" illusion this clamp removes. The
                   backend's tier coherence clamp already demotes withheld
                   calls to T5/WEAK, so a WITHHELD state still shows its real
                   (non-premium) tier. */}
              {!transportFailed && (
                <TierBadge
                  tier={predictionData.tier}
                  confidence={
                    displayConfidence != null
                      ? Number(displayConfidence)
                      : null
                  }
                  size="sm"
                />
              )}

              <div className="flex items-center gap-4 font-mono text-xs">
                <span className="text-ink-muted font-bold">
                  {t("target")}:{" "}
                  <strong className="text-ink">
                    ${formatPairPrice(predictionData.target_price, symbol)}
                  </strong>
                </span>
                <span className="text-ink-muted font-bold">
                  {t("current")}:{" "}
                  <strong className="text-ink">
                    ${formatPairPrice(displayPrice, symbol)}
                  </strong>
                </span>
                {deltaDisplay != null && (
                  <span
                    className={
                      "font-bold px-1.5 py-0.5 rounded text-xs " +
                      (deltaDisplay.startsWith("+")
                        ? "text-st-pos bg-st-pos/10"
                        : deltaDisplay.startsWith("-")
                          ? "text-st-neg bg-st-neg/10"
                          : "text-ink-muted bg-slate-500/10")
                    }
                  >
                    {deltaDisplay}
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {transportFailed ? (
                /* Transport failure: the confluence number on screen belongs to
                   the LAST good cycle, not this one. Rendering it would put a
                   live-looking percentage next to a dead-connection banner, so
                   the gauge is replaced by an explicit "no verdict" state. */
                <div
                  data-testid="verdict-gauge-suppressed"
                  className="md:col-span-1 bg-well border border-line rounded-card p-4 flex items-center justify-center text-center relative min-h-[180px]"
                >
                  <div className="flex flex-col items-center gap-1">
                    <span className="w-8 h-8 border-2 border-line-strong border-t-transparent rounded-full animate-spin" />
                    <span className="text-[10px] font-mono text-ink-faint uppercase tracking-wider">
                      no verdict this cycle
                    </span>
                  </div>
                </div>
              ) : (
              <div className="md:col-span-1 bg-well border border-line rounded-card p-4 flex flex-col items-center justify-center text-center relative min-h-[180px]">
                <div
                  className={
                    "relative w-28 h-28 flex items-center justify-center rounded-full border-4 bg-well shadow-inner " +
                    (thermallyGated
                      ? "border-st-warn/50 shadow-[0_0_18px_rgba(245,158,11,0.25)]"
                      : "border-line")
                  }
                >
                  <div className="flex flex-col items-center">
                    <span
                      className={
                        "text-xl font-bold font-mono " +
                        (thermallyGated ? "text-st-warn" : "text-ink")
                      }
                    >
                      {displayConfidence}%
                    </span>
                    {bookN && bookN > 0 ? (
                      <span className="text-[8px] font-mono text-ink-faint uppercase font-semibold">
                        {bookA}/{bookN} books
                      </span>
                    ) : null}
                    <span
                      className={
                        "text-[9px] font-mono tracking-wider uppercase font-bold " +
                        (thermallyGated ? "text-st-warn" : "text-ink-muted")
                      }
                    >
                      {thermallyGated ? "MARKET WAITING" : t("confidence")}
                    </span>
                  </div>
                </div>

                <div className="w-full mt-4 border-t border-line pt-2 text-[9px] font-mono text-ink-muted">
                  {/* PART 22.1 [151] — when the RF corroborator did not run for
                      this tape, say so explicitly; never quietly show
                      confluence-derived numbers under RF-labeled fields. */}
                  {predictionData.corroborator_unavailable ? (
                    <p
                      className="uppercase font-bold text-st-warn"
                      title={t("rfCorroboratorUnavailableTitle")}
                    >
                      {t("rfCorroboratorUnavailable")}
                    </p>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      {/* PART 22.1 [152] — `rfHoldoutAccuracy` reads as what it
                          actually is (RF holdout accuracy, last 20% of candles,
                          this symbol), not as the shipped signal's precision. */}
                      <span title={t("rfHoldoutAccuracyTitle")}>
                        {t("rfHoldoutAccuracy")}:{" "}
                        {predictionData.rf_holdout_accuracy != null
                          ? formatPercent(predictionData.rf_holdout_accuracy, 1)
                          : "--"}
                      </span>
                      <span>
                        {t("rfProbability")}:{" "}
                        {predictionData.rf_probability != null
                          ? (predictionData.rf_probability * 100).toFixed(1) + "%"
                          : "--"}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              )}

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
                <div className="bg-well p-3 rounded-card border border-line flex flex-col justify-between">
                  <p className="text-[9px] text-ink-faint uppercase font-black mb-1">
                    {t("timeframe")}
                  </p>
                  <select
                    value={selectedTimeframe}
                    onChange={(e) => handleTimeframeSelect(e.target.value)}
                    className="bg-well border border-line-strong text-ink font-mono text-xs font-bold rounded px-2 py-1 w-full focus:outline-none focus:border-st-pos cursor-pointer"
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

            <PredictiveMicrostructure
              predictive={predictionData.predictive}
            />
          </div>
        )}

        {!predictionData && !isLoading && !error && !quoteStreamWaiting && (
          <div className="py-8 text-center">
            <p className="text-ink-faint text-xs font-mono">
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
    <div className="bg-well p-3 rounded-card border border-line flex flex-col justify-between min-h-[64px]">
      <p className="text-[9px] text-ink-faint uppercase font-black mb-1">
        {label}
      </p>
      <p className="text-xs text-ink font-mono font-bold truncate">{value}</p>
    </div>
  );
}

function SymbolSearchInput() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    Array<{ symbol: string; name: string; type: string; assetSubType?: string }>
  >([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFocusedRef = useRef(false);

  useEffect(() => {
    const currentSymbol = useTradingStore.getState().activeSymbol;
    setQuery(currentSymbol);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const data = await apiClient.getSymbols(q || undefined, undefined, 100);
      const list = data.symbols.map((r) => ({
        symbol: r.symbol,
        name: r.name ?? r.symbol,
        type: r.type,
        assetSubType: r.assetSubType,
      }));
      setResults(list);
      setIsOpen(list.length > 0 && isFocusedRef.current);
    } catch {
      // Backend /symbols unreachable / timing out / 400-504 — the strict
      // whitelist keeps search fully alive client-side, no fabricated pairs.
      const fallback = searchSymbolUniverse(q, 100).map((entry) => ({
        symbol: entry.symbol,
        name: entry.name,
        type: entry.type,
        assetSubType: getAssetSubType(entry.symbol),
      }));
      setResults(fallback);
      setIsOpen(fallback.length > 0 && isFocusedRef.current);
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
        className="bg-well border border-line-strong text-ink text-xs font-bold rounded-lg px-2.5 py-1.5 w-32 focus:outline-none focus:border-st-pos font-mono shadow-sm"
      />
      {loading && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2">
          <div className="w-3 h-3 border-2 border-st-pos border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {isOpen && results.length > 0 && (
        <div className="absolute top-full right-0 mt-1 w-64 bg-well border border-line-strong rounded-card shadow-2xl z-50 max-h-60 overflow-y-auto">
          {(["forex", "crypto", "commodity", "otc"] as const).map(
            (category) => {
              const grouped = results.filter(
                (r) =>
                  (r.assetSubType || getAssetSubType(r.symbol)) === category,
              );
              if (grouped.length === 0) return null;
              return (
                <React.Fragment key={category}>
                  <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-ink-faint bg-elevated">
                    {category === "forex"
                      ? "Currencies"
                      : category === "commodity"
                        ? "Commodities"
                        : category === "crypto"
                          ? "Crypto"
                          : "OTC"}
                  </div>
                  {grouped.map((r) => (
                    <button
                      key={r.symbol}
                      type="button"
                      onMouseDown={() => handleSelect(r.symbol)}
                      className="w-full text-left px-3 py-2 hover:bg-elevated text-ink text-xs font-mono flex items-center justify-between gap-2 border-b border-line last:border-0"
                    >
                      <span className="font-bold text-st-pos">
                        {r.symbol}
                      </span>
                      <span className="text-ink-faint truncate text-[10px]">
                        {r.name}
                      </span>
                      <AssetClassBadge symbol={r.symbol} />
                    </button>
                  ))}
                </React.Fragment>
              );
            },
          )}
        </div>
      )}
    </div>
  );
}

export default PredictiveIntelligence;
