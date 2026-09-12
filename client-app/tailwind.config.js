/** @type {import('tailwindcss').Config} */
module.exports = {
  // ── CLASS-BASED DARK MODE ──
  // The zero-flash pre-paint script in layout.tsx stamps `dark` on <html>
  // BEFORE first paint; every `dark:` variant keys off that class.
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        slate: {
          950: "#020617",
        },
        // ── ALPHA 5 PRO OBSIDIAN PALETTE (deep dark trading aesthetic) ──
        obsidian: {
          DEFAULT: "#0b0e14", // primary terminal background
          50: "#f6f7f9",
          100: "#eceef2",
          200: "#d5d9e2",
          300: "#b1b8c8",
          400: "#8794ad",
          500: "#687693",
          600: "#535e78",
          700: "#444c62",
          800: "#3b4153",
          900: "#12151d", // panel background
          950: "#070910", // deepest layer
        },
        // Institutional candlestick colors — shared chart + UI accents
        "bull-green": "#22ab94",
        "bear-red": "#f23645",
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
