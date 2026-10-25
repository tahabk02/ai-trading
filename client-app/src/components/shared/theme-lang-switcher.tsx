"use client";

/**
 * theme-lang-switcher.tsx - HEADER CONTROLS FOR THE THEME & LANGUAGE ENGINES
 *
 * Theme: a one-tap Dark / Light toggle. The choice persists under
 * THEME_STORAGE_KEY and drives the `<html class>` owned by useTheme. Every
 * color resolves through the design-system theme object in globals.css.
 *
 * Language: EN / FR / AR / ES segmented control. Selecting Arabic flips the
 * entire terminal to RTL via the <html dir="rtl"> attribute.
 */

import React from "react";
import { Moon, Sun, Languages } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { useLangContext } from "@/hooks/useLangContext";
import type { Lang } from "@/utils/i18n";
import { cn } from "@/utils/cn";

export const ThemeSwitcher: React.FC = () => {
  const { mounted, resolvedTheme, toggleTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  if (!mounted) {
    return (
      <div className="w-10 h-10 sm:w-9 sm:h-9 rounded-control border border-line bg-elevated flex items-center justify-center opacity-40">
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
        "w-10 h-10 sm:w-9 sm:h-9 rounded-control border flex items-center justify-center transition-all duration-150 active:scale-95",
        "border-line text-ink-muted hover:text-ink hover:border-line-strong",
        "bg-elevated hover:bg-surface",
      )}
    >
      {isDark ? (
        <Sun className="w-4 h-4" />
      ) : (
        <Moon className="w-4 h-4" />
      )}
    </button>
  );
};

const LANG_LABELS: Array<{ code: Lang; label: string; title: string }> = [
  { code: "en", label: "EN", title: "English" },
  { code: "fr", label: "FR", title: "Français" },
  { code: "ar", label: "AR", title: "العربية (RTL)" },
  { code: "es", label: "ES", title: "Español" },
];

export const LanguageSwitcher: React.FC = () => {
  const { lang, setLang, mounted } = useLangContext();

  if (!mounted) {
    return (
      <div className="h-10 sm:h-9 w-[104px] rounded-control border border-line bg-elevated animate-pulse" />
    );
  }

  return (
    <div
      className="flex items-center gap-0.5 p-0.5 rounded-control border border-line bg-elevated"
      role="group"
      aria-label="Language selection"
    >
      <Languages className="w-3 h-3 mx-1 text-ink-faint shrink-0" />
      {LANG_LABELS.map(({ code, label, title }) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          title={title}
          className={cn(
            "px-1.5 min-h-[32px] rounded-md text-[10px] font-bold uppercase tracking-wide transition-all",
            lang === code
              ? "bg-primary text-white shadow-sm shadow-primary/30"
              : "text-ink-faint hover:text-ink hover:bg-surface",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

export default ThemeSwitcher;
