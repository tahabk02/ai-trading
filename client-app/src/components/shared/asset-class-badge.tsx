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
      <span className="text-[9px] font-mono uppercase tracking-widest font-bold text-term-ink-faint">
        {label}
      </span>
    );
  }

  const styles =
    label === "REAL"
      ? "bg-gold/10 text-gold border-gold/40"
      : label === "CRYPTO"
        ? "bg-crypto/10 text-crypto border-crypto/40"
        : "bg-transparent text-term-ink-dim border-term-line";

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-chip border text-[9px] font-bold leading-none uppercase tracking-widest ${styles}`}
    >
      {label}
    </span>
  );
}

export default AssetClassBadge;