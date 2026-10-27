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
  const hasDrawdown = typeof drawdown === "number";
  const limit = riskState.maxDailyDrawdownPct;
  const usagePct = hasDrawdown ? Math.min(100, (drawdown / limit) * 100) : 0;
  const nearLimit = hasDrawdown && drawdown >= limit * 0.7;

  return (
    <div
      className={cn(
        "mx-2 lg:mx-3 mt-2 rounded-card border px-4 py-3 flex flex-col gap-2 transition-colors",
        isKillSwitchLocked
          ? "bg-st-neg/10 border-st-neg/40"
          : nearLimit
            ? "bg-st-warn/10 border-st-warn/40"
            : "bg-surface border-line",
      )}
      role="status"
      aria-live="polite"
    >
      {/* ── Header row: status + reset ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {isKillSwitchLocked ? (
            <ShieldAlert className="w-4 h-4 text-st-neg shrink-0 animate-pulse" />
          ) : (
            <ShieldCheck
              className={cn(
                "w-4 h-4 shrink-0",
                nearLimit ? "text-st-warn" : "text-st-pos",
              )}
            />
          )}
          <span
            className={cn(
              "text-[11px] font-black uppercase tracking-widest truncate",
              isKillSwitchLocked
                ? "text-st-neg"
                : nearLimit
                  ? "text-st-warn"
                  : "text-ink-muted",
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
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-st-neg hover:brightness-110 text-white text-[10px] font-bold uppercase tracking-wider transition-colors"
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
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-st-neg hover:brightness-110 text-white text-[10px] font-bold uppercase tracking-wider transition-colors"
            >
              <Lock className="w-3 h-3" />
              Confirm Lock
            </button>
            <button
              type="button"
              onClick={() => setConfirmLock(false)}
              className="inline-flex items-center px-2 py-1.5 rounded-lg border border-slate-600 text-ink-muted text-[10px] font-bold uppercase tracking-wider hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmLock(true)}
            title="Emergency stop — instantly locks ALL live trading"
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-st-neg/50 text-st-neg hover:bg-st-neg/10 text-[10px] font-bold uppercase tracking-wider transition-colors"
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
              ? "bg-st-neg"
              : nearLimit
                ? "bg-st-warn"
                : "bg-st-pos",
          )}
          style={{ width: `${usagePct}%` }}
        />
      </div>

      {/* ── Equity stats row ── */}
      <div className="flex items-center justify-between gap-4 text-[10px] font-mono">
        <span className="flex items-center gap-1 text-ink-muted">
          <TrendingDown className="w-3 h-3" />
          DD {hasDrawdown ? `${drawdown.toFixed(2)}%` : "unavailable"} / {limit}%
        </span>
        <span className="text-ink-muted">
          P&L{" "}
          <span
            className={
              riskState.realizedPnl >= 0 ? "text-st-pos" : "text-st-neg"
            }
          >
            {riskState.realizedPnl >= 0 ? "+" : ""}
            {formatPairPrice(riskState.realizedPnl, "USD/USD")}
          </span>
        </span>
        <span className="text-ink-faint hidden sm:inline">
          {t("tradesLabel")} {riskState.tradesToday} · W{riskState.winsToday}/L
          {riskState.lossesToday}
        </span>
      </div>

      {/* ── Lock reason ── */}
      {isKillSwitchLocked && killSwitchReason && (
        <p className="text-[10px] text-st-neg/90 font-mono leading-relaxed">
          {killSwitchReason}
        </p>
      )}
    </div>
  );
};

export default KillSwitchBanner;
