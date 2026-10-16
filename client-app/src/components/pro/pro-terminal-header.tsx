"use client";

import React, { memo } from "react";
import { ProControlBar } from "@/components/pro/pro-control-bar";
import { StandaloneBadge } from "@/components/trading/standalone-badge";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PRO TERMINAL HEADER — the terminal toolbar (engine status · symbol · focus)
 *  with the ProControlBar command row beneath it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Extracted verbatim from the inline <nav> in pro/page.tsx. The engine status
 * used to be rendered TWICE in that nav (a verbose left chip AND a "Sync"
 * right cluster, both driven by the same state) — this collapses them into a
 * single EngineStatus chip, so the two indicators can never disagree.
 *
 * Memoized: its props are all low-frequency (connection transitions, symbol
 * submit, focus toggle). Live ticks never reach it.
 */

interface ProTerminalHeaderProps {
  /* Connection state, already derived by the page from useWebSocket(). */
  engineLive: boolean;
  enginePending: boolean;
  engineLabel: string;
  statusDetail?: string;

  /* Symbol form. */
  selectedSymbol: string;
  onSymbolChange: (value: string) => void;
  onSymbolSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  predictionLoading: boolean;

  /* Chart focus-mode toggle. */
  focusMode: boolean;
  onToggleFocusMode: () => void;

  /* Forwarded to the control bar (which owns tier/expiry/auto state). */
  timeframe: string;
}

function ProTerminalHeaderImpl({
  engineLive,
  enginePending,
  engineLabel,
  statusDetail,
  selectedSymbol,
  onSymbolChange,
  onSymbolSubmit,
  predictionLoading,
  focusMode,
  onToggleFocusMode,
  timeframe,
}: ProTerminalHeaderProps) {
  const engineColor = engineLive
    ? "bg-emerald-500"
    : enginePending
      ? "bg-amber-400"
      : "bg-rose-500";

  const symbol = (selectedSymbol || "").toUpperCase();

  return (
    <nav className="border-b border-slate-800/80 bg-obsidian/80 backdrop-blur-md sticky top-0 z-30 shrink-0">
      <div className="max-w-full mx-auto px-3 sm:px-4 md:px-6 h-14 sm:h-16 flex items-center justify-between">
        <div className="flex items-center gap-2 sm:gap-4">
          <h2 className="text-slate-100 font-bold text-[10px] sm:text-xs md:text-sm tracking-widest uppercase hidden xs:inline">
            Pro Terminal
          </h2>
          <div className="w-px h-4 bg-slate-800 hidden xs:block" />
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div
              className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${engineColor} ${enginePending ? "animate-pulse" : ""}`}
              title={statusDetail}
            />
            <span
              className="text-[9px] sm:text-[10px] font-mono text-slate-500 uppercase tracking-tighter"
              title={statusDetail}
            >
              <span className="hidden xs:inline">Engine: {engineLabel}</span>
              <span className="xs:hidden">
                {engineLive ? "ON" : enginePending ? "..." : "OFF"}
              </span>
            </span>
          </div>
          {/* STANDALONE SaaS MODE disclosure — visible whenever the fallback
              feed is serving (real public proxy / labeled synthetic OTC). */}
          <StandaloneBadge />
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          <form
            onSubmit={onSymbolSubmit}
            className="flex items-center gap-1 sm:gap-2"
          >
            <input
              name="symbol"
              type="text"
              placeholder="BTC/USDT"
              value={selectedSymbol}
              onChange={(e) => onSymbolChange(e.target.value)}
              className="w-20 sm:w-24 md:w-28 bg-obsidian-950/80 border border-slate-700 rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs text-slate-100 font-mono placeholder-slate-500 focus:outline-none focus:border-emerald-500 min-h-[36px] sm:min-h-[40px]"
            />
            <button
              type="submit"
              disabled={predictionLoading}
              className="text-[10px] bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white font-bold px-2 sm:px-3 py-1.5 rounded-lg transition-all min-h-[36px] sm:min-h-[40px]"
            >
              {predictionLoading ? (
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span className="hidden xs:inline">...</span>
                </span>
              ) : (
                "Go"
              )}
            </button>
          </form>
          {/*
            FOCUS MODE — one click to an isolated, full-viewport chart. A plain
            button in the toolbar rather than a floating overlay (an overlay sits
            ON the canvas and occludes candles), and it stays reachable while the
            centre column scrolls.
          */}
          <button
            type="button"
            onClick={onToggleFocusMode}
            aria-pressed={focusMode}
            title={
              focusMode
                ? "Exit chart focus — show side rails"
                : "Focus chart — hide side rails"
            }
            data-testid="focus-mode-toggle"
            className={
              "text-[10px] font-bold px-2 sm:px-3 py-1.5 rounded-lg transition-all min-h-[36px] sm:min-h-[40px] shrink-0 " +
              (focusMode
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-obsidian-950/80 border border-slate-700 text-slate-300 hover:border-emerald-500/60 hover:text-emerald-400")
            }
          >
            <span className="hidden xs:inline">
              {focusMode ? "Exit Focus" : "Focus"}
            </span>
            <span className="xs:hidden">{focusMode ? "Exit" : "Foc"}</span>
          </button>
        </div>
      </div>

      {/* Command row — tiers / mode actions / expiry selector. */}
      <ProControlBar symbol={symbol} timeframe={timeframe} />
    </nav>
  );
}

export const ProTerminalHeader = memo(ProTerminalHeaderImpl);
export default ProTerminalHeader;
