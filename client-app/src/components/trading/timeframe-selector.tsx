"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { SUPPORTED_TIMEFRAMES, type Timeframe } from "@/lib/realtimeCandleAggregator";
import { cn } from "@/utils/cn";

/**
 * PART 39 [374] — the chart's candle-build TIMEFRAME selector.
 *
 * The full PO ladder is derived from `SUPPORTED_TIMEFRAMES`, never a second
 * hand-written list. The strip used to spend the whole top-left of the chart on
 * 16 tiny pills; it now collapses into one compact trigger with a grid popover,
 * so the price action gets the space back while every frame stays one click
 * away. Options are never disabled — a locked timeframe would silently strand a
 * trader on the wrong resolution.
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
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pick = (tf: Timeframe) => {
    setOpen(false);
    onChange(tf);
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-tf-option]",
      ) ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(current + 1 + buttons.length) % buttons.length].focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(current - 1 + buttons.length) % buttons.length].focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0].focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1].focus();
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        data-testid="tf-trigger"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Candle timeframe ${value}. Open timeframe menu`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group flex h-7 items-center gap-1.5 rounded-control border pl-2 pr-1.5 shadow-card transition-all duration-150 active:scale-95",
          open
            ? "border-primary/60 bg-primary/10 text-ink"
            : "border-line bg-surface text-ink-muted hover:border-primary/40 hover:text-ink",
          disabled && "cursor-not-allowed opacity-40",
        )}
      >
        <span className="text-[8px] font-bold uppercase tracking-[0.16em] text-ink-faint">
          TF
        </span>
        <span className="text-[11px] font-mono font-black tabular-nums text-ink">
          {value}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2.5}
          className={cn(
            "text-ink-faint transition-transform duration-150 group-hover:text-ink-muted",
            open && "rotate-180 text-primary",
          )}
        />
      </button>

      <div
        ref={menuRef}
        id={menuId}
        role="group"
        aria-label="Chart timeframe"
        data-testid="tf-selector"
        onKeyDown={onMenuKeyDown}
        className={cn(
          "absolute left-0 top-full z-30 mt-1.5 w-56 origin-top-left rounded-card border border-line bg-surface p-2 shadow-card-lift transition-all duration-150",
          open
            ? "visible translate-y-0 opacity-100"
            : "invisible -translate-y-1 opacity-0",
        )}
      >
        <div className="flex items-center justify-between px-1 pb-1.5">
          <span className="text-[8px] font-bold uppercase tracking-[0.18em] text-ink-faint">
            Candle interval
          </span>
          <span className="font-mono text-[8px] text-ink-faint">
            {SUPPORTED_TIMEFRAMES.length} frames
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {SUPPORTED_TIMEFRAMES.map((tf) => {
            const active = tf === value;
            return (
              <button
                key={tf}
                type="button"
                data-tf-option
                data-testid={`tf-option-${tf}`}
                aria-pressed={active}
                tabIndex={open ? 0 : -1}
                disabled={disabled}
                title={`Candle interval: ${tf}`}
                onClick={() => pick(tf)}
                className={cn(
                  "relative flex h-8 items-center justify-center rounded-control border font-mono text-[10px] font-bold tabular-nums transition-all duration-100 active:scale-95",
                  active
                    ? "border-primary bg-primary text-white shadow-[0_0_12px_rgba(37,99,235,0.35)]"
                    : "border-transparent bg-transparent text-ink-muted hover:border-line hover:bg-elevated hover:text-ink",
                  disabled && "cursor-not-allowed opacity-40",
                )}
              >
                {tf}
                {active ? (
                  <Check
                    size={8}
                    strokeWidth={3.5}
                    className="absolute right-1 top-1 opacity-80"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default TimeframeSelector;
