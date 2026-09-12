"use client";

import React, { useEffect, useState, useCallback } from "react";
import apiClient from "@/services/api";
import { useTradingStore, startRiskPolling, stopRiskPolling } from "@/store/useTradingStore";
import { useLangContext } from "@/hooks/useLangContext";
import { RotateCcw, Lock } from "lucide-react";
import { Header } from "@/components/shared/header";
import { formatNumber } from "@/utils/format";

interface RiskRule {
  id: string;
  name: string;
  ruleType: string;
  value: number;
  enabled: boolean;
}

export default function RiskRulesPage() {
  const { t, rtl } = useLangContext();
  const [rules, setRules] = useState<RiskRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const riskState = useTradingStore((s) => s.riskState);
  const isKillSwitchLocked = useTradingStore((s) => s.isKillSwitchLocked);
  const refreshRiskState = useTradingStore((s) => s.refreshRiskState);
  const resetKillSwitch = useTradingStore((s) => s.resetKillSwitch);
  const engageKillSwitch = useTradingStore((s) => s.engageKillSwitch);

  const [ddLimitDraft, setDdLimitDraft] = useState<number | null>(null);
  const [ddAdjusting, setDdAdjusting] = useState(false);
  const ddDirty = ddLimitDraft !== null && riskState
    ? Math.abs(ddLimitDraft - riskState.maxDailyDrawdownPct) > 0.01
    : false;

  const applyDrawdownLimit = async (value: number) => {
    setDdAdjusting(true);
    setDdLimitDraft(value);
    try {
      await apiClient.setMaxDrawdown(value);
      setSuccessMsg(t("drawdownLimitUpdated"));
      setTimeout(() => setSuccessMsg(null), 4000);
      await refreshRiskState();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to update drawdown limit";
      setError(msg);
    } finally {
      setDdAdjusting(false);
      setDdLimitDraft(null);
    }
  };

  const exposurePct = riskState
    ? Math.min(
        100,
        Math.max(0, ((riskState.realizedPnl || 0) / (riskState.equity || 1)) * 100),
      )
    : 0;

  useEffect(() => {
    // Participate in the SHARED risk snapshot poller (single 30s loop).
    startRiskPolling(refreshRiskState);
    return () => stopRiskPolling();
  }, [refreshRiskState]);

  const loadRules = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient.getRiskRules();
      setRules(data.rules);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to load risk rules";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const updateLocalRule = (
    id: string,
    field: "value" | "enabled",
    val: number | boolean,
  ) => {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: val } : r)),
    );
  };

  const handleSaveAll = async () => {
    setIsSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      for (const rule of rules) {
        await apiClient.updateRiskRule(rule.id, {
          value: rule.value,
          enabled: rule.enabled,
        });
      }
      const data = await apiClient.getRiskRules();
      setRules(data.rules);
      setSuccessMsg(t("rulesSaved"));
      setTimeout(() => setSuccessMsg(null), 5000);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to save risk rules";
      setError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setIsSaving(true);
    setError(null);
    try {
      for (const rule of rules) {
        await apiClient.deleteRiskRule(rule.id);
      }
      const data = await apiClient.getRiskRules();
      setRules(data.rules);
      setSuccessMsg(t("rulesReset"));
      setTimeout(() => setSuccessMsg(null), 5000);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to reset risk rules";
      setError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const getRuleIcon = (type: string) => {
    switch (type) {
      case "max_drawdown":
        return "📉";
      case "stop_loss":
        return "🛑";
      case "position_size":
        return "📐";
      case "max_leverage":
        return "⚡";
      default:
        return "🔒";
    }
  };

  const getRuleUnit = (type: string) => {
    switch (type) {
      case "max_drawdown":
        return "%";
      case "stop_loss":
        return "%";
      case "position_size":
        return "% of account";
      case "max_leverage":
        return "x";
      default:
        return "";
    }
  };

  return (
    <div
      className="flex h-screen w-full overflow-hidden bg-obsidian text-slate-200 font-sans transition-colors duration-200"
      dir={rtl ? "rtl" : "ltr"}
    >

      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        <Header />

        <main className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-3 sm:p-4 md:p-6 lg:p-8">
          <div className="max-w-7xl mx-auto w-full space-y-6">
            <header className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl sm:text-3xl font-black tracking-wider uppercase">
                  <span className="text-amber-500">{t("riskRules")}</span>
                </h1>
                <p className="text-slate-600 dark:text-slate-400 mt-1 text-xs sm:text-sm max-w-2xl">
                  {t("riskRulesSubtitle")}
                </p>
              </div>

              <div className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 px-4 py-2.5 shadow-sm">
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.7)]" />
                <span className="text-xs text-slate-700 dark:text-slate-300 font-bold tracking-wider uppercase">
                  {t("engineEnforced")}
                </span>
              </div>
            </header>

            {/* ═══ LIVE KILL-SWITCH / DRAWDOWN PANEL ═══ */}
            {riskState && (
              <section
                className={`rounded-xl border p-5 shadow-sm transition-colors duration-200 ${
                  isKillSwitchLocked
                    ? "bg-rose-500/10 border-rose-500/40"
                    : "bg-white dark:bg-slate-900/80 border-slate-200 dark:border-slate-800"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                    {t("killSwitchMonitor")}
                  </h2>
                  {isKillSwitchLocked ? (
                    <button
                      type="button"
                      onClick={() => void resetKillSwitch()}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold uppercase tracking-wider transition-all active:scale-[0.98] shadow-sm"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      {t("unlockTrading")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        void engageKillSwitch("Operator emergency stop (risk page)")
                      }
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-rose-500/50 bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 text-xs font-bold uppercase tracking-wider transition-all active:scale-[0.98]"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      {t("emergencyLock")}
                    </button>
                  )}
                </div>

                {/* Drawdown Limit Slider */}
                <div className="space-y-3 mb-5 p-4 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                      {t("dailyMaxDrawdownLimit")}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0.1}
                        max={50}
                        step={0.1}
                        value={ddLimitDraft ?? riskState.maxDailyDrawdownPct}
                        onChange={(e) =>
                          setDdLimitDraft(
                            Math.max(0.1, parseFloat(e.target.value) || 0.1),
                          )
                        }
                        disabled={ddAdjusting}
                        className="w-20 text-right text-sm font-mono text-slate-900 dark:text-white bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 focus:outline-none focus:border-amber-500 font-bold"
                      />
                      <span className="text-xs text-slate-500 font-bold">%</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={50}
                    step={0.1}
                    value={ddLimitDraft ?? riskState.maxDailyDrawdownPct}
                    onChange={(e) => setDdLimitDraft(parseFloat(e.target.value))}
                    aria-label={t("dailyMaxDrawdownLimit")}
                    className="w-full cursor-pointer accent-amber-500"
                  />
                  {ddDirty && (
                    <button
                      type="button"
                      onClick={() =>
                        void applyDrawdownLimit(ddLimitDraft ?? riskState.maxDailyDrawdownPct)
                      }
                      disabled={ddAdjusting}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 text-slate-950 hover:bg-amber-400 text-xs font-bold uppercase tracking-wider transition-all active:scale-[0.98] shadow-sm disabled:opacity-60"
                    >
                      {ddAdjusting ? t("applying") : t("applyToEngine")}
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 p-3.5">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                      {t("drawdownToday")}
                    </p>
                    <p
                      className={`text-xl font-black font-mono ${
                        riskState.drawdownPct >= riskState.maxDailyDrawdownPct * 0.7
                          ? "text-rose-500 dark:text-rose-400"
                          : "text-emerald-500 dark:text-emerald-400"
                      }`}
                    >
                      {riskState.drawdownPct.toFixed(2)}%
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 p-3.5">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                      {t("maxLimit")}
                    </p>
                    <p className="text-xl font-black font-mono text-amber-500">
                      {riskState.maxDailyDrawdownPct.toFixed(2)}%
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 p-3.5">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                      {t("equity")}
                    </p>
                    <p className="text-xl font-black font-mono text-slate-900 dark:text-white">
                      ${formatNumber(riskState.equity, 2)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 p-3.5">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                      {t("tradesWinLoss")}
                    </p>
                    <p className="text-xl font-black font-mono text-slate-900 dark:text-white">
                      {riskState.tradesToday} ·{" "}
                      <span className="text-emerald-500 dark:text-emerald-400">{riskState.winsToday}</span>/
                      <span className="text-rose-500 dark:text-rose-400">{riskState.lossesToday}</span>
                    </p>
                  </div>
                </div>

                <div className="h-2 w-full bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isKillSwitchLocked
                        ? "bg-rose-500"
                        : riskState.drawdownPct >= riskState.maxDailyDrawdownPct * 0.7
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                    }`}
                    style={{
                      width: `${Math.min(
                        100,
                        (riskState.drawdownPct / riskState.maxDailyDrawdownPct) * 100,
                      )}%`,
                    }}
                  />
                </div>

                {/* Daily Exposure Gauge */}
                {!isKillSwitchLocked && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                        {t("dailyExposure")}
                      </span>
                      <span className="text-[10px] font-mono font-bold text-slate-700 dark:text-slate-300 tabular-nums">
                        {exposurePct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-2 w-full bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-blue-500 to-indigo-500 transition-all duration-500"
                        style={{ width: `${exposurePct}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-500 font-mono">
                      {t("realizedPnl")}: ${riskState.realizedPnl.toFixed(2)} vs {t("equity")}{" "}
                      ${riskState.equity.toFixed(2)}
                    </p>
                  </div>
                )}

                {isKillSwitchLocked && (
                  <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 font-mono font-bold">
                    ⛔ {t("killSwitchEngaged")} —{" "}
                    {riskState.lockedReason ?? "Daily drawdown limit breached."}
                  </p>
                )}
              </section>
            )}

            {error && (
              <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl">
                <p className="text-xs text-rose-600 dark:text-rose-400 font-mono">{error}</p>
              </div>
            )}

            {successMsg && (
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl">
                <p className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-bold">{successMsg}</p>
              </div>
            )}

            {/* Rules Cards Grid */}
            {isLoading ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="bg-white dark:bg-slate-900/80 rounded-xl border border-slate-200 dark:border-slate-800 p-6 animate-pulse"
                  >
                    <div className="h-5 w-1/3 bg-slate-200 dark:bg-slate-700 rounded mb-4" />
                    <div className="h-10 bg-slate-100 dark:bg-slate-800 rounded" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="bg-white dark:bg-slate-900/80 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden"
                  >
                    <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">
                          {getRuleIcon(rule.ruleType)}
                        </span>
                        <div>
                          <h2 className="text-base font-bold text-slate-900 dark:text-white">
                            {rule.name}
                          </h2>
                          <p className="text-xs text-slate-500 font-mono mt-0.5">
                            {rule.ruleType.replace(/_/g, " ")}
                          </p>
                        </div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={(e) =>
                            updateLocalRule(rule.id, "enabled", e.target.checked)
                          }
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-slate-300 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500 rtl:peer-checked:after:-translate-x-full" />
                      </label>
                    </div>

                    <div className="p-6 space-y-4">
                      <div className="flex items-center gap-4">
                        <div className="flex-1">
                          <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-2">
                            {t("thresholdValue")}
                          </label>
                          <div className="relative">
                            <input
                              type="number"
                              min={0}
                              max={1000}
                              step={0.1}
                              value={rule.value}
                              onChange={(e) =>
                                updateLocalRule(
                                  rule.id,
                                  "value",
                                  parseFloat(e.target.value) || 0,
                                )
                              }
                              disabled={!rule.enabled}
                              className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3 text-slate-900 dark:text-slate-100 text-sm font-mono focus:outline-none focus:border-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-mono">
                              {getRuleUnit(rule.ruleType)}
                            </span>
                          </div>

                          <div className="mt-3">
                            <input
                              type="range"
                              min={0}
                              max={1000}
                              step={0.1}
                              value={rule.value}
                              onChange={(e) =>
                                updateLocalRule(
                                  rule.id,
                                  "value",
                                  parseFloat(e.target.value) || 0,
                                )
                              }
                              disabled={!rule.enabled}
                              className="w-full cursor-pointer accent-amber-500"
                            />
                            <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono mt-1">
                              <span>0</span>
                              <span>1000</span>
                            </div>
                          </div>
                        </div>

                        <div className="text-center min-w-[80px]">
                          <p className="text-xs text-slate-500 uppercase tracking-wider font-bold mb-1">
                            {t("status")}
                          </p>
                          <span
                            className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                              rule.enabled
                                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                : "bg-slate-200 dark:bg-slate-800 text-slate-500"
                            }`}
                          >
                            {rule.enabled ? t("active").toUpperCase() : t("disabled")}
                          </span>
                        </div>
                      </div>

                      <div className="rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 p-3">
                        <div className="flex items-center gap-2">
                          <div
                            className={`h-2 w-2 rounded-full ${
                              rule.enabled
                                ? "bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.6)]"
                                : "bg-slate-400 dark:bg-slate-600"
                            }`}
                          />
                          <p className="text-xs text-slate-600 dark:text-slate-400">
                            {rule.enabled ? t("enforcedByEngine") : t("notEnforced")}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleSaveAll}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-xl px-5 py-3 border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 text-sm font-bold uppercase tracking-wider transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                {isSaving ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                    {t("savingToEngine")}
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.8)]" />
                    {t("applyAllRules")}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-xl px-5 py-3 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-bold uppercase tracking-wider transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                {t("resetDefaults")}
              </button>
            </div>

            {/* Enforcement Status Footer Banner */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="mt-1 h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.7)] shrink-0" />
                <div>
                  <p className="text-sm text-slate-900 dark:text-white font-bold">
                    {t("liveEnforcementActive")}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {t("liveEnforcementHint")}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

