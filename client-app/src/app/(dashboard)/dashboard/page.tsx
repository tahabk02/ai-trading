"use client";

import { Header } from "@/components/shared/header";
import { MarketTerminal } from "@/components/terminal/market-terminal";

/**
 * MARKET TERMINAL — the all-pairs grid dashboard (Alpha.5 Pro).
 *
 * Renders every OTC/crypto instrument side-by-side, streaming live quotes +
 * micro-quant CALL/PUT verdicts over ONE WS channel and refreshing per-horizon
 * `/multi-predict` batches on demand. The single-asset deep-dive (chart +
 * order book + intelligence) moved to `/pro`.
 */
export default function DashboardPage() {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-obsidian text-slate-300 font-sans selection:bg-emerald-500/30 transition-colors duration-200">
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        <Header />
        <main className="flex-1 min-h-0 overflow-hidden">
          <MarketTerminal />
        </main>
      </div>
    </div>
  );
}