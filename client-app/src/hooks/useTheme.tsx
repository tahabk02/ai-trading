"use client";

/**
 * useTheme.tsx — DARK / LIGHT THEME ENGINE
 *
 * Zero-flash architecture:
 *  1. A blocking inline script in `layout.tsx` stamps `class="dark|light"` +
 *     `color-scheme` on <html> BEFORE first paint.
 *  2. This provider hydrates to the SAME resolved state, so the first client
 *     render matches the pre-paint DOM — no flash.
 *  3. Tailwind `darkMode: "class"` consumes the <html> class for styling.
 *
 * DEFAULTS & PERSISTENCE:
 *  • Default is institutional obsidian DARK.
 *  • The user's choice (dark | light | system) persists under THEME_STORAGE_KEY.
 *  • "system" resolves against the live `prefers-color-scheme` media query.
 *  • Every color lives in the theme object in `src/styles/globals.css` — this
 *    hook only owns the class + persistence, never raw colors.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "alpha5_theme";

/** Deep obsidian dark trading aesthetic — the production default. */
export const DEFAULT_THEME: ThemeMode = "dark";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

/** Read the persisted theme mode (SSR-safe, defaults to dark). */
export function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : DEFAULT_THEME;
  } catch {
    // localStorage unavailable (privacy mode) — fall back to dark.
    return DEFAULT_THEME;
  }
}

/** Resolve "system" against the live media query (dark when unknown). */
export function resolveSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "dark";
  }
}

/** Resolve any mode to the concrete theme applied to the DOM. */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? resolveSystemTheme() : mode;
}

/**
 * Apply the resolved theme to the document root.
 * Mirrors the inline pre-paint script EXACTLY so hydration never diverges.
 */
export function applyThemeToDom(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

interface ThemeContextValue {
  /** Raw user preference: dark | light | system */
  theme: ThemeMode;
  /** The theme actually applied to the DOM after system resolution */
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
  /** Convenience: flip between dark and light (resolves through system). */
  toggleTheme: () => void;
  /** True after the client has hydrated from localStorage. */
  mounted: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  // Initial state matches the pre-paint default (dark) so the very first
  // client render is already correct — zero flash, zero hydration diff.
  const [theme, setThemeState] = useState<ThemeMode>(DEFAULT_THEME);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");
  const [mounted, setMounted] = useState(false);

  // ── Hydrate from localStorage (same source as the pre-paint script) ──
  useEffect(() => {
    const stored = getStoredTheme();
    const resolved = resolveTheme(stored);
    setThemeState(stored);
    setResolvedTheme(resolved);
    applyThemeToDom(resolved);
    setMounted(true);
  }, []);

  // ── Track the OS preference while in "system" mode ──
  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia)
      return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const resolved: ResolvedTheme = mq.matches ? "dark" : "light";
      setResolvedTheme(resolved);
      applyThemeToDom(resolved);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    const next = isThemeMode(mode) ? mode : DEFAULT_THEME;
    const resolved = resolveTheme(next);
    setThemeState(next);
    setResolvedTheme(resolved);
    applyThemeToDom(resolved);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // localStorage unavailable (privacy mode) — in-memory only
    }
  }, []);

  const toggleTheme = useCallback(() => {
    // Flip from whatever is CURRENTLY on screen → deterministic dark/light.
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme, mounted }),
    [theme, resolvedTheme, setTheme, toggleTheme, mounted],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Defensive fallback — components render correctly even outside the
    // provider (e.g. isolated storybook), defaulting to obsidian dark.
    return {
      theme: DEFAULT_THEME,
      resolvedTheme: "dark",
      setTheme: () => undefined,
      toggleTheme: () => undefined,
      mounted: false,
    };
  }
  return ctx;
}

/**
 * THE ZERO-FLASH PRE-PAINT SCRIPT — injected as a blocking <script> in
 * <head> (Next.js <Script strategy="beforeInteractive">). Runs BEFORE first
 * paint: reads the persisted mode, resolves `system` against the media query,
 * and stamps `class="dark|light"` + `color-scheme`. Never throws.
 */
export const THEME_PREPAINT_SCRIPT = `(function(){try{var m="dark";try{var s=localStorage.getItem("${THEME_STORAGE_KEY}");if(s==="light"){m="light";}else if(s==="system"){m=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";}}catch(e){}var d=document.documentElement;d.classList.remove("dark","light");d.classList.add(m);d.style.colorScheme=m;}catch(e){document.documentElement.classList.add("dark");}})();`;

export default ThemeProvider;
