/** @type {import('tailwindcss').Config} */

/**
 * ── ALPHA.5 PRO DESIGN SYSTEM — TAILWIND TOKEN BRIDGE ──
 *
 * The terminal ships ONE theme object, defined as CSS custom properties in
 * `src/styles/globals.css` under `:root` (dark) and `html.light`. Tailwind
 * resolves every palette entry through those variables instead of hard-coding
 * hex values, so flipping `<html class="dark|light">` re-themes the entire UI
 * (surfaces, borders, text, chart) with zero per-component color logic.
 *
 * Channel-triplet variables (`--sl-100: 241 245 249`) are used with
 * `rgb(var(--x) / <alpha-value>)` so Tailwind's `/opacity` modifiers keep
 * working (`bg-slate-900/70`, `border-slate-800/60`, …).
 */
module.exports = {
  // The pre-paint script in layout.tsx stamps `dark` on <html> BEFORE first
  // paint; every `dark:` variant keys off that class.
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "Cascadia Mono",
          "SF Mono",
          "SFMono-Regular",
          "Segoe UI Mono",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      colors: {
        // ── SLATE is theme-driven: the scale INVERTS in light mode so existing
        //    `text-slate-100` / `border-slate-800` / `bg-slate-900` utilities
        //    resolve to legible light-mode values automatically.
        slate: {
          50: "rgb(var(--sl-50) / <alpha-value>)",
          100: "rgb(var(--sl-100) / <alpha-value>)",
          200: "rgb(var(--sl-200) / <alpha-value>)",
          300: "rgb(var(--sl-300) / <alpha-value>)",
          400: "rgb(var(--sl-400) / <alpha-value>)",
          500: "rgb(var(--sl-500) / <alpha-value>)",
          600: "rgb(var(--sl-600) / <alpha-value>)",
          700: "rgb(var(--sl-700) / <alpha-value>)",
          800: "rgb(var(--sl-800) / <alpha-value>)",
          900: "rgb(var(--sl-900) / <alpha-value>)",
          950: "rgb(var(--sl-950) / <alpha-value>)",
        },
        // ── OBSIDIAN surface palette — also theme-driven (dark values in dark
        //    mode, white/near-white surfaces in light mode).
        obsidian: {
          DEFAULT: "rgb(var(--ob) / <alpha-value>)",
          50: "rgb(var(--sl-50) / <alpha-value>)",
          100: "rgb(var(--sl-100) / <alpha-value>)",
          200: "rgb(var(--sl-200) / <alpha-value>)",
          300: "rgb(var(--sl-300) / <alpha-value>)",
          400: "rgb(var(--sl-400) / <alpha-value>)",
          500: "rgb(var(--sl-500) / <alpha-value>)",
          600: "rgb(var(--sl-600) / <alpha-value>)",
          700: "rgb(var(--sl-700) / <alpha-value>)",
          800: "rgb(var(--sl-800) / <alpha-value>)",
          900: "rgb(var(--ob-900) / <alpha-value>)",
          950: "rgb(var(--ob-950) / <alpha-value>)",
        },
        // ── SEMANTIC TOKENS (prefer these for new surfaces) ──
        app: "var(--tp-bg)",
        surface: "var(--tp-surface)",
        elevated: "var(--tp-elevated)",
        well: "var(--tp-well)",
        line: "var(--tp-border)",
        "line-strong": "var(--tp-border-strong)",
        ink: "var(--tp-text)",
        "ink-muted": "var(--tp-text-2)",
        "ink-faint": "var(--tp-text-3)",
        accent: "var(--tp-accent)",
        "accent-2": "var(--tp-accent-2)",
        // Institutional candlestick colors — shared chart + UI accents. These
        // are deliberately IDENTICAL in both themes (teal / coral).
        "bull-green": "#22ab94",
        "bear-red": "#f23645",
        // ── PART 16 TERMINAL BLOTTER PALETTE (dark-only, channel triplets) ──
        // Flat-obsidian matrix system: one canvas tone, one cell tone, one
        // hairline; every saturated pixel is functional. Resolution via rgb()
        // keeps `/opacity` modifiers working (bg-term-panel/10 …).
        term: {
          canvas: "rgb(var(--term-canvas) / <alpha-value>)",
          panel: "rgb(var(--term-panel) / <alpha-value>)",
          line: "rgb(var(--term-line) / <alpha-value>)",
          ink: "rgb(var(--term-ink) / <alpha-value>)",
          "ink-dim": "rgb(var(--term-ink-dim) / <alpha-value>)",
          "ink-faint": "rgb(var(--term-ink-faint) / <alpha-value>)",
        },
        // PART 16 SEMANTIC HUES — the two non-directional classification
        // channels: gold = real-market / institutional-hold, cyan = crypto.
        // (Keep the values distinct from bull/bear so direction is un-missable.)
        gold: "rgb(var(--term-gold) / <alpha-value>)",
        crypto: "rgb(var(--term-crypto) / <alpha-value>)",
        // Direction channels — SAME values as the candle colours (bull/bear)
        // via channel triplets so `/alpha` modifiers keep working, while the
        // plain `bull-green`/`bear-red` hex tokens above stay untouched.
        bull: "rgb(var(--bull) / <alpha-value>)",
        bear: "rgb(var(--bear) / <alpha-value>)",
      },
      borderRadius: {
        card: "8px",
        control: "6px",
        chip: "4px",
        // PART 16: instrument cells use a near-square terminal radius.
        cell: "4px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.05)",
        "card-lift": "0 8px 24px rgba(0,0,0,0.18)",
        "glow-bull": "0 0 16px rgba(34,171,148,0.35)",
        "glow-bear": "0 0 16px rgba(242,54,69,0.35)",
      },
      backgroundImage: {
        "header-sheen":
          "linear-gradient(180deg, var(--tp-surface) 0%, var(--tp-bg) 100%)",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
      /*
       * ── Custom screens (breakpoints) ──
       * xs (480px): For very small mobile devices.
       * All other breakpoints inherit Tailwind defaults:
       *   sm: 640px, md: 768px, lg: 1024px, xl: 1280px, 2xl: 1536px
       */
      screens: {
        xs: "480px",
      },
    },
  },
  plugins: [],
};
