"use client";

import { useTradingStore } from "@/store/useTradingStore";
import { cn } from "@/utils/cn";

/**
 * StandaloneBadge — the STANDALONE SaaS MODE disclosure.
 *
 * Rendered whenever the backend is serving the fallback tape (PO bridge not
 * live). It is the honest counterpart to the removed hard "PO OFFLINE" blocker:
 * the tape is flowing, execution is enabled, but the operator is TOLD where the
 * price comes from —
 *
 *   • STANDALONE · PUBLIC PROXY   — a real public feed (Yahoo/Frankfurter/…)
 *   • STANDALONE · SIMULATED (OTC) — the labeled synthetic OTC generator
 *
 * It renders nothing outside standalone mode.
 */
export function StandaloneBadge({ className }: { className?: string }) {
  const feedStatus = useTradingStore((s) => s.feedStatus);
  const feedMode = useTradingStore((s) => s.feedMode);

  if (feedStatus !== "standalone") return null;

  const syntheticOnly = feedMode === "standalone_synthetic";
  const label = syntheticOnly
    ? "STANDALONE · SIMULATED (OTC)"
    : "STANDALONE · PUBLIC PROXY";
  const title = syntheticOnly
    ? "Pocket Option offline — OTC prices are a LABELED SIMULATION anchored to the real pair. This is not live Pocket Option data."
    : "Pocket Option offline — prices come from a real public proxy feed, not live Pocket Option data.";

  return (
    <span
      data-testid="standalone-feed-badge"
      title={title}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider whitespace-nowrap",
        syntheticOnly
          ? "bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/40"
          : "bg-sky-500/15 text-sky-300 border border-sky-500/40",
        className,
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse shrink-0" />
      {label}
    </span>
  );
}
