"use client";

/**
 * theme-lang-switcher.tsx — HEADER CONTROLS FOR THE THEME & LANGUAGE ENGINES
 *
 *  • Theme: LOCKED to institutional dark. The legacy Dark → Light → System
 *    cycling toggle has been removed; the moon badge is a static state
 *    indicator (see useTheme's dark lock — light mode is purged everywhere).
 *  • Language: EN / FR / AR segmented control. Selecting Arabic flips the
 *    entire terminal to RTL via the <html dir="rtl"> attribute.
 */

import React from "react";
import { Moon, Languages } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { useLangContext } from "@/hooks/useLangContext";
import type { Lang } from "@/utils/i18n";
import { cn } from "@/utils/cn";

// ── THEME STATE BADGE (static — dark mode is locked product-wide) ──
export const ThemeSwitcher: React.FC = () => {
  const { mounted } = useTheme();

  // Render a stable placeholder until hydration to avoid SSR mismatch.
  if (!mounted) {
    return (
      <div className="w-8 h-8 rounded-lg border border-slate-700/50 flex items-center justify-center opacity-40">
        <Moon className="w-3.5 h-3.5" />
      </div>
    );
  }

  return (
    <span
      role="img"
      aria-label="Dark mode"
      title="Dark mode — institutional palette locked"
      className={cn(
        "w-8 h-8 rounded-lg border flex items-center justify-center pointer-events-none",
        "border-slate-700/50 text-slate-400",
        "bg-slate-900/60",
      )}
    >
      <Moon className="w-3.5 h-3.5" />
    </span>
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
