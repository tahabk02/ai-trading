"use client";

import React, { useEffect, useState, useCallback } from "react";
import apiClient from "@/services/api";
import { useTradingStore, startRiskPolling, stopRiskPolling } from "@/store/useTradingStore";
import { useLangContext } from "@/hooks/useLangContext";
import {
  RotateCcw,
  Lock,
  ShieldAlert,
  TrendingDown,
  Percent,
  Gauge,
  ShieldCheck,
} from "lucide-react";
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
        return <TrendingDown className="w-5 h-5 text-danger" />;
      case "stop_loss":
        return <ShieldAlert className="w-5 h-5 text-warning" />;
      case "position_size":
        return <Percent className="w-5 h-5 text-primary" />;
      case "max_leverage":
        return <Gauge className="w-5 h-5 text-success" />;
      default:
        return <ShieldCheck className="w-5 h-5 text-ink-muted" />;
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
      className="flex h-screen w-full overflow-hidden bg-app text-ink-muted font-sans transition-colors duration-200"
      dir={rtl ? "rtl" : "ltr"}
    >

      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        <Header />

        <main className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-3 sm:p-4 md:p-6 lg:p-8">
          <div className="max-w-7xl mx-auto w-full space-y-6">
            <header className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl sm:text-3xl font-black tracking-wider uppercase text-ink">
                  <span className="text-warning">{t("riskRules")}</span>
                </h1>
                <p className="text-ink-muted mt-1 text-xs sm:text-sm max-w-2xl">
                  {t("riskRulesSubtitle")}
                </p>
              </div>

              <div className="flex items-center gap-2 rounded-control border border-line bg-surface px-4 py-2.5 shadow-sm">
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-warning shadow-[0_0_12px_rgba(245,158,11,0.7)]" />
                <span className="text-xs text-ink-muted font-bold tracking-wider uppercase">
                  {t("engineEnforced")}
                </span>
              </div>
            </header>

            {/* ═══ LIVE KILL-SWITCH / DRAWDOWN PANEL ═══ */}
            {riskState && (
              <section
                className={`tp-card p-5 transition-colors duration-200 ${
                  isKillSwitchLocked
                    ? "border-danger/40 bg-danger/5"
                    : ""
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <h2 className="text-base sm:text-lg font-bold text-ink uppercase tracking-wider">
                    {t("killSwitchMonitor")}
                  </h2>
                  {isKillSwitchLocked ? (
                    <button
                      type="button"
                      onClick={() => void resetKillSwitch()}
                      className="tp-btn tp-btn-success"
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
                      className="tp-btn tp-btn-danger"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      {t("emergencyLock")}
                    </button>
                  )}
                </div>

                {/* Drawdown Limit Slider */}
                <div className="space-y-3 mb-5 p-4 rounded-control bg-well border border-line">
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-xs uppercase tracking-wider text-ink-muted font-bold">
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
                        className="tp-input w-20 py-1.5 text-right font-mono font-bold"
                      />
                      <span className="text-xs text-ink-muted font-bold">%</span>
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
                    className="w-full cursor-pointer accent-warning"
                  />
                  {ddDirty && (
                    <button
                      type="button"
                      onClick={() =>
                        void applyDrawdownLimit(ddLimitDraft ?? riskState.maxDailyDrawdownPct)
                      }
                      disabled={ddAdjusting}
                      className="tp-btn tp-btn-warning"
                    >
                      {ddAdjusting ? t("applying") : t("applyToEngine")}
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                  <div className="rounded-control bg-well border border-line p-3.5">
                    <p className="text-[10px] uppercase tracking-wider text-ink-faint font-bold mb-1">
                      {t("drawdownToday")}
                    </p>
                    <p
                      className={`text-xl font-black font-mono ${
                        riskState.drawdownPct >= riskState.maxDailyDrawdownPct * 0.7
                          ? "text-danger"
                          : "text-success"
                      }`}
                    >
                      {riskState.drawdownPct.toFixed(2)}%
                    </p>
                  </div>
                  <div className="rounded-control bg-well border border-line p-3.5">
                    <p className="text-[10px] uppercase tracking-wider text-ink-faint font-bold mb-1">
                      {t("maxLimit")}
                    </p>
                    <p className="text-xl font-black num-fig text-warning">
                      {riskState.maxDailyDrawdownPct.toFixed(2)}%
                    </p>
                  </div>
                  <div className="rounded-control bg-well border border-line p-3.5">
                    <p className="text-[10px] uppercase tracking-wider text-ink-faint font-bold mb-1">
                      {t("equity")}
                    </p>
                    <p className="text-xl font-black num-fig text-ink">
                      ${formatNumber(riskState.equity, 2)}
                    </p>
                  </div>
                  <div className="rounded-control bg-well border border-line p-3.5">
                    <p className="text-[10px] uppercase tracking-wider text-ink-faint font-bold mb-1">
                      {t("tradesWinLoss")}
                    </p>
                    <p className="text-xl font-black num-fig text-ink">
                      {riskState.tradesToday} ·{" "}
                      <span className="text-success">{riskState.winsToday}</span>/
                      <span className="text-danger">{riskState.lossesToday}</span>
                    </p>
                  </div>
                </div>

                <div className="h-2 w-full bg-elevated rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isKillSwitchLocked
                        ? "bg-danger"
                        : riskState.drawdownPct >= riskState.maxDailyDrawdownPct * 0.7
                          ? "bg-warning"
                          : "bg-success"
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
                      <span className="text-[10px] uppercase tracking-wider text-ink-faint font-bold">
                        {t("dailyExposure")}
                      </span>
                      <span className="text-[10px] font-mono font-bold text-ink-muted tabular-nums">
                        {exposurePct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-2 w-full bg-elevated rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-success via-primary to-brand-hover transition-all duration-500"
                        style={{ width: `${exposurePct}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-[10px] text-ink-faint font-mono">
                      {t("realizedPnl")}: ${riskState.realizedPnl.toFixed(2)} vs {t("equity")}{" "}
                      ${riskState.equity.toFixed(2)}
                    </p>
                  </div>
                )}

                {isKillSwitchLocked && (
                  <p className="mt-3 text-xs text-danger font-mono font-bold">
                    ⛔ {t("killSwitchEngaged")} —{" "}
                    {riskState.lockedReason ?? "Daily drawdown limit breached."}
                  </p>
                )}
              </section>
            )}

            {error && (
              <div className="tp-banner tp-banner-error">
                <p className="text-xs font-mono">{error}</p>
              </div>
            )}

            {successMsg && (
              <div className="tp-banner tp-banner-success">
                <p className="text-xs font-mono font-bold">{successMsg}</p>
              </div>
            )}

            {/* Rules Cards Grid */}
            {isLoading ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="tp-skeleton p-6"
                  >
                    <div className="h-5 w-1/3 bg-elevated rounded mb-4" />
                    <div className="h-10 bg-elevated rounded" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="tp-card overflow-hidden"
                  >
                    <div className="px-6 py-5 border-b border-line flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 items-center justify-center rounded-control bg-elevated border border-line">
                          {getRuleIcon(rule.ruleType)}
                        </span>
                        <div>
                          <h2 className="text-base font-bold text-ink">
                            {rule.name}
                          </h2>
                          <p className="text-xs text-ink-faint font-mono mt-0.5">
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
                        <div className="w-11 h-6 bg-elevated border border-line peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-warning peer-checked:border-warning rtl:peer-checked:after:-translate-x-full" />
                      </label>
                    </div>

                    <div className="p-6 space-y-4">
                      <div className="flex items-center gap-4">
                        <div className="flex-1">
                          <label className="block text-xs uppercase tracking-wider text-ink-faint font-bold mb-2">
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
                              className="tp-input w-full pr-16 font-mono"
                            />
                            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-ink-faint font-mono">
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
                              className="w-full cursor-pointer accent-warning"
                            />
                            <div className="flex items-center justify-between text-[10px] text-ink-faint font-mono mt-1">
                              <span>0</span>
                              <span>1000</span>
                            </div>
                          </div>
                        </div>

                        <div className="text-center min-w-[80px]">
                          <p className="text-xs text-ink-faint uppercase tracking-wider font-bold mb-1">
                            {t("status")}
                          </p>
                          <span
                            className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                              rule.enabled
                                ? "tp-badge-success"
                                : "tp-badge-neutral"
                            }`}
                          >
                            {rule.enabled ? t("active").toUpperCase() : t("disabled")}
                          </span>
                        </div>
                      </div>

                      <div className="rounded-control bg-well border border-line p-3">
                        <div className="flex items-center gap-2">
                          <div
                            className={`h-2 w-2 rounded-full ${
                              rule.enabled
                                ? "bg-warning shadow-[0_0_10px_rgba(245,158,11,0.6)]"
                                : "bg-ink-faint"
                            }`}
                          />
                          <p className="text-xs text-ink-muted">
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
                className="tp-btn tp-btn-warning"
              >
                {isSaving ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-current animate-pulse" />
                    {t("savingToEngine")}
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-current" />
                    {t("applyAllRules")}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={isSaving}
                className="tp-btn tp-btn-secondary"
              >
                {t("resetDefaults")}
              </button>
            </div>

            {/* Enforcement Status Footer Banner */}
            <div className="tp-card p-4">
              <div className="flex items-start gap-3">
                <div className="mt-1 h-2.5 w-2.5 rounded-full bg-success shadow-[0_0_12px_rgba(16,185,129,0.7)] shrink-0" />
                <div>
                  <p className="text-sm text-ink font-bold">
                    {t("liveEnforcementActive")}
                  </p>
                  <p className="text-xs text-ink-muted mt-1">
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

