"use client";

import React, { useEffect, useState } from "react";
import { cn } from "@/utils/cn";
import {
  DEFAULT_EXECUTION_TIER,
  TIER_LABELS,
  type TierSelection,
} from "@/lib/signalTiers";
import {
  TIER_SELECTIONS,
  resolveExecutionFloor,
  tierSelectionHint,
} from "@/lib/tierFilter";

interface TierSelectorProps {
  value: TierSelection;
  onCommit: (value: TierSelection) => void;
}

/**
 * TierSelector — "which signal bands do I want to trade?" (flexible tiers).
 *
 * The engine ALWAYS emits every computed tier T1..T5 with its true confidence,
 * direction and metadata. This control does NOT filter what you can see: it
 * chooses the floor below which a verdict is reported scored-only instead of
 * executable. That is what lets a trader opt into T2/T3/T4 activity without
 * anyone rewriting a tier label to hide it.
 *
 * T5 is offered because WEAK verdicts are worth watching — but its bar is
 * floored to T4 (70%), so a WEAK signal is never tradable. The hint text says
 * so explicitly rather than letting anyone assume "T5 selected = everything
 * trades".
 *
 * Commit is instant (the grid demotes live) and the terminal hook schedules a
 * debounced re-dispatch so the ENGINE re-evaluates against the new `min_tier`.
 */
export const TierSelector: React.FC<TierSelectorProps> = ({
  value,
  onCommit,
}) => {
  // HYDRATION SAFETY: the persisted selection is invisible until mounted, so
  // the first SSR and first client frames both render the deterministic T1
  // default. Without this, a persisted "T4" would mismatch during hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const effective = mounted ? value : DEFAULT_EXECUTION_TIER;
  const isCustom = mounted && value !== DEFAULT_EXECUTION_TIER;
  const floor = resolveExecutionFloor(effective);
  const barPct = (floor.barFrac * 100).toFixed(1);

  return (
    <div className="flex items-center gap-1 select-none">
      <div
        className={cn(
          "relative flex items-center gap-1 pl-2 pr-2 py-1 rounded-chip border transition-colors",
          isCustom
            ? "border-st-teal/70 bg-st-teal/10 text-st-teal"
            : "border-term-line bg-term-panel/60 text-term-ink-dim",
        )}
        title={`Tier Selector — trade signals from ${effective} (${TIER_LABELS[effective]}) and stronger. ${tierSelectionHint(effective)}`}
      >
        <span className="text-[8px] font-bold uppercase tracking-wider whitespace-nowrap">
          Tier
        </span>
        <div className="flex items-center gap-0.5" role="group" aria-label="Minimum signal tier to trade">
          {TIER_SELECTIONS.map((tier) => {
            const selected = tier === effective;
            return (
              <button
                key={tier}
                type="button"
                onClick={() => onCommit(tier)}
                aria-pressed={selected}
                title={`${tier} ${TIER_LABELS[tier]} — ${tierSelectionHint(tier)}`}
                className={cn(
                  "num-fig text-[9px] font-black px-1 py-0.5 rounded cursor-pointer transition-[transform,background-color,color] duration-75 active:scale-90",
                  selected
                    ? "bg-teal-500 text-slate-950"
                    : "bg-transparent text-term-ink-faint hover:text-term-ink-dim",
                )}
              >
                {tier}
              </button>
            );
          })}
        </div>
        <span className="num-fig text-[9px] font-semibold whitespace-nowrap tabular-nums">
          &ge;{barPct}%
        </span>
      </div>
      {floor.floored && (
        <span
          className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-1 rounded-chip border border-slate-500/50 bg-slate-500/10 text-slate-400 whitespace-nowrap"
          title="T5 is emitted and monitored, but the executable bar is floored at T4 (70%) so a WEAK signal can never trade."
        >
          T5 monitor
        </span>
      )}
    </div>
  );
};