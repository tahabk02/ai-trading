"use client";

/**
 * asset-class-badge.tsx — STRICT ASSET CLASSIFICATION BADGE (OTC vs REAL vs CRYPTO)
 *
 * Renders the authoritative asset class for a symbol as a compact pill:
 *   • OTC    — a Pocket Option OTC instrument (e.g. EUR/USD OTC). Distinct
 *              venue/pricing model, labelled explicitly with its OTC attribute.
 *   • REAL   — a standard (non-OTC) wholesale forex pair (PART 14/15), routed
 *              via the real ECB/Frankfurter + open.er-api feed.
 *   • CRYPTO — a crypto major routed via the crypto pipeline.
 *
 * The three classes are visually distinct and never mixed. Falls back to
 * no-badge (null) only when the symbol is empty.
 */

import React from "react";
import { getAssetSubType, REAL_FOREX_SET } from "@/constants/symbols";

export type AssetClassBadgeTone = "compact" | "chip";

interface AssetClassBadgeProps {
  symbol: string;
  /** "chip" = small bordered pill (default), "compact" = bare inline text. */
  variant?: AssetClassBadgeTone;
}

/** "REAL" label for the 10 PART 14/15 real-forex pairs; OTC/CRYPTO otherwise. */
export function assetClassBadgeLabel(symbol: string): string {
  const norm = String(symbol || "").trim().toUpperCase();
  if (REAL_FOREX_SET.has(norm)) return "REAL";
  const subType = getAssetSubType(norm);
  if (subType === "crypto") return "CRYPTO";
  return "OTC";
}

export function AssetClassBadge({
  symbol,
  variant = "chip",
}: AssetClassBadgeProps) {
  if (!symbol) return null;
  const label = assetClassBadgeLabel(symbol);

  if (variant === "compact") {
    return (
      <span className="text-[9px] font-mono uppercase tracking-widest font-black">
        {label}
      </span>
    );
  }

  const styles =
    label === "REAL"
      ? "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/40"
      : label === "CRYPTO"
        ? "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30"
        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-black leading-none uppercase tracking-widest ${styles}`}
    >
      {label}
    </span>
  );
}

export default AssetClassBadge;