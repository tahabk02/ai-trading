"use client";

import React, { useEffect, useState } from "react";
import { cn } from "@/utils/cn";
import {
  MIN_CONFIDENCE_DEFAULT_PCT,
  MIN_CONFIDENCE_LOW_PCT,
  MIN_CONFIDENCE_HIGH_PCT,
} from "@/lib/minConfidenceFilter";

interface ConfidenceFilterProps {
  value: number;
  hideBelow: boolean;
  onCommit: (value: number) => void;
  onToggleHide: (value: boolean) => void;
}

/**
 * ConfidenceFilter — the Confidence Filter control (Alpha.5 Pro).
 *
 * A compact slider (50..99%, step 0.5) + live % readout + an optional
 * "hide below bar" toggle.
 *
 * DRAG HANDOFF: the thumb and the numeric readout track the pointer
 * INSTANTLY through a local `draft` value, but the store commit is DEFERRED
 * to pointer/key release. Committing every `onChange` meant ~98 synchronous
 * store writes plus 98 grid re-filters for one full-width drag (50.0 -> 99.0
 * at step 0.5), each one notifying all 44 quote cards. The operator now gets
 * the same zero-latency visual feedback for one write per gesture.
 *
 * A 250ms trailing debounce is kept as a safety net for input methods that
 * never fire a release event (assistive tech, synthetic events).
 */
export const ConfidenceFilter: React.FC<ConfidenceFilterProps> = ({
  value,
  hideBelow,
  onCommit,
  onToggleHide,
}) => {
  // HYDRATION SAFETY: client-derived / persisted values (localStorage) are
  // invisible until mounted. The first SSR + first client frames BOTH render
  // the deterministic default, so React never sees mismatching text content
  // (the 96.5 vs 87.0 crash) and the interactive controls attach immediately.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const committed = mounted ? value : MIN_CONFIDENCE_DEFAULT_PCT;
  const isCustom = mounted && value !== MIN_CONFIDENCE_DEFAULT_PCT;

  // Local optimistic thumb value: moves with the pointer at frame rate while
  // the (expensive) store commit waits for the gesture to end.
  const [draft, setDraft] = useState<number | null>(null);
  const effective = draft ?? committed;
  const display = effective.toFixed(1);

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDebounce = () => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };

  // Pointer/key release: publish the draft and drop the trailing timer.
  const commit = React.useCallback(() => {
    clearDebounce();
    setDraft((current) => {
      if (current !== null && current !== committed) onCommit(current);
      return null;
    });
  }, [committed, onCommit]);

  // Every movement updates the local value only.
  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = parseFloat(e.target.value);
    setDraft(next);
    clearDebounce();
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setDraft((current) => {
        if (current !== null && current !== committed) onCommit(current);
        return null;
      });
    }, 250);
  };

  useEffect(() => clearDebounce, []);

  return (
    <div className="flex items-center gap-2 select-none">
      <div
        className={cn(
          "relative flex items-center gap-1 pl-2 pr-3 py-1 rounded-chip border transition-colors",
          isCustom
            ? "border-st-warn/70 bg-st-warn/10 text-st-warn"
            : "border-term-line bg-term-panel/60 text-term-ink-dim",
        )}
        title="Confidence Filter — minimum executable confidence. Below-bar pairs are demoted to SCORED-ONLY (engine floors the bar at 70%)."
      >
        <span className="text-[8px] font-bold uppercase tracking-wider whitespace-nowrap">
          Conf
        </span>
        <input
          type="range"
          min={MIN_CONFIDENCE_LOW_PCT}
          max={MIN_CONFIDENCE_HIGH_PCT}
          step={0.5}
          value={effective}
          onChange={handleInput}
          onPointerUp={commit}
          onPointerCancel={commit}
          onKeyUp={commit}
          onBlur={commit}
          aria-label="Minimum executable confidence"
          className="w-20 sm:w-24 cursor-pointer accent-amber-500"
        />
        <span className="num-fig text-[10px] font-black whitespace-nowrap tabular-nums">
          {display}%
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
    </div>
  );
};