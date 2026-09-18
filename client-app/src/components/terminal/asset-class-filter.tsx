"use client";

import React from "react";
import type { AssetClassFilter } from "@/store/useMarketTerminalStore";
import { OTC_FOREX_PAIRS } from "@/constants/symbols";
import { cn } from "@/utils/cn";

const FILTERS: { key: AssetClassFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "otc", label: "OTC" },
  { key: "crypto", label: "Crypto" },
];

function countByFilter(f: AssetClassFilter): number {
  if (f === "all") return OTC_FOREX_PAIRS.length;
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
          className={cn(
            "text-[9px] sm:text-[10px] px-2 py-0.5 rounded font-bold tracking-wider transition-colors border",
            f.key === value
              ? "bg-slate-800/80 text-slate-100 border-slate-700"
              : "bg-transparent text-slate-500 border-transparent hover:text-slate-300",
          )}
        >
          {f.label}
          <span className="ml-1 opacity-60">{count}</span>
        </button>
      );
    })}
  </div>
);
