import { describe, expect, it } from "vitest";
import {
  analyzeMarketRegime,
  inferMarketClass,
  regimeConfidenceMultiplier,
} from "../marketRegime";

function linear(count: number, start = 1, step = 0.01): number[] {
  return Array.from({ length: count }, (_, i) => start + i * step);
}

describe("marketRegime", () => {
  it("infers OTC, crypto and real classes", () => {
    expect(inferMarketClass("EURUSD_otc")).toBe("otc");
    expect(inferMarketClass("BTC/USD")).toBe("crypto");
    expect(inferMarketClass("EUR/USD")).toBe("real");
  });

  it("allows a clean directional trend", () => {
    const verdict = analyzeMarketRegime({
      symbol: "EUR/USD",
      prices: linear(60),
    });
    expect(verdict.regime).toBe("trending");
    expect(verdict.gate).toBe("allow");
    expect(verdict.tradable).toBe(true);
    expect(regimeConfidenceMultiplier(verdict)).toBeGreaterThan(0.9);
  });

  it("blocks a flat tape", () => {
    const verdict = analyzeMarketRegime({
      symbol: "EUR/USD",
      prices: Array.from({ length: 60 }, () => 1.085),
    });
    expect(verdict.regime).toBe("consolidation");
    expect(verdict.gate).toBe("block");
    expect(verdict.tradable).toBe(false);
    expect(regimeConfidenceMultiplier(verdict)).toBe(0);
  });

  it("reports caution when there are too few samples", () => {
    const verdict = analyzeMarketRegime({
      symbol: "EURUSD_otc",
      prices: [1, 1.001, 1.002],
    });
    expect(verdict.regime).toBe("insufficient_data");
    expect(verdict.gate).toBe("caution");
    expect(verdict.tradable).toBe(true);
  });

  it("detects OTC round-number mean reversion", () => {
    const prices = [
      1.0912, 1.0901, 1.0893, 1.0904, 1.0891, 1.0888, 1.0902, 1.089, 1.0885,
      1.0898, 1.0889, 1.0899, 1.0886, 1.0895,
    ];
    const verdict = analyzeMarketRegime({ symbol: "EURUSD_otc", prices });
    expect(["mean_reverting", "random_walk"]).toContain(verdict.regime);
    expect(verdict.metrics.samples).toBe(prices.length);
  });
});
