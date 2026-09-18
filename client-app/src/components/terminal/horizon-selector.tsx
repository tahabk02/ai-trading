"use client";

import React from "react";
import { HORIZON_MINUTES, type HorizonMinutes } from "@/store/useMarketTerminalStore";
import { cn } from "@/utils/cn";

interface HorizonSelectorProps {
  value: HorizonMinutes;
  onChange: (h: HorizonMinutes) => void;
  size?: "sm" | "md";
  disabled?: boolean;
}

const HORIZON_LABELS: Record<HorizonMinutes, string> = {
  1: "1m",
  2: "2m",
  3: "3m",
  5: "5m",
  10: "10m",
};

export const HorizonSelector: React.FC<HorizonSelectorProps> = ({
  value,
  onChange,
  size = "sm",
  disabled = false,
}) => {
  const pillClass =
    size === "sm"
      ? "text-[9px] px-1.5 py-0.5 min-h-[20px]"
      : "text-[10px] px-2 py-1 min-h-[28px]";

  return (
    <div className="flex items-center gap-0.5">
      <span className="text-slate-500 text-[8px] font-bold uppercase tracking-wider mr-0.5 whitespace-nowrap hidden sm:inline">
        H
      </span>
      {HORIZON_MINUTES.map((h) => (
        <button
          key={h}
          disabled={disabled}
          onClick={() => onChange(h)}
          className={cn(
            "rounded font-bold tracking-wider transition-colors border",
            pillClass,
            h === value
              ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
              : "bg-slate-800/30 text-slate-400 border-transparent hover:text-white hover:bg-slate-700/50",
            disabled && "opacity-40 cursor-not-allowed",
          )}
        >
          {HORIZON_LABELS[h]}
        </button>
      ))}
    </div>
  );
};
