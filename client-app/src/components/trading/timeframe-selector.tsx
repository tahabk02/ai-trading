"use client";

import React from "react";
import { SUPPORTED_TIMEFRAMES, type Timeframe } from "@/lib/realtimeCandleAggregator";
import { cn } from "@/utils/cn";

/**
 * PART 39 [374] — the chart's candle-build TIMEFRAME selector.
 *
 * The chart previously had NO timeframe control of its own: the only control
 * in that row was the LEAD offset (AUTO / 20S / 1M — projection horizon, not
 * resolution), and the grid could only be changed from the AI panel's select
 * or the settings page. This strip puts the full ladder on the chart.
 *
 * OPTIONS ARE DERIVED from `SUPPORTED_TIMEFRAMES`, never hand-listed, so every
 * frame the grid gains (W1/MN1 in [373], anything later) appears here without
 * a second list drifting. Styling reuses the `--term-*` tokens and the pill
 * pattern of the expiry horizon row (`horizon-selector.tsx`): active = inverted
 * ink, inactive = transparent with a hairline hover, never disabled — a locked
 * timeframe would silently strand a trader on the wrong resolution.
 */
interface TimeframeSelectorProps {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
  disabled?: boolean;
}

export const TimeframeSelector: React.FC<TimeframeSelectorProps> = ({
  value,
  onChange,
  disabled = false,
}) => (
  <div
    role="group"
    aria-label="Chart timeframe"
    data-testid="tf-selector"
    className="flex flex-wrap items-center gap-0.5"
  >
    <span className="text-term-ink-faint text-[8px] font-bold uppercase tracking-wider mr-0.5 whitespace-nowrap hidden sm:inline">
      TF
    </span>
    {SUPPORTED_TIMEFRAMES.map((tf) => (
      <button
        key={tf}
        type="button"
        disabled={disabled}
        data-testid={`tf-option-${tf}`}
        aria-pressed={tf === value}
        onClick={() => onChange(tf)}
        title={`Candle interval: ${tf}`}
        className={cn(
          "text-[9px] leading-none px-1.5 py-0.5 min-h-[20px] rounded-chip font-bold font-mono tracking-wider cursor-pointer border transition-[transform,background-color,color] duration-75 active:scale-90",
          tf === value
            ? "bg-term-ink text-term-canvas border-term-ink"
            : "bg-transparent text-term-ink-faint border-transparent hover:text-term-ink-dim hover:bg-term-panel",
          disabled && "opacity-40 cursor-not-allowed",
        )}
      >
        {tf}
      </button>
    ))}
  </div>
);

export default TimeframeSelector;
