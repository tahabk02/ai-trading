"use client";

import React from "react";
import { cn } from "@/utils/cn";
import {
  DEFAULT_EXECUTION_TIER,
  LOWEST_TRADABLE_TIER,
  MIN_EXECUTABLE_FLOOR_PCT,
  TIER_LABELS,
  type TierSelection,
} from "@/lib/signalTiers";
import { tierFloorClampNotice } from "@/lib/tierFilter";

interface ConfidenceFilterProps {
  /** The DERIVED executable bar (percent) — written by `setMinTier`, never dragged. */
  value: number;
  /** The tier that produced it, so the read-out can name its own source. */
  tier: TierSelection;
  hideBelow: boolean;
  onToggleHide: (value: boolean) => void;
}

/**
 * ConfidenceFilter — the executable-bar READ-OUT (PART 31 [309]/[311]).
 *
 * This used to be a draggable slider over 50..99%. It no longer is, and that is
 * deliberate: `resolveExecutionFloor` already derives the bar from the selected
 * tier, so an independently draggable value could contradict the tier it sat
 * next to — and could be parked BELOW T4's 70%, asking the engine for a bar
 * under LOWEST_TRADABLE_TIER. Same hazard as PART 34's force-override finding,
 * one layer up: the UI had become a back door around the engine's floor.
 *
 * So the control renders the floor and states where it came from. The TIER
 * selector is the only input; this is the honest consequence of it, with a
 * non-draggable meter so the bar's position on 0..100 stays legible.
 *
 * The "hide below bar" toggle is unaffected — it is a VIEW concern (physical
 * removal of demoted cards), not an executable-bar control.
 *
 * NOTE — this file's old DOM suite (`confidence-filter.dom.test.tsx`, 11 tests:
 * local draft, release-commits, 250ms trailing debounce, one-write-per-drag) was
 * DELETED with the drag, not kept as a signpost. A vitest file with no tests
 * fails the run ("No test suite found"), so a documentation-only file cannot
 * live here; and the only assertions it could carry were either vacuous
 * (`propTypes` is undefined on an arrow component whether or not the slider
 * exists) or already duplicated in the real replacements below. The two guards
 * that actually matter now live where they test something real:
 *   • `src/components/terminal/__tests__/tier-floor-readout.dom.test.tsx`
 *     — clicks the real tier buttons, asserts the DOM has no `range` input and
 *     no `role="slider"`, and that T5 reads 70.0% with the clamp copy visible;
 *   • `src/lib/__tests__/tierConfidenceSync.test.ts`
 *     — asserts the store exposes no `setMinConfidencePct` action at all.
 */
export const ConfidenceFilter: React.FC<ConfidenceFilterProps> = ({
  value,
  tier,
  hideBelow,
  onToggleHide,
}) => {
  // HYDRATION SAFETY: client-derived / persisted values (localStorage) are
  // invisible until mounted. The first SSR + first client frames BOTH render
  // the deterministic default, so React never sees mismatching text content
  // (the 96.5 vs 87.0 crash) and the interactive controls attach immediately.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const effectiveTier = mounted ? tier : DEFAULT_EXECUTION_TIER;
  const display = value.toFixed(1);
  const clampNotice = mounted ? tierFloorClampNotice(effectiveTier) : "";
  const isCustom = mounted && effectiveTier !== DEFAULT_EXECUTION_TIER;
  // Non-draggable meter: the fill is the bar's position on a 0..100 scale, so
  // "how permissive is this floor" is legible without implying it can be moved.
  const fillPct = Math.min(100, Math.max(0, value));

  return (
    <div className="flex items-center gap-2 select-none">
      <div
        className={cn(
          "relative flex items-center gap-1.5 pl-2 pr-3 py-1 rounded-chip border transition-colors",
          isCustom
            ? "border-st-warn/70 bg-st-warn/10 text-st-warn"
            : "border-term-line bg-term-panel/60 text-term-ink-dim",
        )}
        title={
          `Executable confidence bar — read from the ${effectiveTier} (${
            TIER_LABELS[effectiveTier]
          }) floor, not set by hand. Signals under ${display}% are demoted to ` +
          `SCORED-ONLY. The bar can never fall below ${LOWEST_TRADABLE_TIER} ` +
          `(${MIN_EXECUTABLE_FLOOR_PCT}%), so a WEAK band is never executable.`
        }
      >
        <span className="text-[8px] font-bold uppercase tracking-wider whitespace-nowrap">
          Conf
        </span>
        <span
          role="meter"
          aria-label={`Executable confidence floor from ${effectiveTier}`}
          aria-valuenow={value}
          aria-valuemin={MIN_EXECUTABLE_FLOOR_PCT}
          aria-valuemax={100}
          aria-valuetext={`${display} percent, from the ${effectiveTier} ${TIER_LABELS[effectiveTier]} floor`}
          className="relative block w-20 sm:w-24 h-1.5 rounded-full bg-term-line overflow-hidden"
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-amber-500"
            style={{ width: `${fillPct}%` }}
          />
        </span>
        <span className="num-fig text-[10px] font-black whitespace-nowrap tabular-nums">
          {display}%
        </span>
        <span className="text-[8px] font-bold uppercase tracking-wider whitespace-nowrap opacity-70">
          {effectiveTier}
        </span>
      </div>

      <button
        type="button"
        onClick={() => onToggleHide(!hideBelow)}
        aria-pressed={hideBelow}
        title={
          hideBelow
            ? "Showing only pairs at/above the confidence bar"
            : "Below-bar pairs stay visible (demoted) — hide them"
        }
        className={cn(
          "text-[8px] font-bold uppercase tracking-wider px-1.5 py-1 rounded-chip border transition-[transform,background-color,color] duration-75 active:scale-90 whitespace-nowrap cursor-pointer",
          hideBelow
            ? "bg-st-warn text-slate-950 border-st-warn"
            : "bg-transparent text-term-ink-faint border-term-line hover:text-term-ink-dim",
        )}
      >
        Hide&lt;{display}
      </button>

      {/* PART 31 [310] — a widened selection says so, in words, where the number is. */}
      {clampNotice && (
        <span
          className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-1 rounded-chip border border-slate-500/50 bg-slate-500/10 text-slate-400 whitespace-nowrap"
          title={clampNotice}
        >
          {clampNotice}
        </span>
      )}
    </div>
  );
};
