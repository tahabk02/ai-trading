/**
 * chartDebug.ts — the chart's PART 3 debug surface for the 0.98 quality lock.
 *
 * Pure, DOM-free builder so the quality/candle keys written into
 * `window.__chartDebug` by FinancialChart can be unit-tested without a
 * browser. The chart spreads this object into its debug dump verbatim.
 */

export interface QualityPredictDebug {
  signal?: string | null;
  confidence?: number;
  quality?: number | null;
  quality_factors?: Record<string, number> | null;
  quality_reason?: string | null;
  quality_watershed_blocked?: boolean;
}

export interface ChartQualityDebugFields {
  quality: number;
  qualityFactors: Record<string, number> | null;
  qualityReason: string | null;
  qualityWatershedBlocked: boolean;
  candleCount: number;
}

/** Mirror the engine's 5-factor ensemble key names for the debug surface. */
export const CHART_QUALITY_FACTOR_KEYS = [
  "mtf",
  "momentum",
  "volatility",
  "volume",
  "pressure",
] as const;

/**
 * Build the PART 3 debug fields from a prediction payload + rendered candle
 * count. Missing/unavailable factor windows are reported as `null` (+ reason
 * "FACTOR_WINDOW_UNAVAILABLE") — the ensemble is honestly surfaced, never
 * fabricated on the client.
 */
export function chartDebugQualityFields(
  prediction: QualityPredictDebug | null | undefined,
  candleCount: number,
): ChartQualityDebugFields {
  const quality = prediction?.quality;
  const factors = prediction?.quality_factors ?? null;
  const reason = prediction?.quality_reason ?? null;
  return {
    quality:
      Number.isFinite(Number(quality)) && quality !== null ? Number(quality) : 0,
    qualityFactors: factors,
    qualityReason:
      reason ?? (quality !== null ? null : "FACTOR_WINDOW_UNAVAILABLE"),
    qualityWatershedBlocked:
      prediction?.quality_watershed_blocked ?? false,
    candleCount: Number.isFinite(Number(candleCount))
      ? Math.max(0, Math.floor(Number(candleCount)))
      : 0,
  };
}