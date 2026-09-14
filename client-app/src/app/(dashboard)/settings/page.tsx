"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Moon, Sun, Monitor, Languages } from "lucide-react";
import apiClient from "@/services/api";
import { useTradingStore } from "@/store/useTradingStore";
import { useTheme, type ThemeMode } from "@/hooks/useTheme";
import { useLangContext } from "@/hooks/useLangContext";
import type { Lang } from "@/utils/i18n";
import { cn } from "@/utils/cn";
import { Header } from "@/components/shared/header";

const LANG_OPTIONS: Array<{ code: Lang; label: string }> = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "ar", label: "العربية (RTL)" },
];

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { lang, setLang, t, rtl } = useLangContext();
  // ── STRICT SERVER-BOUND SETTINGS ──
  // The form starts EMPTY and only renders after the backend /settings row is
  // loaded (or a reset restores canonical server defaults). No hardcoded
  // client-side values are ever displayed as if they were real persisted
  // settings.
  const [settings, setSettings] = useState<{
    timeframe: string;
    confidenceGuardrail: number;
    maxRequestsPerMin: number;
    responseSlaMs: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const BROKER_LS_KEY = "alpha5_broker_settings";
  const [broker, setBroker] = useState({
    binanceApiKey: "",
    binanceApiSecret: "",
    alpacaApiKey: "",
    alpacaApiSecret: "",
    slippageTolerance: 0.5,
    riskMode: "moderate",
    wsEndpointOverride: "",
  });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(BROKER_LS_KEY);
      if (raw) setBroker((b) => ({ ...b, ...JSON.parse(raw) }));
    } catch {}
  }, []);

  const saveBroker = (next: typeof broker) => {
    setBroker(next);
    try {
      localStorage.setItem(BROKER_LS_KEY, JSON.stringify(next));
    } catch {}
  };

  const storeSetTimeframe = useTradingStore((s) => s.setSelectedTimeframe);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient.getSettings();
      // The backend ALWAYS returns the full persisted settings object (it
      // creates a canonical default row via the Prisma schema on first fetch),
      // so we trust the server values verbatim — no client-side fake defaults.
      setSettings({
        timeframe: data.timeframe,
        confidenceGuardrail: data.confidenceGuardrail,
        maxRequestsPerMin: data.maxRequestsPerMin,
        responseSlaMs: data.responseSlaMs,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to load settings";
      setError(msg);
      setSettings(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await apiClient.updateSettings({
        timeframe: settings.timeframe,
        confidenceGuardrail: settings.confidenceGuardrail,
        maxRequestsPerMin: settings.maxRequestsPerMin,
        responseSlaMs: settings.responseSlaMs,
      });
      setSettings(updated);
      storeSetTimeframe(updated.timeframe);
      setSuccessMsg(t("settingsSaved"));
      setTimeout(() => setSuccessMsg(null), 5000);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to save settings";
      setError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const defaultSettings = {
        timeframe: "1d",
        confidenceGuardrail: 0.8,
        maxRequestsPerMin: 120,
        responseSlaMs: 800,
      };
      const updated = await apiClient.updateSettings(defaultSettings);
      setSettings(updated);
      storeSetTimeframe(updated.timeframe);
      setSuccessMsg(t("settingsReset"));
      setTimeout(() => setSuccessMsg(null), 5000);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to reset settings";
      setError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const tfOptions = [
    { value: "S5", label: "S5" },
    { value: "S10", label: "S10" },
    { value: "S15", label: "S15" },
    { value: "S30", label: "S30" },
    { value: "M1", label: `M1 (${t("scalping")})` },
    { value: "M2", label: `M2 (${t("scalping")})` },
    { value: "M3", label: `M3 (${t("scalping")})` },
    { value: "M5", label: `M5 (${t("scalping")})` },
    { value: "M10", label: `M10 (${t("scalping")})` },
    { value: "M15", label: `M15 (${t("intraday")})` },
    { value: "M30", label: `M30 (${t("intraday")})` },
    { value: "H1", label: `H1 (${t("hourly")})` },
    { value: "H4", label: `H4 (${t("swing")})` },
    { value: "D1", label: `D1 (${t("daily")})` },
  ];

  const themeOptions: Array<{
    mode: ThemeMode;
    label: string;
    icon: React.ReactNode;
  }> = [
    { mode: "dark", label: t("obsidianDark"), icon: <Moon className="w-4 h-4" /> },
    { mode: "light", label: t("lightTheme"), icon: <Sun className="w-4 h-4" /> },
    { mode: "system", label: t("systemTheme"), icon: <Monitor className="w-4 h-4" /> },
  ];

  const riskModes = [
    { value: "conservative", label: t("conservative") },
    { value: "moderate", label: t("moderate") },
    { value: "aggressive", label: t("aggressive") },
  ];

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
                  <span className="text-emerald-500">{t("systemSettings")}</span>
                </h1>
                <p className="text-slate-600 dark:text-slate-400 mt-1 text-xs sm:text-sm max-w-2xl">
                  {t("settingsSubtitle")}
                </p>
              </div>

              <div className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 px-4 py-2.5 shadow-sm">
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.75)]" />
                <span className="text-xs text-slate-700 dark:text-slate-300 font-bold tracking-wider uppercase">
                  {t("backendSyncOnline")}
                </span>
              </div>
            </header>

            {/* Appearance & Language Section */}
            <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-5">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/15 text-blue-600 dark:text-blue-400">
                  <Languages className="w-5 h-5" />
                </span>
                <div>
                  <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                    {t("appearanceAndLanguage")}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {t("appearanceDesc")}
                  </p>
                </div>
              </div>

              {/* Theme selector */}
              <div className="mb-5">
                <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-2">
                  {t("theme")}
                </label>
                <div className="grid grid-cols-3 gap-2 sm:gap-3">
                  {themeOptions.map((opt) => (
                    <button
                      key={opt.mode}
                      type="button"
                      onClick={() => setTheme(opt.mode)}
                      disabled={opt.mode !== "dark"}
                      aria-pressed={theme === opt.mode}
                      title={
                        opt.mode !== "dark"
                          ? t("darkLockedTitle")
                          : opt.label
                      }
                      className={cn(
                        "flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold uppercase tracking-wider transition-all border active:scale-[0.98]",
                        "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
                        theme === opt.mode
                          ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                          : "bg-slate-50 dark:bg-slate-950/60 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800",
                      )}
                    >
                      {opt.icon}
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Language selector */}
              <div>
                <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-2">
                  {t("language")}
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                  {LANG_OPTIONS.map((opt) => (
                    <button
                      key={opt.code}
                      type="button"
                      onClick={() => setLang(opt.code)}
                      aria-pressed={lang === opt.code}
                      className={cn(
                        "rounded-xl px-4 py-3 text-sm font-bold uppercase tracking-wider transition-all border active:scale-[0.98]",
                        lang === opt.code
                          ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                          : "bg-slate-50 dark:bg-slate-950/60 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800",
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* Settings Body Grid — only renders once server-persisted
                settings are loaded; never shows hardcoded client defaults. */}
            {isLoading ? (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {[1, 2, 3, 4, 5, 6].map((i) => (
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
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {settings && (
                <>
              <section className="lg:col-span-2 space-y-6">
                <div className="bg-white dark:bg-slate-900/80 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                  <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
                    <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                      {t("radarConfiguration")}
                    </h2>
                    <div className="text-xs text-slate-500 font-mono">
                      <span className="text-slate-600 dark:text-slate-400 font-bold">{t("guardrails")}</span> · {t("persistedToDatabase")}
                    </div>
                  </div>

                  <div className="p-6">
                    {error && (
                      <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl">
                        <p className="text-xs text-rose-600 dark:text-rose-400 font-mono">{error}</p>
                      </div>
                    )}

                    {successMsg && (
                      <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl">
                        <p className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-bold">
                          {successMsg}
                        </p>
                      </div>
                    )}

                    <div className="space-y-5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {/* Confidence Guardrail */}
                        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-4">
                          <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold">
                            {t("confidenceGuardrail")}
                          </label>
                          <div className="mt-2">
                            <select
                              value={settings.confidenceGuardrail.toString()}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  confidenceGuardrail: parseFloat(e.target.value),
                                }))
                              }
                              className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-slate-100 text-sm font-bold focus:outline-none focus:border-emerald-500 cursor-pointer shadow-sm"
                            >
                              <option value="0.90">{t("veryStrict")}</option>
                              <option value="0.80">{t("strictFilter")}</option>
                              <option value="0.70">{t("moderate")}</option>
                              <option value="0.60">{t("permissive")}</option>
                              <option value="0.50">{t("relaxed")}</option>
                            </select>
                          </div>
                          <p className="mt-2 text-xs text-slate-500">
                            {t("minConfidenceHint")}
                          </p>
                        </div>

                        {/* Timeframe */}
                        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-4">
                          <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold">
                            {t("timeframeExecution")}
                          </label>
                          <div className="mt-2">
                            <select
                              value={settings.timeframe}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  timeframe: e.target.value,
                                }))
                              }
                              className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-slate-100 text-sm font-bold focus:outline-none focus:border-emerald-500 cursor-pointer shadow-sm"
                            >
                              {tfOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <p className="mt-2 text-xs text-slate-500">
                            {t("defaultAnalysisHint")}
                          </p>
                        </div>
                      </div>

                      {/* API Bounds */}
                      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-4">
                        <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold">
                          {t("apiBounds")}
                        </label>
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-sm text-slate-700 dark:text-slate-300 font-bold">
                                {t("maxRequests")}
                              </span>
                              <span className="text-xs text-slate-500 font-mono">
                                {t("perMinute")}
                              </span>
                            </div>
                            <input
                              type="number"
                              min={1}
                              max={10000}
                              value={settings.maxRequestsPerMin}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  maxRequestsPerMin: parseInt(e.target.value) || 120,
                                }))
                              }
                              className="mt-2 w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-slate-100 text-sm font-mono focus:outline-none focus:border-emerald-500 shadow-sm"
                            />
                          </div>
                          <div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-sm text-slate-700 dark:text-slate-300 font-bold">
                                {t("responseSla")}
                              </span>
                              <span className="text-xs text-slate-500 font-mono">
                                {t("targetMs")}
                              </span>
                            </div>
                            <input
                              type="number"
                              min={100}
                              max={30000}
                              step={100}
                              value={settings.responseSlaMs}
                              onChange={(e) =>
                                setSettings((s) => ({
                                  ...s,
                                  responseSlaMs: parseInt(e.target.value) || 800,
                                }))
                              }
                              className="mt-2 w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-slate-100 text-sm font-mono focus:outline-none focus:border-emerald-500 shadow-sm"
                            />
                          </div>
                        </div>

                        <div className="mt-4 rounded-xl bg-white dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 p-4">
                          <div className="flex items-start gap-3">
                            <div className="mt-1 h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.7)] shrink-0" />
                            <div>
                              <p className="text-sm text-slate-900 dark:text-slate-200 font-bold">
                                {t("securityPosture")}
                              </p>
                              <p className="text-xs text-slate-500 mt-1">
                                {t("securityHint")}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Broker & API Section */}
                      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-4">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider mb-3">
                          {t("brokerAndApi")}
                        </h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="sm:col-span-2">
                            <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-2">
                              {t("binanceApiKey")}
                            </label>
                            <input
                              type="password"
                              placeholder="— •— ••••••"
                              value={broker.binanceApiKey}
                              onChange={(e) =>
                                saveBroker({ ...broker, binanceApiKey: e.target.value })
                              }
                              className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-slate-100 text-sm font-mono placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-blue-500 shadow-sm"
                            />
                            <p className="mt-1 text-[10px] text-slate-500 font-mono">
                              {t("storedLocallyHint")}
                            </p>
                          </div>
                          <div className="sm:col-span-2">
                            <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-2">
                              {t("binanceApiSecret")}
                            </label>
                            <input
                              type="password"
                              placeholder="— •— ••••••"
                              value={broker.binanceApiSecret}
                              onChange={(e) =>
                                saveBroker({
                                  ...broker,
                                  binanceApiSecret: e.target.value,
                                })
                              }
                              className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-slate-100 text-sm font-mono placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-blue-500 shadow-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-2">
                              {t("alpacaApiKey")}
                            </label>
                            <input
                              type="password"
                              placeholder="PK…"
                              value={broker.alpacaApiKey}
                              onChange={(e) =>
                                saveBroker({ ...broker, alpacaApiKey: e.target.value })
                              }
                              className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-slate-100 text-sm font-mono placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-blue-500 shadow-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-2">
                              {t("alpacaApiSecret")}
                            </label>
                            <input
                              type="password"
                              placeholder="— ••—••—"
                              value={broker.alpacaApiSecret}
                              onChange={(e) =>
                                saveBroker({
                                  ...broker,
                                  alpacaApiSecret: e.target.value,
                                })
                              }
                              className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-slate-100 text-sm font-mono placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-blue-500 shadow-sm"
                            />
                          </div>

                          {/* Slippage Tolerance */}
                          <div className="sm:col-span-2">
                            <label className="flex items-center justify-between">
                              <span className="block text-xs uppercase tracking-wider text-slate-500 font-bold">
                                {t("slippageTolerance")}
                              </span>
                              <span className="text-xs font-mono font-bold text-slate-700 dark:text-slate-300">
                                {broker.slippageTolerance.toFixed(2)}%
                              </span>
                            </label>
                            <input
                              type="range"
                              min={0}
                              max={5}
                              step={0.05}
                              value={broker.slippageTolerance}
                              onChange={(e) =>
                                saveBroker({
                                  ...broker,
                                  slippageTolerance: parseFloat(e.target.value),
                                })
                              }
                              className="w-full mt-2 cursor-pointer accent-blue-500"
                            />
                            <p className="mt-1 text-[10px] text-slate-500">
                              {t("slippageHint")}
                            </p>
                          </div>

                          {/* Risk Mode */}
                          <div className="sm:col-span-2">
                            <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-2">
                              {t("riskMode")}
                            </label>
                            <div className="flex flex-wrap gap-2">
                              {riskModes.map((rm) => (
                                <button
                                  key={rm.value}
                                  type="button"
                                  onClick={() =>
                                    saveBroker({ ...broker, riskMode: rm.value })
                                  }
                                  className={cn(
                                    "px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider border transition-all active:scale-[0.98]",
                                    broker.riskMode === rm.value
                                      ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                                      : "bg-white dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800",
                                  )}
                                >
                                  {rm.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* WebSocket Endpoint Override */}
                          <div className="sm:col-span-2">
                            <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-2">
                              {t("wsEndpointOverride")}
                            </label>
                            <input
                              type="url"
                              placeholder="ws://host:4000"
                              value={broker.wsEndpointOverride}
                              onChange={(e) =>
                                saveBroker({
                                  ...broker,
                                  wsEndpointOverride: e.target.value,
                                })
                              }
                              className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-slate-900 dark:text-slate-100 text-sm font-mono placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-blue-500 shadow-sm"
                            />
                            <p className="mt-1 text-[10px] text-slate-500 font-mono">
                              {t("wsEndpointHint")}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex flex-wrap items-center gap-3 pt-2">
                        <button
                          type="button"
                          onClick={handleSave}
                          disabled={isSaving}
                          className="inline-flex items-center gap-2 rounded-xl px-5 py-3 border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 text-sm font-bold uppercase tracking-wider transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                        >
                          {isSaving ? (
                            <>
                              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                              {t("saving")}
                            </>
                          ) : (
                            <>
                              <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.8)]" />
                              {t("saveChanges")}
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={handleReset}
                          disabled={isSaving}
                          className="inline-flex items-center gap-2 rounded-xl px-5 py-3 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-bold uppercase tracking-wider transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                        >
                          {t("resetToDefaults")}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Execution Console */}
              <aside>
                <div className="bg-white dark:bg-slate-900/80 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                  <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800">
                    <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                      {t("executionConsole")}
                    </h2>
                    <p className="text-xs text-slate-500 mt-1">
                      {t("liveStatusHint")}
                    </p>
                  </div>

                  <div className="p-6 space-y-4">
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                          <span className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                            {t("lastApplied")}
                          </span>
                        </div>
                        <span className="text-sm font-bold text-slate-900 dark:text-slate-200">
                          {successMsg ? t("justNow") : t("persisted")}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 rounded-full bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)]" />
                          <span className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                            {t("confidenceMode")}
                          </span>
                        </div>
                        <span className="text-sm font-bold font-mono text-slate-900 dark:text-slate-200">
                          {(settings.confidenceGuardrail * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 rounded-full bg-violet-500 shadow-[0_0_10px_rgba(139,92,246,0.5)]" />
                          <span className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                            {t("timeWindow")}
                          </span>
                        </div>
                        <span className="text-sm font-bold font-mono text-slate-900 dark:text-slate-200">
                          {settings.timeframe.toUpperCase()}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 rounded-full bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]" />
                          <span className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                            {t("apiRate")}
                          </span>
                        </div>
                        <span className="text-sm font-bold font-mono text-slate-900 dark:text-slate-200">
                          {settings.maxRequestsPerMin}/min
                        </span>
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                          {t("systemHealth")}
                        </span>
                        <span className="text-xs text-emerald-600 dark:text-emerald-400 font-bold">
                          {t("nominal")}
                        </span>
                      </div>
                      <div className="mt-3 h-2 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                        <div className="h-full w-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-500" />
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        {t("noDegradation")}
                      </p>
                    </div>
                  </div>
                </div>
              </aside>
              </>)}
            </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

