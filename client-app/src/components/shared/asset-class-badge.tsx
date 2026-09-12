"use client";

/**
 * asset-class-badge.tsx — STRICT ASSET CLASSIFICATION BADGE (OTC vs FOREX vs CRYPTO)
 *
 * Renders the authoritative asset class for a symbol as a compact pill:
 *   • OTC    — a Pocket Option OTC instrument (e.g. EUR/USD OTC). Distinct
 *              venue/pricing model, labelled explicitly with its OTC attribute.
 *   • FOREX  — a standard (non-OTC) wholesale forex pair.
 *   • CRYPTO — a crypto major routed via the crypto pipeline.
 *
 * The three classes are visually distinct and never mixed. Falls back to
 * no-badge (null) only when the symbol is empty.
 */

import React from "react";
import { getAssetSubType } from "@/constants/symbols";

export type AssetClassBadgeTone = "compact" | "chip";

interface AssetClassBadgeProps {
  symbol: string;
  /** "chip" = small bordered pill (default), "compact" = bare inline text. */
  variant?: AssetClassBadgeTone;
}

export function AssetClassBadge({
  symbol,
  variant = "chip",
}: AssetClassBadgeProps) {
  const assetSubType = getAssetSubType(symbol || "");
  if (!symbol) return null;

  if (variant === "compact") {
    return (
      <span className="text-[9px] font-mono uppercase tracking-widest font-black">
        {assetSubType}
      </span>
    );
  }

  const styles =
    assetSubType === "crypto"
      ? "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30"
      : assetSubType === "forex"
        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30"
        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-black leading-none uppercase tracking-widest ${styles}`}
    >
      {assetSubType}
    </span>
  );
}

export default AssetClassBadge;