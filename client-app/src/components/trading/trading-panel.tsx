"use client";

import React, { useEffect, useCallback, useRef, useState } from "react";
import {
  useTradingStore,
  startRiskPolling,
  stopRiskPolling,
  realtimeAggregator,
} from "@/store/useTradingStore";
import { useLangContext } from "@/hooks/useLangContext";
import { useSocket } from "@/hooks/useSocket";
import {
  TrendingUp,
  TrendingDown,
  Timer,
  Clock,
  Zap,
  ShieldAlert,
  ShieldCheck,
  Lock,
  Unlock,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { formatPairPrice } from "@/utils/format";
import { getPairLabel } from "@/constants/symbols";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";
import { useCandleCountdown } from "@/hooks/useCandleCountdown";
import {
  normalizeTimeframe,
  TIMEFRAME_MS,
  buildSignalView,
  SIGNAL_CONFIDENCE_THRESHOLD,
} from "@/lib/realtimeCandleAggregator";

// ── POCKET-OPTION CANONICAL EXPIRATION SET ──
// Mirrors the backend PO expiration whitelist exactly (seconds). The chart
// computes target-candle count from these SAME values; picker ↔ chart stays
// 1:1 with zero conversion drift.
const TIMER_OPTIONS = [
  { label: "1s", seconds: 1 },
  { label: "5s", seconds: 5 },
  { label: "10s", seconds: 10 },
  { label: "15s", seconds: 15 },
  { label: "20s", seconds: 20 },
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "3m", seconds: 180 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
  { label: "15m", seconds: 900 },
  { label: "30m", seconds: 1800 },
  { label: "1h", seconds: 3600 },
  { label: "4h", seconds: 14400 },
  { label: "12h", seconds: 43200 },
  { label: "1d", seconds: 86400 },
];

function formatCountdown(s: number): string {
  const clamped = Math.max(0, Math.floor(s));
  const m = Math.floor(clamped / 60);
  const sec = clamped % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function lastPriceUpdateShort(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return "unknown time";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

export const TradingPanel: React.FC<{ stalePrice?: boolean }> = ({
  stalePrice = false,
}) => {
  const [isMounted, setIsMounted] = useState(false);
  const { t, rtl } = useLangContext();
  const { connected: socketConnected } = useSocket();
  const activeSymbol = useTradingStore((s) => s.activeSymbol);
  const currentPrice = useTradingStore((s) => s.currentPrice);
  const feedStatus = useTradingStore((s) => s.feedStatus);
  const lastPriceUpdate = useTradingStore((s) => s.lastPriceUpdate);
  const predictionData = useTradingStore((s) => s.predictionData);
  const expirationSeconds = useTradingStore((s) => s.expirationSeconds);
  const countdownSeconds = useTradingStore((s) => s.countdownSeconds);
  const isTradeActive = useTradingStore((s) => s.isTradeActive);
  const lastTradeResult = useTradingStore((s) => s.lastTradeResult);
  const setExpirationSeconds = useTradingStore((s) => s.setExpirationSeconds);
  const selectedExpirationSeconds = useTradingStore(
    (s) => s.selectedExpirationSeconds,
  );
  const setSelectedExpirationSeconds = useTradingStore(
    (s) => s.setSelectedExpirationSeconds,
  );
  const executeTrade = useTradingStore((s) => s.executeTrade);
  const clearTradeResult = useTradingStore((s) => s.clearTradeResult);
  // Trade expiry and CHART timeframe are fully decoupled: the candle-close
  // countdown below reads the ACTIVE CHART BUCKET (NOT the trade duration) so
  // the fallback wall-clock grid (pre-aggregator) matches the live boundary.
  const selectedTimeframe = useTradingStore((s) => s.selectedTimeframe);

  const isKillSwitchLocked = useTradingStore((s) => s.isKillSwitchLocked);
  const killSwitchReason = useTradingStore((s) => s.killSwitchReason);
  const riskState = useTradingStore((s) => s.riskState);
  const resetKillSwitch = useTradingStore((s) => s.resetKillSwitch);
  const refreshRiskState = useTradingStore((s) => s.refreshRiskState);
  const [unlockArmed, setUnlockArmed] = useState(false);

  useEffect(() => {
    // Participate in the SHARED risk snapshot poller (single 30s loop).
    startRiskPolling(refreshRiskState);
    return () => stopRiskPolling();
  }, [refreshRiskState]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // ── LIVE EXPIRY COUNTDOWN ──
  // The EXPIRY readout ticks down in real time (250ms) from the SELECTED
  // expiration once the trade is active, and resets to the full selected
  // duration whenever the user changes the expiration option. This is a pure
  // wall-clock countdown — it never touches the chart timeframe or the
  // candle build bucket.
  const [expiryRemainingS, setExpiryRemainingS] = useState<number | null>(null);
  const expiryDeadlineRef = useRef<number | null>(null);

  useEffect(() => {
    if (isTradeActive) {
      expiryDeadlineRef.current =
        Date.now() + Math.max(1, selectedExpirationSeconds) * 1000;
      setExpiryRemainingS(Math.max(1, selectedExpirationSeconds));
    } else {
      expiryDeadlineRef.current = null;
      setExpiryRemainingS(null);
    }
  }, [isTradeActive, selectedExpirationSeconds]);

  useEffect(() => {
    if (!isMounted) return;
    const iv = setInterval(() => {
      const deadline = expiryDeadlineRef.current;
      if (deadline == null) {
        setExpiryRemainingS(Math.max(60, selectedExpirationSeconds));
        return;
      }
      const rem = Math.max(0, (deadline - Date.now()) / 1000);
      setExpiryRemainingS(rem);
      if (rem <= 0) expiryDeadlineRef.current = null;
    }, 250);
    return () => clearInterval(iv);
  }, [isMounted, selectedExpirationSeconds]);

  useEffect(() => {
    if (lastTradeResult) {
      const timer = setTimeout(clearTradeResult, 5000);
      return () => clearTimeout(timer);
    }
  }, [lastTradeResult, clearTradeResult]);

  // ── SINGLE SIGNAL GATE ──
  // The 96.5% hard gate (PO AI parity) is applied EXACTLY ONCE here through
  // `buildSignalView` — the same single source the chart and analysis use.
  // A below-threshold verdict yields NO gated signal: the buttons are
  // disabled/neutral and the badge shows the waiting state. The gate is never
  // bypassed: BUY/SELL execution requires a gated directional verdict.
  const signalView = buildSignalView(
    predictionData,
    SIGNAL_CONFIDENCE_THRESHOLD,
  );
  const gatedSignal = signalView.gatedSignal;
  const isCall = gatedSignal === "BUY";
  const isPut = gatedSignal === "SELL";
  // NO gated direction (awaiting prediction OR below the 96.5% threshold) → the
  // execution buttons stay locked/neutral until the gate passes.
  const signalLocked = gatedSignal === null;
  // NEVER display HOLD — the engine always resolves BUY/SELL. Before the first
  // gated directional verdict lands the badge shows a neutral waiting state.
  const direction = isCall ? "BUY" : isPut ? "SELL" : "WAITING";

  // ── LIVE CANDLE-CLOSE COUNTDOWN (LEAD-SHIFTED, SSR-safe) ──
  // Sweeps down to the next barrier rollover. Grid-locked to the aggregator's
  // lead-shifted boundary geometry (exactly one timeframe ahead of the feed) —
  // the browser clock never sets the expiry. The fallback window is the ACTIVE
  // CHART bucket (from the chart timeframe), never the trade duration.
  const chartWindowSeconds = Math.max(
    1,
    Math.round(
      (TIMEFRAME_MS[normalizeTimeframe(selectedTimeframe) ?? "M1"] ?? 60_000) /
        1000,
    ),
  );
  const { remainingSeconds, progressPct, mounted } = useCandleCountdown(
    chartWindowSeconds,
    250,
    realtimeAggregator,
  );

  // `streamLive` means: socket up, a price has arrived, AND that price is
  // still FRESH (no ticks > 2s). When the tape goes stale the panel is treated
  // exactly like a disconnected stream — every trade button locks and the
  // signal badge switches to "Waiting for Real-time Tick".
  const streamLive =
    socketConnected && currentPrice > 0 && !stalePrice;

  const handleCall = useCallback(() => executeTrade("CALL"), [executeTrade]);
  const handlePut = useCallback(() => executeTrade("PUT"), [executeTrade]);

  if (!isMounted) {
    return (
      <div className="bg-obsidian border border-slate-800/80 rounded-2xl h-full animate-pulse min-h-[300px] w-full" />
    );
  }

  return (
    <div
      className="bg-obsidian border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl shadow-black/40 flex flex-col transition-colors duration-200 max-w-full"
      dir={rtl ? "rtl" : "ltr"}
    >
      {/* Header */}
      <div className="px-3 sm:px-4 pt-3 sm:pt-4 pb-2 sm:pb-3 border-b border-slate-800/60">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-emerald-500 shrink-0" />
            <h3 className="text-white font-black text-xs sm:text-sm uppercase tracking-wider">
              {t("quickTrade")}
            </h3>
          </div>
          <span className="text-[9px] sm:text-[10px] text-slate-500 font-mono font-bold uppercase tracking-wider flex items-center gap-1.5 min-w-0">
            <span className="truncate">{getPairLabel(activeSymbol)}</span>
            <AssetClassBadge symbol={activeSymbol} />
          </span>
        </div>
        <div className="mt-1.5 sm:mt-2 flex items-center justify-between">
          <span className="text-[9px] sm:text-[10px] text-slate-500 uppercase font-bold tracking-wider">
            {t("price")}
          </span>
          <span className="text-xs sm:text-sm text-white font-bold font-mono tabular-nums">
            {currentPrice > 0
              ? `$${formatPairPrice(currentPrice, activeSymbol)}`
              : "---"}
          </span>
        </div>
      </div>

      {/* AI Signal Badge — paused on stale tape */}
      <div className="mx-3 sm:mx-4 mt-2 sm:mt-3">
        <div
          className={cn(
            "flex items-center justify-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl font-bold text-xs sm:text-sm uppercase tracking-wider transition-all duration-300",
            stalePrice
              ? "bg-amber-500/10 text-amber-400 border border-amber-500/40"
              : isCall
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 animate-pulse-glow shadow-[0_0_12px_rgba(34,197,94,0.2)]"
                : isPut
                  ? "bg-rose-500/15 text-rose-400 border border-rose-500/30 animate-pulse-glow shadow-[0_0_12px_rgba(239,68,68,0.2)]"
                  : "bg-slate-800 text-slate-300 border border-slate-700",
          )}
        >
          {stalePrice ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
              <span className="truncate">Connecting / Waiting</span>
            </>
          ) : (
            <>
              <span className="text-sm sm:text-base shrink-0">
                {isCall ? "🟢" : isPut ? "🔴" : "⚪"}
              </span>
              <span>
                {t("signal")}: {direction}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Expiration Timer Grid */}
      <div className="px-3 sm:px-4 pt-3 sm:pt-4 pb-2">
        <div className="flex items-center gap-2 mb-2">
          <Timer className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span className="text-[9px] sm:text-[10px] text-slate-500 uppercase font-bold tracking-wider">
            {t("expiration")}
          </span>
          {/* MASTER MISSION 7.1 — EXPIRY echoes the SELECTED contract duration
              (1|2|3|5m → mm:ss), never the chart timeframe. */}
          <span
            className="ml-auto text-[10px] sm:text-[11px] font-black font-mono tabular-nums text-white bg-blue-600/20 border border-blue-500/40 rounded-md px-1.5 py-0.5"
            data-testid="expiry-readout"
          >
            {isMounted && expiryRemainingS != null
              ? formatCountdown(expiryRemainingS)
              : "--:--"}
          </span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 max-h-[120px] sm:max-h-[104px] overflow-y-auto custom-scrollbar pr-0.5">
          {TIMER_OPTIONS.map((opt) => (
            <button
              key={opt.seconds}
              onClick={() => {
                setExpirationSeconds(opt.seconds);
                setSelectedExpirationSeconds(opt.seconds);
              }}
              disabled={isTradeActive}
              title={`Projection horizon: ${opt.label}`}
              className={cn(
                "py-2 sm:py-1.5 px-1 rounded-lg text-[10px] font-bold font-mono transition-all duration-200 active:scale-95 min-h-[36px] sm:min-h-[32px]",
                expirationSeconds === opt.seconds
                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                  : "bg-obsidian-950/80 text-slate-400 hover:bg-slate-800 hover:text-white border border-slate-700/40",
                isTradeActive && "opacity-50 cursor-not-allowed",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Live Candle-Close Countdown Bar */}
      <div className="mx-3 sm:mx-4 mt-1 mb-1 px-3 sm:px-4 py-2 sm:py-2.5 bg-obsidian-950/60 border border-slate-800 rounded-xl">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[9px] sm:text-[10px] text-slate-400 uppercase font-bold tracking-wider flex items-center gap-1.5 shrink-0">
            <Timer className="w-3 h-3 text-emerald-500" />
            <span className="hidden xs:inline">Candle Close</span>
            <span className="xs:hidden">Close</span>
          </span>
          <span
            className={cn(
              "text-base sm:text-lg font-black font-mono tabular-nums transition-colors",
              mounted && remainingSeconds <= 5 ? "text-rose-400" : "text-white",
            )}
          >
            {
              mounted
                ? formatCountdown(Math.max(0, remainingSeconds))
                : "--:--" /* deterministic SSR premiere */
            }
          </span>
        </div>
        {/* Sweep progress toward the next barrier rollover */}
        <div className="mt-1.5 h-1 w-full rounded-full bg-slate-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-[width] duration-200 ease-linear"
            style={{ width: `${(progressPct * 100).toFixed(1)}%` }}
          />
        </div>
      </div>

      {/* Active Countdown */}
      {isTradeActive && (
        <div className="mx-3 sm:mx-4 mt-2 mb-1 px-3 sm:px-4 py-2.5 sm:py-3 bg-blue-600/10 border border-blue-500/30 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-[9px] sm:text-[10px] text-blue-400 uppercase font-bold tracking-wider flex items-center gap-1.5 shrink-0">
              <Clock className="w-3 h-3" />
              {t("remaining")}
            </span>
            <span className="text-xl sm:text-2xl font-black font-mono text-white tabular-nums">
              {formatCountdown(countdownSeconds)}
            </span>
          </div>
        </div>
      )}

      {/* Stream Disconnected Banner — socket down or no price data yet */}
      {feedStatus === "awaiting_ssid" || feedStatus === "auth_failed" ? (
        <div className="mx-3 sm:mx-4 mt-2 sm:mt-3 px-3 sm:px-4 py-2 sm:py-2.5 bg-rose-500/10 border border-rose-500/30 rounded-xl">
          <p className="text-[9px] sm:text-[10px] text-rose-400 font-black uppercase tracking-wider">
            {feedStatus === "auth_failed"
              ? "FEED OFFLINE — auth failed"
              : "FEED OFFLINE — awaiting SSID"}
          </p>
        </div>
      ) : (
        (!socketConnected || currentPrice <= 0) && (
          <div className="mx-3 sm:mx-4 mt-2 sm:mt-3 px-3 sm:px-4 py-2 sm:py-2.5 bg-rose-500/10 border border-rose-500/30 rounded-xl">
            <p className="text-[9px] sm:text-[10px] text-rose-400 font-black uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse shrink-0" />
              Live Data Disconnected
            </p>
            <p className="text-[9px] sm:text-[10px] text-rose-400/80 font-mono mt-1">
              Trade execution disabled until the real-time feed restores.
            </p>
          </div>
        )
      )}

      {/* Stale Price — Waiting for Real-time Tick (2-second rule) */}
      {(feedStatus === "stalled" ||
        feedStatus === "degraded" ||
        (socketConnected && currentPrice > 0 && stalePrice)) && (
        <div className="mx-3 sm:mx-4 mt-2 sm:mt-3 px-3 sm:px-4 py-2 sm:py-2.5 bg-amber-500/10 border border-amber-500/40 rounded-xl">
          <p className="text-[9px] sm:text-[10px] text-amber-400 font-black uppercase tracking-wider flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
            Connecting / Waiting for Real-time Tick
          </p>
          <p className="text-[9px] sm:text-[10px] text-amber-400/90 font-mono mt-1">
            {formatPairPrice(currentPrice)} (
            {lastPriceUpdateShort(lastPriceUpdate)}) — no live quote for &gt;2s.
            Signal generation is paused; analysis resumes on the next real-time
            tick.
          </p>
        </div>
      )}

      {/* Kill Switch Status */}
      <div
        className={cn(
          "mx-3 sm:mx-4 mt-2 sm:mt-3 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl border flex flex-col gap-2 transition-colors",
          isKillSwitchLocked
            ? "bg-rose-500/10 border-rose-500/40"
            : "bg-obsidian-950/50 border border-slate-800",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {isKillSwitchLocked ? (
              <ShieldAlert className="w-4 h-4 text-rose-500 shrink-0 animate-pulse" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            )}
            <span
              className={cn(
                "text-[9px] sm:text-[10px] font-black uppercase tracking-widest truncate",
                isKillSwitchLocked ? "text-rose-400" : "text-slate-300",
              )}
            >
              {isKillSwitchLocked ? t("emergencyStop") : t("riskGuardActive")}
            </span>
          </div>

          {isKillSwitchLocked ? (
            unlockArmed ? (
              <div className="shrink-0 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    void resetKillSwitch();
                    setUnlockArmed(false);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[9px] sm:text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 min-h-[36px]"
                >
                  <Unlock className="w-3 h-3" />
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setUnlockArmed(false)}
                  className="inline-flex items-center px-2 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider hover:bg-slate-800 transition-colors min-h-[36px]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setUnlockArmed(true)}
                title="Reset kill switch — re-arm live order execution"
                className="shrink-0 inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg border border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 min-h-[36px]"
              >
                <Unlock className="w-3 h-3" />
                {t("unlockTrading")}
              </button>
            )
          ) : riskState ? (
            <span className="shrink-0 text-[9px] sm:text-[10px] font-mono text-slate-400 tabular-nums">
              DD {riskState.drawdownPct.toFixed(2)}% /{" "}
              {riskState.maxDailyDrawdownPct}%
            </span>
          ) : null}
        </div>
        {isKillSwitchLocked && killSwitchReason && (
          <p className="text-[9px] sm:text-[10px] text-rose-400 font-mono leading-relaxed">
            {killSwitchReason}
          </p>
        )}
      </div>

      {/* Action Buttons — enabled ONLY when the 96.5% signal gate has passed */}
      <div className="px-3 sm:px-4 pt-3 sm:pt-4 pb-2 sm:pb-3 flex flex-col gap-2 sm:gap-2.5">
        {/* HIGHER / BUY */}
        <button
          onClick={handleCall}
          disabled={signalLocked || isTradeActive || !streamLive || isKillSwitchLocked}
          className={cn(
            "w-full py-3 sm:py-4 px-4 sm:px-6 rounded-xl font-black text-sm sm:text-base uppercase tracking-wider",
            "flex items-center justify-center gap-2 sm:gap-3",
            "transition-all duration-200 active:scale-[0.98]",
            "shadow-xl shadow-emerald-500/25",
            "min-h-[48px] sm:min-h-[52px]",
            signalLocked || isTradeActive || !streamLive || isKillSwitchLocked
              ? "opacity-50 cursor-not-allowed"
              : "hover:brightness-110 hover:shadow-emerald-500/40",
            isCall &&
              !signalLocked &&
              !isTradeActive &&
              streamLive &&
              !isKillSwitchLocked
              ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-obsidian"
              : "",
            "bg-emerald-500 hover:bg-emerald-400 text-white",
          )}
        >
          <TrendingUp className="w-5 h-5 sm:w-6 sm:h-6" />
          <span className="text-sm sm:text-lg font-black">{t("higherBuy")}</span>
        </button>

        {/* LOWER / SELL */}
        <button
          onClick={handlePut}
          disabled={signalLocked || isTradeActive || !streamLive || isKillSwitchLocked}
          className={cn(
            "w-full py-3 sm:py-4 px-4 sm:px-6 rounded-xl font-black text-sm sm:text-base uppercase tracking-wider",
            "flex items-center justify-center gap-2 sm:gap-3",
            "transition-all duration-200 active:scale-[0.98]",
            "shadow-xl shadow-rose-500/25",
            "min-h-[48px] sm:min-h-[52px]",
            signalLocked || isTradeActive || !streamLive || isKillSwitchLocked
              ? "opacity-50 cursor-not-allowed"
              : "hover:brightness-110 hover:shadow-rose-500/40",
            isPut && !signalLocked && !isTradeActive && streamLive && !isKillSwitchLocked
              ? "ring-2 ring-rose-500 ring-offset-2 ring-offset-obsidian"
              : "",
            "bg-rose-500 hover:bg-rose-400 text-white",
          )}
        >
          <TrendingDown className="w-5 h-5 sm:w-6 sm:h-6" />
          <span className="text-sm sm:text-lg font-black">{t("lowerSell")}</span>
        </button>
      </div>

      {/* Trade Result Banner */}
      {lastTradeResult && (
        <div className="mx-3 sm:mx-4 mb-3 sm:mb-4 px-3 sm:px-4 py-2.5 sm:py-3 bg-slate-800/80 border border-slate-700/60 rounded-xl animate-slide-up">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "w-2 h-2 rounded-full shrink-0",
                lastTradeResult.includes("❌")
                  ? "bg-rose-500"
                  : "bg-emerald-500",
              )}
            />
            <span className="text-[10px] sm:text-xs font-mono text-white font-bold">
              {lastTradeResult}
            </span>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto px-3 sm:px-4 py-2.5 sm:py-3 border-t border-slate-800/60 bg-obsidian-950/40 safe-area-bottom">
        <div className="flex items-center justify-between">
          <span className="text-[9px] sm:text-[10px] text-slate-500 uppercase font-bold tracking-wider flex items-center gap-1.5 min-w-0">
            <span className="truncate">{getPairLabel(activeSymbol)}</span>
            <AssetClassBadge symbol={activeSymbol} variant="compact" />
          </span>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] sm:text-xs font-mono text-white font-bold tabular-nums">
              {currentPrice > 0
                ? `$${formatPairPrice(currentPrice, activeSymbol)}`
                : "---"}
            </span>
            <span
              className={cn(
                "text-[8px] sm:text-[9px] px-1.5 sm:px-2 py-0.5 rounded-full font-bold uppercase shrink-0",
                isCall
                  ? "bg-emerald-500/20 text-emerald-400"
                  : isPut
                    ? "bg-rose-500/20 text-rose-400"
                    : "bg-slate-800 text-slate-300",
              )}
            >
              {isCall ? "BUY" : isPut ? "SELL" : t("awaitingPrediction")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TradingPanel;
