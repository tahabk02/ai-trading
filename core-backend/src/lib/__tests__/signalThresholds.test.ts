import { describe, expect, it } from "vitest";
import {
  HIGH_CONFIDENCE_ALERT_THRESHOLD,
  MIN_EXECUTABLE_CONFIDENCE,
  isHighConfidence,
} from "../signalThresholds";

describe("host-side signal thresholds", () => {
  it("mirrors the AI Engine's 90% alert and T4-LOW 80% execution contracts", () => {
    expect(HIGH_CONFIDENCE_ALERT_THRESHOLD).toBe(90);
    expect(MIN_EXECUTABLE_CONFIDENCE).toBe(80);
  });

  it("uses the AI Engine's strict greater-than alert comparison", () => {
    expect(isHighConfidence(90)).toBe(false);
    expect(isHighConfidence(90.01)).toBe(true);
    expect(isHighConfidence(Number.NaN)).toBe(false);
  });
});
