"use client";

/**
 * theme-lang-switcher.tsx — HEADER CONTROLS FOR THE THEME & LANGUAGE ENGINES
 *
 *  • Theme: a one-tap Dark ⇄ Light toggle. The choice persists under
 *    THEME_STORAGE_KEY and drives the `<html class>` owned by useTheme. Every
 *    color resolves through the design-system theme object in globals.css.
 *  • Language: EN / FR / AR / ES segmented control. Selecting Arabic flips the
 *    entire terminal to RTL via the <html dir="rtl"> attribute.
 */

import React from "react";
import { Moon, Sun, Languages } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { useLangContext } from "@/hooks/useLangContext";
import type { Lang } from "@/utils/i18n";
import { cn } from "@/utils/cn";

// ── THEME TOGGLE (dark ⇄ light, persisted) ──
export const ThemeSwitcher: React.FC = () => {
  const { mounted, resolvedTheme, toggleTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  // Render a stable placeholder until hydration to avoid SSR mismatch.
  if (!mounted) {
    return (
      <div className="w-8 h-8 rounded-lg border border-line flex items-center justify-center opacity-40">
        <Moon className="w-3.5 h-3.5" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={!isDark}
      title={isDark ? "Light theme" : "Dark theme"}
      className={cn(
        "w-8 h-8 rounded-lg border flex items-center justify-center transition-all duration-150 active:scale-95",
        "border-line text-ink-muted hover:text-ink hover:border-line-strong",
        "bg-elevated hover:bg-surface",
      )}
    >
      {isDark ? (
        <Sun className="w-3.5 h-3.5" />
      ) : (
        <Moon className="w-3.5 h-3.5" />
      )}
    </button>
  );
};

// ── LANGUAGE SWITCHER (EN / FR / AR / ES) ──
const LANG_LABELS: Array<{ code: Lang; label: string }> = [
  { code: "en", label: "EN" },
  { code: "fr", label: "FR" },
  { code: "ar", label: "ع" },
  { code: "es", label: "ES" },
];

export const LanguageSwitcher: React.FC = () => {
  const { lang, setLang, mounted } = useLangContext();

  if (!mounted) {
    return (
      <div className="h-8 w-[92px] rounded-lg border border-slate-700/50 bg-slate-900/60 animate-pulse" />
    );
  }

  return (
    <div
      className="flex items-center gap-0.5 p-0.5 rounded-lg border border-slate-700/50 bg-slate-900/60"
      role="group"
      aria-label="Language selection"
    >
      <Languages className="w-3 h-3 mx-1 text-slate-500 shrink-0" />
      {LANG_LABELS.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          title={
            code === "en"
              ? "English"
              : code === "fr"
                ? "Français"
                : code === "ar"
                  ? "العربية (RTL)"
                  : "Español"
          }
          className={cn(
            "px-1.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide transition-all",
            lang === code
              ? "bg-blue-600 text-white shadow-sm shadow-blue-600/40"
              : "text-slate-500 hover:text-white hover:bg-slate-800",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

export default ThemeSwitcher;
