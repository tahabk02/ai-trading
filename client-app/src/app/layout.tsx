import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";

import Script from "next/script";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { GlobalErrorBoundary } from "@/components/shared/GlobalErrorBoundary";
import { HighConfidenceToast } from "@/components/shared/high-confidence-toast";
import { SocketProvider } from "@/hooks/useSocket";
import { ThemeProvider, THEME_PREPAINT_SCRIPT } from "@/hooks/useTheme";
import { LanguageProvider, LANG_PREPAINT_SCRIPT } from "@/hooks/useLangContext";

// ── FONT LOADING (BUILD-SAFE / OFFLINE-RESILIENT) ──
// We intentionally do NOT use `next/font/google` here. That loader downloads
// the font at BUILD time and hard-crashes the entire build when Google Fonts is
// unreachable (air-gapped CI, proxies, offline sandboxes). The terminal font is
// instead resolved purely by the CSS stack in globals.css:
//     "Inter", system-ui, -apple-system, sans-serif
//   • Inter renders ONLY if the user's OS/browser already has it installed.
//   • Otherwise the system-first stack (system-ui / Segoe UI / Roboto / Arial)
//     renders immediately — no network fetch is ever required, so the first
//     paint is instant and the build can never fail over a web font.
// For a locally-bundled Inter instead, add the .woff2 assets and swap in
// `next/font/local` — the system fallback below remains the crash-free default.

// ── ALPHA 5 PRO — PRODUCTION METADATA ──
export const metadata: Metadata = {
  title: {
    default: "Alpha.5 Pro — Live Trading Terminal",
    template: "%s | Alpha.5 Pro",
  },
  description:
    "ALPHA.5 PRO institutional trading terminal — real-time OTC forex & crypto signals, live candlestick charts, dynamic quantitative prediction engine, and automated risk management with kill-switch protection.",
  applicationName: "Alpha.5 Pro",
  keywords: [
    "Alpha 5 Pro",
    "trading terminal",
    "OTC forex",
    "crypto signals",
    "real-time prediction",
    "risk management",
  ],
};

export const viewport: Viewport = {
  themeColor: "#0B0E14",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  minimumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" className="dark" suppressHydrationWarning>
      <head>
        {/*
          ZERO-FLASH PRE-PAINT SCRIPTS (blocking, before first paint):
          1. THEME: reads localStorage → stamps class="dark|light" + color-scheme
             on <html>. Deep Charcoal obsidian (#0B0E14) is the default
             (institutional dark terminal); light mode remains a legacy escape
             hatch. No white/black flash on load.
          2. LANGUAGE: reads localStorage → stamps lang + dir on <html>.
             Arabic ("ar") forces full RTL instantly — no layout shift.
          Both scripts are self-contained IIFEs that never throw.
        */}
        <Script id="theme-prepaint" strategy="beforeInteractive">
          {THEME_PREPAINT_SCRIPT}
        </Script>
        <Script id="lang-prepaint" strategy="beforeInteractive">
          {LANG_PREPAINT_SCRIPT}
        </Script>
      </head>
      <body className="bg-obsidian dark:bg-obsidian text-slate-100 selection:bg-emerald-500/30 antialiased">
        <ThemeProvider>
          <LanguageProvider>
            <SocketProvider>
              <GlobalErrorBoundary />
              <HighConfidenceToast />
              {/*
                TOP-LEVEL RENDER GUARD: a real class ErrorBoundary that catches
                any render/commit error bubbling out of the child routes. Without
                it React unmounts the ENTIRE tree on an uncaught error, leaving a
                blank dark container (body keeps its #0F1420 background but every
                mounted UI component disappears). With it, the shell falls back to
                a readable error surface instead of absolute nothingness.
              */}
              <ErrorBoundary
                fallback={
                  <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-obsidian text-slate-100 p-6">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center">
                      <span className="text-white font-black text-sm">T</span>
                    </div>
                    <p className="text-xs font-mono text-slate-300 uppercase tracking-widest">
                      Alpha.5 Pro — Interface Error
                    </p>
                    <p className="text-[11px] font-mono text-slate-500 text-center max-w-md">
                      The trading interface failed to render. Reload the page to
                      reconnect to the terminal.
                    </p>
                  </div>
                }
              >
                {children}
              </ErrorBoundary>
            </SocketProvider>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
