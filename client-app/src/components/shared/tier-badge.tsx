"use client";

import React from "react";
import { cn } from "@/utils/cn";
import {
  TIER_LABELS,
  type SignalTier,
  isTier,
  resolveTier,
} from "@/lib/signalTiers";

interface TierBadgeProps {
  tier?: string | null;
  /** Confidence (0..100 or 0..1) used to resolve the tier when absent. */
  confidence?: number | null;
  size?: "xs" | "sm";
  showLabel?: boolean;
  className?: string;
}

/** Color-coded tier badge — T1 green/emerald, T2 teal/cyan, T3 amber,
 *  T4 orange, T5 gray. Mirrors the AI Engine's dispatch tiers exactly. */
export const TierBadge: React.FC<TierBadgeProps> = ({
  tier,
  confidence,
  size = "xs",
  showLabel = true,
  className,
}) => {
  const resolved: SignalTier = isTier(tier)
    ? (tier as SignalTier)
    : resolveTier(Number(confidence) || 0);
  const label = TIER_LABELS[resolved];
  const base =
    "inline-flex items-center gap-1 font-black uppercase tracking-wider rounded-full border";
  const padding =
    size === "sm" ? "px-2.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[9px]";
  const palette: Record<SignalTier, string> = {
    T1: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
    T2: "bg-teal-500/15 text-teal-300 border-teal-400/40",
    T3: "bg-amber-500/15 text-amber-400 border-amber-500/40",
    T4: "bg-orange-500/15 text-orange-400 border-orange-500/40",
    T5: "bg-slate-500/15 text-slate-400 border-slate-500/40",
  };
  const dot: Record<SignalTier, string> = {
    T1: "bg-emerald-400",
    T2: "bg-teal-300",
    T3: "bg-amber-400",
    T4: "bg-orange-400",
    T5: "bg-slate-400",
  };
  return (
    <span
      title={`Tier ${resolved} — ${label}`}
      className={cn(base, padding, palette[resolved], className)}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", dot[resolved])} />
      {showLabel && <span>{label}</span>}
      <span className="opacity-80">{resolved}</span>
    </span>
  );
};