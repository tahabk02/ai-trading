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
    // PART 39 [373] — the slow end of PO's "5 seconds to 1 month" range.
    { value: "W1", label: "W1" },
    { value: "MN1", label: "MN1" },
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
                  <span className="text-primary">{t("systemSettings")}</span>
                </h1>
                <p className="text-ink-muted mt-1 text-xs sm:text-sm max-w-2xl">
                  {t("settingsSubtitle")}
                </p>
              </div>

              <div
                className={cn(
                  "flex items-center gap-2 rounded-control border px-4 py-2.5 shadow-sm",
                  error
                    ? "border-st-neg/40 bg-st-neg/10"
                    : "border-line bg-surface",
                )}
              >
                <span
                  className={cn(
                    "inline-flex h-2.5 w-2.5 rounded-full",
                    error
                      ? "bg-st-neg shadow-[0_0_12px_rgba(239,68,68,0.75)]"
                      : "bg-success shadow-[0_0_12px_rgba(16,185,129,0.75)]",
                  )}
                />
                <span
                  className={cn(
                    "text-xs font-bold tracking-wider uppercase",
                    error ? "text-st-neg" : "text-ink-muted",
                  )}
                >
                  {error ? t("error") : t("backendSyncOnline")}
                </span>
              </div>
            </header>

            {/* Appearance & Language Section */}
            <section className="tp-card p-5 sm:p-6">
              <div className="flex items-center gap-3 mb-5">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-control bg-primary/12 text-primary border border-primary/20">
                  <Languages className="w-5 h-5" />
                </span>
                <div>
                  <h2 className="text-base sm:text-lg font-bold text-ink uppercase tracking-wider">
                    {t("appearanceAndLanguage")}
                  </h2>
                  <p className="text-xs text-ink-muted mt-0.5">
                    {t("appearanceDesc")}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Theme selector */}
                <div>
                  <label className="block text-xs uppercase tracking-wider text-ink-faint font-bold mb-2">
                    {t("theme")}
                  </label>
                  <div className="tp-segmented flex-wrap w-full">
                    {themeOptions.map((opt) => (
                      <button
                        key={opt.mode}
                        type="button"
                        onClick={() => setTheme(opt.mode)}
                        aria-pressed={theme === opt.mode}
                        title={opt.label}
                        className={cn(
                          "tp-segmented-item flex-1",
                          theme === opt.mode && "tp-segmented-item-active",
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
                  <label className="block text-xs uppercase tracking-wider text-ink-faint font-bold mb-2">
                    {t("language")}
                  </label>
                  <div className="tp-segmented flex-wrap w-full">
                    {LANG_OPTIONS.map((opt) => (
                      <button
                        key={opt.code}
                        type="button"
                        onClick={() => setLang(opt.code)}
                        aria-pressed={lang === opt.code}
                        className={cn(
                          "tp-segmented-item flex-1",
                          lang === opt.code && "tp-segmented-item-active",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
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
                    className="tp-skeleton p-6"
                  >
                    <div className="h-5 w-1/3 bg-elevated rounded mb-4" />
                    <div className="h-10 bg-elevated rounded" />
                  </div>
                ))}
              </div>
            ) : !settings ? (
              <div
                role="alert"
                className="tp-card mx-auto w-full max-w-xl border-st-neg/40 bg-st-neg/10 p-8 text-center"
              >
                <h2 className="text-base font-bold uppercase tracking-wider text-st-neg">
                  {t("error")}
                </h2>
                <p className="mt-2 text-sm text-ink-muted">
                  {error ?? t("loadingSettings")}
                </p>
                <button
                  type="button"
                  onClick={loadSettings}
                  className="tp-btn tp-btn-primary mt-5"
                >
                  {t("retry")}
                </button>
              </div>
            ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <>
              <section className="lg:col-span-2 space-y-6">
                <div className="tp-card overflow-hidden">
                  <div className="px-6 py-5 border-b border-line flex items-center justify-between gap-3">
                    <h2 className="text-base sm:text-lg font-bold text-ink uppercase tracking-wider">
                      {t("radarConfiguration")}
                    </h2>
                    <div className="text-xs text-ink-muted font-mono">
                      <span className="text-ink-muted font-bold">{t("guardrails")}</span> · {t("persistedToDatabase")}
                    </div>
                  </div>

                  <div className="p-6">
                    {error && (
                      <div className="tp-banner tp-banner-error mb-4">
                        <p className="text-xs text-danger font-mono">{error}</p>
                      </div>
                    )}

                    {successMsg && (
                      <div className="tp-banner tp-banner-success mb-4">
                        <p className="text-xs text-success font-mono font-bold">
                          {successMsg}
                        </p>
                      </div>
                    )}

                    <div className="space-y-5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {/* Confidence Guardrail */}
                        <div className="rounded-control border border-line bg-well p-4">
                          <label className="block text-xs uppercase tracking-wider text-ink-muted font-bold">
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
                              className="tp-input w-full font-bold cursor-pointer"
                            >
                              <option value="0.90">{t("veryStrict")}</option>
                              <option value="0.80">{t("strictFilter")}</option>
                              <option value="0.70">{t("moderate")}</option>
                              <option value="0.60">{t("permissive")}</option>
                              <option value="0.50">{t("relaxed")}</option>
                            </select>
                          </div>
                          <p className="mt-2 text-xs text-ink-muted">
                            {t("minConfidenceHint")}
                          </p>
                        </div>

                        {/* Timeframe */}
                        <div className="rounded-control border border-line bg-well p-4">
                          <label className="block text-xs uppercase tracking-wider text-ink-muted font-bold">
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
                              className="tp-input w-full font-bold cursor-pointer"
                            >
                              {tfOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <p className="mt-2 text-xs text-ink-muted">
                            {t("defaultAnalysisHint")}
                          </p>
                        </div>
                      </div>

                      {/* API Bounds */}
                      <div className="rounded-control border border-line bg-well p-4">
                        <label className="block text-xs uppercase tracking-wider text-ink-muted font-bold">
                          {t("apiBounds")}
                        </label>
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-sm text-ink-muted font-bold">
                                {t("maxRequests")}
                              </span>
                              <span className="text-xs text-ink-muted font-mono">
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
                              className="tp-input mt-2 w-full font-mono"
                            />
                          </div>
                          <div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-sm text-ink-muted font-bold">
                                {t("responseSla")}
                              </span>
                              <span className="text-xs text-ink-muted font-mono">
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
                              className="tp-input mt-2 w-full font-mono"
                            />
                          </div>
                        </div>

                        <div className="mt-4 rounded-control bg-well border border-line p-4">
                          <div className="flex items-start gap-3">
                            <div className="mt-1 h-2.5 w-2.5 rounded-full bg-success shadow-[0_0_12px_rgba(16,185,129,0.7)] shrink-0" />
                            <div>
                              <p className="text-sm text-ink font-bold">
                                {t("securityPosture")}
                              </p>
                              <p className="text-xs text-ink-muted mt-1">
                                {t("securityHint")}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Broker & API Section */}
                      <div className="rounded-control border border-line bg-well p-4">
                        <h3 className="text-sm font-bold text-ink uppercase tracking-wider mb-3">
                          {t("brokerAndApi")}
                        </h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="sm:col-span-2">
                            <label className="block text-xs uppercase tracking-wider text-ink-muted font-bold mb-2">
                              {t("binanceApiKey")}
                            </label>
                            <input
                              type="password"
                              placeholder="— •— ••••••"
                              value={broker.binanceApiKey}
                              onChange={(e) =>
                                saveBroker({ ...broker, binanceApiKey: e.target.value })
                              }
                              className="tp-input w-full font-mono"
                            />
                            <p className="mt-1 text-[10px] text-ink-muted font-mono">
                              {t("storedLocallyHint")}
                            </p>
                          </div>
                          <div className="sm:col-span-2">
                            <label className="block text-xs uppercase tracking-wider text-ink-muted font-bold mb-2">
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
                              className="tp-input w-full font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-xs uppercase tracking-wider text-ink-muted font-bold mb-2">
                              {t("alpacaApiKey")}
                            </label>
                            <input
                              type="password"
                              placeholder="PK…"
                              value={broker.alpacaApiKey}
                              onChange={(e) =>
                                saveBroker({ ...broker, alpacaApiKey: e.target.value })
                              }
                              className="tp-input w-full font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-xs uppercase tracking-wider text-ink-muted font-bold mb-2">
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
                              className="tp-input w-full font-mono"
                            />
                          </div>

                          {/* Slippage Tolerance */}
                          <div className="sm:col-span-2">
                            <label className="flex items-center justify-between">
                              <span className="block text-xs uppercase tracking-wider text-ink-muted font-bold">
                                {t("slippageTolerance")}
                              </span>
                              <span className="text-xs font-mono font-bold text-ink-muted">
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
                              className="w-full mt-2 cursor-pointer accent-primary"
                            />
                            <p className="mt-1 text-[10px] text-ink-muted">
                              {t("slippageHint")}
                            </p>
                          </div>

                          {/* Risk Mode */}
                          <div className="sm:col-span-2">
                            <label className="block text-xs uppercase tracking-wider text-ink-muted font-bold mb-2">
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
                                    "tp-segmented-item",
                                    broker.riskMode === rm.value
                                      ? "tp-segmented-item-active"
                                      : "border border-line bg-surface text-ink-muted hover:text-ink hover:bg-elevated",
                                  )}
                                >
                                  {rm.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* WebSocket Endpoint Override */}
                          <div className="sm:col-span-2">
                            <label className="block text-xs uppercase tracking-wider text-ink-muted font-bold mb-2">
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
                              className="tp-input w-full font-mono"
                            />
                            <p className="mt-1 text-[10px] text-ink-muted font-mono">
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
                          className="tp-btn tp-btn-primary"
                        >
                          {isSaving ? (
                            <>
                              <span className="h-2 w-2 rounded-full bg-current animate-pulse" />
                              {t("saving")}
                            </>
                          ) : (
                            <>
                              <span className="h-2 w-2 rounded-full bg-current" />
                              {t("saveChanges")}
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={handleReset}
                          disabled={isSaving}
                          className="tp-btn tp-btn-secondary"
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
                <div className="tp-card overflow-hidden">
                  <div className="px-6 py-5 border-b border-line">
                    <h2 className="text-base sm:text-lg font-bold text-ink uppercase tracking-wider">
                      {t("executionConsole")}
                    </h2>
                    <p className="text-xs text-ink-muted mt-1">
                      {t("liveStatusHint")}
                    </p>
                  </div>

                  <div className="p-6 space-y-4">
                    <div className="rounded-control border border-line bg-well px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 rounded-full bg-success shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                          <span className="text-xs uppercase tracking-wider text-ink-muted font-bold">
                            {t("lastApplied")}
                          </span>
                        </div>
                        <span className="text-sm font-bold text-ink">
                          {successMsg ? t("justNow") : t("persisted")}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-control border border-line bg-well px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 rounded-full bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)]" />
                          <span className="text-xs uppercase tracking-wider text-ink-muted font-bold">
                            {t("confidenceMode")}
                          </span>
                        </div>
                        <span className="text-sm font-bold font-mono text-ink">
                          {(settings.confidenceGuardrail * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>

                    <div className="rounded-control border border-line bg-well px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 rounded-full bg-violet-500 shadow-[0_0_10px_rgba(139,92,246,0.5)]" />
                          <span className="text-xs uppercase tracking-wider text-ink-muted font-bold">
                            {t("timeWindow")}
                          </span>
                        </div>
                        <span className="text-sm font-bold font-mono text-ink">
                          {settings.timeframe.toUpperCase()}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-control border border-line bg-well px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 rounded-full bg-warning shadow-[0_0_10px_rgba(245,158,11,0.5)]" />
                          <span className="text-xs uppercase tracking-wider text-ink-muted font-bold">
                            {t("apiRate")}
                          </span>
                        </div>
                        <span className="text-sm font-bold font-mono text-ink">
                          {settings.maxRequestsPerMin}/min
                        </span>
                      </div>
                    </div>

                    <div className="rounded-control border border-line bg-well p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs uppercase tracking-wider text-ink-muted font-bold">
                          {t("systemHealth")}
                        </span>
                        <span className="text-xs text-success font-bold">
                          {t("nominal")}
                        </span>
                      </div>
                      <div className="mt-3 h-2 w-full rounded-full bg-elevated overflow-hidden">
                        <div className="h-full w-full bg-gradient-to-r from-success via-primary to-brand-hover" />
                      </div>
                      <p className="mt-2 text-xs text-ink-muted">
                        {t("noDegradation")}
                      </p>
                    </div>
                  </div>
                </div>
              </aside>
              </>
            </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

