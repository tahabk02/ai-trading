"use client";

import React from "react";
import type { AssetClassFilter } from "@/store/useMarketTerminalStore";
import { OTC_FOREX_PAIRS, REAL_FOREX_PAIRS } from "@/constants/symbols";
import { cn } from "@/utils/cn";

const FILTERS: { key: AssetClassFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "otc", label: "OTC" },
  { key: "real", label: "Real" },
  { key: "crypto", label: "Crypto" },
];

function countByFilter(f: AssetClassFilter): number {
  if (f === "all") return OTC_FOREX_PAIRS.length; // 44 (incl. 10 real)
  if (f === "real") return REAL_FOREX_PAIRS.length; // 10
  return OTC_FOREX_PAIRS.filter((p) => p.assetSubType === f).length;
}

interface AssetClassFilterProps {
  value: AssetClassFilter;
  onChange: (f: AssetClassFilter) => void;
}

export const AssetClassFilterPills: React.FC<AssetClassFilterProps> = ({
  value,
  onChange,
}) => (
  <div className="flex items-center gap-0.5">
    {FILTERS.map((f) => {
      const count = countByFilter(f.key);
      return (
        <button
          key={f.key}
          onClick={() => onChange(f.key)}
          aria-pressed={f.key === value}
          className={cn(
            "text-[9px] sm:text-[10px] px-2 py-0.5 rounded-chip font-bold tracking-wider transition-colors border",
            f.key === value
              ? "bg-term-ink text-term-canvas border-term-ink"
              : "bg-transparent text-term-ink-faint border-transparent hover:text-term-ink-dim",
          )}
        >
          {f.label}
          <span className="num-fig ml-1 opacity-70">{count}</span>
        </button>
      );
    })}
  </div>
);