"use client";

/**
 * useLangContext.tsx — MULTI-LANGUAGE ENGINE (EN / FR / AR + FULL RTL)
 *
 * Architecture:
 *  1. A blocking inline script in `layout.tsx` reads localStorage and stamps
 *     `lang` + `dir` attributes on <html> BEFORE first paint (zero flash,
 *     zero RTL layout shift).
 *  2. This provider hydrates from the SAME key, then keeps <html lang/dir>
 *     synchronized on every switch.
 *  3. Arabic ("ar") forces dir="rtl" across the entire terminal UI; English
 *     and French force dir="ltr".
 *
 * All translations live in `@/utils/i18n` (single source of truth).
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  detectLang,
  isRTL,
  supportedLangs,
  t as translate,
  type Lang,
} from "@/utils/i18n";

export const LANG_STORAGE_KEY = "alpha5_lang";

/** Map each language to its BCP-47 tag for <html lang>. */
const LANG_TAGS: Record<Lang, string> = {
  en: "en",
  fr: "fr",
  ar: "ar",
  es: "es",
};

function isLang(value: unknown): value is Lang {
  return typeof value === "string" && supportedLangs.includes(value as Lang);
}

/** Read persisted language, falling back to browser detection (SSR-safe). */
export function getStoredLang(): Lang {
  if (typeof window === "undefined") return "en";
  try {
    const raw = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (isLang(raw)) return raw;
  } catch {
    // localStorage unavailable
  }
  return detectLang();
}

/**
 * Apply language + direction to the document root.
 * Mirrors the inline pre-paint script EXACTLY so hydration never diverges.
 */
export function applyLangToDom(lang: Lang): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("lang", LANG_TAGS[lang]);
  root.setAttribute("dir", isRTL(lang) ? "rtl" : "ltr");
}

interface LangContextValue {
  /** Active UI language: en | fr | ar */
  lang: Lang;
  /** True when the active language requires RTL layout (Arabic). */
  rtl: boolean;
  setLang: (lang: Lang) => void;
  /** Translation helper bound to the active language (optional interpolation). */
  t: (
    key: keyof (typeof import("@/utils/i18n").translations)["en"],
    params?: Record<string, string | number>,
  ) => string;
  /** True after client hydration from localStorage. */
  mounted: boolean;
}

const LangContext = createContext<LangContextValue | null>(null);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  // Initial state matches the pre-paint script's outcome → zero hydration diff.
  const [lang, setLangState] = useState<Lang>("en");
  const [mounted, setMounted] = useState(false);

  // ── Hydrate from localStorage / browser detection ──
  useEffect(() => {
    const stored = getStoredLang();
    setLangState(stored);
    applyLangToDom(stored);
    setMounted(true);
  }, []);

  const setLang = useCallback((next: Lang) => {
    if (!isLang(next)) return;
    setLangState(next);
    applyLangToDom(next);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — in-memory only
    }
  }, []);

  const t = useCallback(
    (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params),
    [lang],
  );

  const value = useMemo<LangContextValue>(
    () => ({ lang, rtl: isRTL(lang), setLang, t, mounted }),
    [lang, setLang, t, mounted],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
};

export function useLangContext(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) {
    // Defensive fallback outside the provider.
    return {
      lang: "en",
      rtl: false,
      setLang: () => undefined,
      t: (key, params) => translate("en", key, params),
      mounted: false,
    };
  }
  return ctx;
}

/**
 * THE ZERO-FLASH PRE-PAINT LANGUAGE SCRIPT — runs BEFORE first paint:
 * reads localStorage, falls back to navigator.language, stamps
 * <html lang> + <html dir>. Arabic gets RTL instantly with no shift.
 */
export const LANG_PREPAINT_SCRIPT = `(function(){try{var k="${LANG_STORAGE_KEY}";var l=localStorage.getItem(k);if(l!=="en"&&l!=="fr"&&l!=="ar"&&l!=="es"){var n=(navigator.language||"en").toLowerCase();l=n.indexOf("ar")===0?"ar":(n.indexOf("fr")===0?"fr":(n.indexOf("es")===0?"es":"en"));}var d=document.documentElement;d.setAttribute("lang",l);d.setAttribute("dir",l==="ar"?"rtl":"ltr");}catch(e){document.documentElement.setAttribute("lang","en");document.documentElement.setAttribute("dir","ltr");}})();`;

export default LanguageProvider;
