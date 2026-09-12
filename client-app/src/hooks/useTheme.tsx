"use client";

/**
 * useTheme.tsx — INSTITUTIONAL DARK THEME ENGINE (light mode PURGED)
 *
 * Zero-flash architecture:
 *  1. A blocking inline script in `layout.tsx` stamps `class="dark"` +
 *     `color-scheme: dark` on <html> BEFORE first paint.
 *  2. This provider hydrates to the SAME dark state, so the resolved theme on
 *     first client render matches the pre-paint DOM — no flash.
 *  3. Tailwind `darkMode: "class"` consumes the <html> class for styling.
 *
 * LIGHT/SYSTEM LOCK: the product ships ONE palette — the unified obsidian
 * institutional dark (#0B0E14). Older builds persisted `light`/`system`
 * under THEME_STORAGE_KEY; every entry point here (storage read, media
 * resolution, setTheme, toggleTheme, pre-paint script) COERCES to "dark", so
 * no stale localStorage flag or OS preference can ever re-break the UI into
 * a blinding white surface.
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

/** Read the persisted theme mode (SSR-safe). */
export function getStoredTheme(): ThemeMode {
  // ── INSTITUTIONAL DARK LOCK ──
  // Any light/system value persisted by older builds is ignored — the unified
  // obsidian palette is the only shipped UI. Storage writes are forced to
  // "dark" elsewhere, so this is a one-time migration guard.
  return DEFAULT_THEME;
}

/** Resolve "system" against the live media query. */
export function resolveSystemTheme(): ResolvedTheme {
  // Locked: the OS preference can never pull the terminal into light mode.
  return "dark";
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
  // Initial state matches the inline pre-paint script's outcome so the very
  // first client render is already correct — zero flash, zero hydration diff.
  const [theme, setThemeState] = useState<ThemeMode>(DEFAULT_THEME);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");
  const [mounted, setMounted] = useState(false);

  // ── Hydrate from localStorage (same source as the pre-paint script) ──
  useEffect(() => {
    // Locked to dark: purge any persisted light/system flag on hydration and
    // re-stamp the deep obsidian surface so a previous session's mode cannot
    // survive into this one.
    setThemeState("dark");
    setResolvedTheme("dark");
    applyThemeToDom("dark");
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    } catch {
      // localStorage unavailable — in-memory dark is sufficient.
    }
    setMounted(true);
  }, []);

  const setTheme = useCallback((_mode: ThemeMode) => {
    // ── INSTITUTIONAL DARK LOCK ──
    // Light/system mode is removed from the product. Any caller (legacy header
    // cycling, settings picker) requesting a non-dark mode is coerced to dark —
    // the unified obsidian palette is the only shipped UI.
    setThemeState("dark");
    setResolvedTheme("dark");
    applyThemeToDom("dark");
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    } catch {
      // localStorage unavailable (privacy mode) — in-memory only
    }
  }, []);

  const toggleTheme = useCallback(() => {
    // Locked to dark — the legacy light/dark toggle is a permanent no-op that
    // always stays on the institutional obsidian palette.
    setTheme("dark");
  }, [setTheme]);

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
 * <head> via Next.js <Script strategy="beforeInteractive"> or dangerously-
 * setInnerHTML in layout. Runs BEFORE first paint and stamps the darker
 * color-scheme + `dark` class unconditionally — the palette is locked, so no
 * localStorage read or system preference is ever consulted here.
 */
export const THEME_PREPAINT_SCRIPT = `(function(){try{var d=document.documentElement;d.classList.remove("dark","light");d.classList.add("dark");d.style.colorScheme="dark";}catch(e){document.documentElement.classList.add("dark");}})();`;

export default ThemeProvider;
