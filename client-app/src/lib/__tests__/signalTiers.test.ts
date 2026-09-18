import { describe, it, expect } from "vitest";
import {
  resolveTier,
  normalizeTierConfidence,
  tierRank,
  tierAtLeast,
  targetCandlesEnabled,
  TIER_THRESHOLDS,
  TIER_ORDER,
  TIER_LABELS,
  TARGET_CANDLES_MIN_TIER,
  MIN_EXECUTABLE_TIER,
} from "@/lib/signalTiers";

describe("signalTiers — client mirror of the engine's multi-tier ladder (PART 6)", () => {
  it("threshold ladder EXACTLY mirrors signal_gatekeeper.py (T1 .965 / T2 .90 / T3 .80 / T4 .70)", () => {
    expect(TIER_THRESHOLDS.T1).toBe(0.965);
    expect(TIER_THRESHOLDS.T2).toBe(0.9);
    expect(TIER_THRESHOLDS.T3).toBe(0.8);
    expect(TIER_THRESHOLDS.T4).toBe(0.7);
    expect(TIER_ORDER).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(MIN_EXECUTABLE_TIER).toBe("T4");
    expect(TARGET_CANDLES_MIN_TIER).toBe("T3");
  });

  it("resolveTier maps fractional and percent confidence identically", () => {
    expect(resolveTier(0.97)).toBe("T1"); // ≥ 0.965
    expect(resolveTier(0.965)).toBe("T1");
    expect(resolveTier(96.5)).toBe("T1");
    expect(resolveTier(0.93)).toBe("T2");
    expect(resolveTier(90.0)).toBe("T2");
    expect(resolveTier(0.85)).toBe("T3");
    expect(resolveTier(80.0)).toBe("T3");
    expect(resolveTier(0.75)).toBe("T4");
    expect(resolveTier(70.0)).toBe("T4");
    expect(resolveTier(0.69)).toBe("T5"); // below T4 → WEAK
    expect(resolveTier(60.0)).toBe("T5");
  });

  it("normalizeTierConfidence keeps 0..1 unchanged and rescales 0..100", () => {
    expect(normalizeTierConfidence(0.75)).toBe(0.75);
    expect(normalizeTierConfidence(75)).toBe(0.75);
    expect(normalizeTierConfidence(96.5)).toBe(0.965);
    expect(normalizeTierConfidence(-5)).toBe(0);
    expect(normalizeTierConfidence(Number.NaN)).toBe(0);
  });

  it("tierRank ranks T1=4 … T5=0; unknown 0 (safe)", () => {
    expect(tierRank("T1")).toBe(4);
    expect(tierRank("t2")).toBe(3);
    expect(tierRank("T5")).toBe(0);
    expect(tierRank("")).toBe(0);
    expect(tierRank(null)).toBe(0);
    expect(tierRank("T9")).toBe(0);
  });

  it("tierAtLeast honours the ladder ordering", () => {
    expect(tierAtLeast("T1", "T3")).toBe(true);
    expect(tierAtLeast("T3", "T3")).toBe(true);
    expect(tierAtLeast("T4", "T3")).toBe(false);
    expect(tierAtLeast("T5", "T4")).toBe(false);
    expect(tierAtLeast(null)).toBe(false);
  });

  it("targetCandlesEnabled is true ONLY for T1–T3", () => {
    expect(targetCandlesEnabled("T1")).toBe(true);
    expect(targetCandlesEnabled("T2")).toBe(true);
    expect(targetCandlesEnabled("T3")).toBe(true);
    expect(targetCandlesEnabled("T4")).toBe(false);
    expect(targetCandlesEnabled("T5")).toBe(false);
    expect(targetCandlesEnabled(null)).toBe(false);
  });

  it("labels carry the engine vocabulary (PREMIUM/HIGH/MEDIUM/LOW/WEAK)", () => {
    expect(TIER_LABELS).toEqual({
      T1: "PREMIUM",
      T2: "HIGH",
      T3: "MEDIUM",
      T4: "LOW",
      T5: "WEAK",
    });
  });
});