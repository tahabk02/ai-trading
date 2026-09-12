"use client";

/**
 * kill-switch-banner.tsx — ADVANCED RISK MANAGEMENT UI (ALPHA 5 PRO)
 *
 * Renders a persistent banner when the automated kill switch is engaged:
 *  • Shows live daily drawdown vs. the configured max (default 3%).
 *  • Displays equity curve stats (P&L, trades, wins/losses today).
 *  • Provides the manual RESET control to unlock trading.
 *
 * The banner polls the backend risk snapshot on mount and after every
 * trade attempt, so the lock state is always authoritative.
 */

import { useEffect, useState } from "react";
import {
  ShieldAlert,
  ShieldCheck,
  RotateCcw,
  TrendingDown,
  Lock,
} from "lucide-react";
import { useTradingStore, startRiskPolling, stopRiskPolling } from "@/store/useTradingStore";
import { useLangContext } from "@/hooks/useLangContext";
import { cn } from "@/utils/cn";
import { formatPairPrice } from "@/utils/format";

export const KillSwitchBanner: React.FC = () => {
  const riskState = useTradingStore((s) => s.riskState);
  const isKillSwitchLocked = useTradingStore((s) => s.isKillSwitchLocked);
  const killSwitchReason = useTradingStore((s) => s.killSwitchReason);
  const refreshRiskState = useTradingStore((s) => s.refreshRiskState);
  const resetKillSwitch = useTradingStore((s) => s.resetKillSwitch);
  const engageKillSwitch = useTradingStore((s) => s.engageKillSwitch);
  const [confirmLock, setConfirmLock] = useState(false);
  const { t } = useLangContext();

  // Participate in the SHARED risk snapshot poller (one 30s loop total,
  // not one per mounted component). Multiple components mount simultaneously,
  // but only ONE setInterval runs due to the ref-counted store poller.
  useEffect(() => {
    startRiskPolling(refreshRiskState);
    return () => stopRiskPolling();
  }, [refreshRiskState]);

  // ── HYDRATION-SAFE MOUNT GUARD ──
  // This banner renders interactive <button> controls once the risk snapshot
  // is in the module-level store. Under client-side navigation or HMR
  // re-mounts the store can already hold riskState while the server rendered
  // `null` → React Hydration Mismatch: "Expected server HTML to contain a
  // matching <button> in <div>". Suppressing all markup until the client
  // mounts keeps SSR and the first client paint byte-identical.
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);
  if (!isMounted) return null;

  if (!riskState) return null;

  const drawdown = riskState.drawdownPct;
  const limit = riskState.maxDailyDrawdownPct;
  const usagePct = Math.min(100, (drawdown / limit) * 100);
  const nearLimit = drawdown >= limit * 0.7;

  return (
    <div
      className={cn(
        "mx-2 lg:mx-3 mt-2 rounded-xl border px-4 py-3 flex flex-col gap-2 transition-colors",
        isKillSwitchLocked
          ? "bg-rose-950/60 border-rose-600/50"
          : nearLimit
            ? "bg-amber-950/40 border-amber-600/40"
            : "bg-slate-900/60 border-slate-700/50",
      )}
      role="status"
      aria-live="polite"
    >
      {/* ── Header row: status + reset ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {isKillSwitchLocked ? (
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 animate-pulse" />
          ) : (
            <ShieldCheck
              className={cn(
                "w-4 h-4 shrink-0",
                nearLimit ? "text-amber-400" : "text-emerald-400",
              )}
            />
          )}
          <span
            className={cn(
              "text-[11px] font-black uppercase tracking-widest truncate",
              isKillSwitchLocked
                ? "text-rose-300"
                : nearLimit
                  ? "text-amber-300"
                  : "text-slate-300",
            )}
          >
            {isKillSwitchLocked
              ? t("killSwitchEngaged")
              : `${t("riskGuardActive")} — ${drawdown.toFixed(2)}% / ${limit}% DD`}
          </span>
        </div>

        {/* ── EMERGENCY LOCK / UNLOCK CONTROLS ── */}
        {isKillSwitchLocked ? (
          <button
            type="button"
            onClick={() => void resetKillSwitch()}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-bold uppercase tracking-wider transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            {t("reset")}
          </button>
        ) : confirmLock ? (
          <div className="shrink-0 flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                void engageKillSwitch("Operator emergency stop");
                setConfirmLock(false);
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-bold uppercase tracking-wider transition-colors"
            >
              <Lock className="w-3 h-3" />
              Confirm Lock
            </button>
            <button
              type="button"
              onClick={() => setConfirmLock(false)}
              className="inline-flex items-center px-2 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-[10px] font-bold uppercase tracking-wider hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmLock(true)}
            title="Emergency stop — instantly locks ALL live trading"
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-700/60 text-rose-400 hover:bg-rose-950/60 text-[10px] font-bold uppercase tracking-wider transition-colors"
          >
            <Lock className="w-3 h-3" />
            Emergency Stop
          </button>
        )}
      </div>

      {/* ── Drawdown progress bar ── */}
      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            isKillSwitchLocked
              ? "bg-rose-500"
              : nearLimit
                ? "bg-amber-500"
                : "bg-emerald-500",
          )}
          style={{ width: `${usagePct}%` }}
        />
      </div>

      {/* ── Equity stats row ── */}
      <div className="flex items-center justify-between gap-4 text-[10px] font-mono">
        <span className="flex items-center gap-1 text-slate-400">
          <TrendingDown className="w-3 h-3" />
          DD {drawdown.toFixed(2)}% / {limit}%
        </span>
        <span className="text-slate-400">
          P&L{" "}
          <span
            className={
              riskState.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"
            }
          >
            {riskState.realizedPnl >= 0 ? "+" : ""}
            {formatPairPrice(riskState.realizedPnl, "USD/USD")}
          </span>
        </span>
        <span className="text-slate-500 hidden sm:inline">
          {t("tradesLabel")} {riskState.tradesToday} · W{riskState.winsToday}/L
          {riskState.lossesToday}
        </span>
      </div>

      {/* ── Lock reason ── */}
      {isKillSwitchLocked && killSwitchReason && (
        <p className="text-[10px] text-rose-300/90 font-mono leading-relaxed">
          {killSwitchReason}
        </p>
      )}
    </div>
  );
};

export default KillSwitchBanner;
