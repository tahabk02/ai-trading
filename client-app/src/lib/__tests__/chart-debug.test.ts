/**
 * chart-debug.test.ts — PART 3 verification surface of the FinancialChart
 * debug dump. The chart spreads `chartDebugQualityFields` (src/lib/chartDebug.ts)
 * into `window.__chartDebug`, so these pure tests lock the exact keys the
 * chart writes: rendered candle count + the 0.98 quality/factor mirrors.
 */

import { describe, expect, it } from "vitest";
import {
  chartDebugQualityFields,
  CHART_QUALITY_FACTOR_KEYS,
  type QualityPredictDebug,
} from "@/lib/chartDebug";

const prediction: QualityPredictDebug = {
  signal: "BUY",
  confidence: 99.3,
  quality: 1,
  quality_factors: {
    mtf: 1,
    momentum: 1,
    volatility: 1,
    volume: 1,
    pressure: 1,
  },
  quality_reason: "ALL_FACTORS_ALIGNED",
  quality_watershed_blocked: false,
};

describe("financial-chart __chartDebug (0.98 quality lock)", () => {
  it("test_chart_debug_has_candles", () => {
    const debug = chartDebugQualityFields(prediction, 48);
    expect(Object.prototype.hasOwnProperty.call(debug, "candleCount")).toBe(true);
    expect(Number.isFinite(debug.candleCount)).toBe(true);
    expect(debug.candleCount).toBe(48);
    // Missing/rejected inputs never fabricate a count.
    expect(chartDebugQualityFields(null, NaN).candleCount).toBe(0);
  });

  it("test_chart_debug_has_quality_factors", () => {
    const debug = chartDebugQualityFields(prediction, 48);
    expect(Object.prototype.hasOwnProperty.call(debug, "quality")).toBe(true);
    expect(debug.quality).toBe(1);
    expect(debug.qualityFactors).toEqual(prediction.quality_factors);
    for (const key of CHART_QUALITY_FACTOR_KEYS) {
      expect(debug.qualityFactors?.[key]).toBeDefined();
    }
    expect(debug.qualityReason).toBe("ALL_FACTORS_ALIGNED");
    expect(debug.qualityWatershedBlocked).toBe(false);
  });
});