/**
 * signalExternalFloor.test.ts — PHASE 5 external (n8n) signal floor.
 *
 * The strict 96.5% engine bar is an INVARIANT: every engine-scored prediction
 * still clears it. What this pins is the NARROW, explicit carve-out — a
 * prediction tagged `dataSource: "n8n"` is judged against the external 60%
 * floor, and `gatePct` reports the EFFECTIVE threshold so the operator-facing
 * copy never lies about which bar was applied.
 */

import { describe, expect, it } from "vitest";
import {
  buildSignalView,
  signalGate,
  isExternalSignalPrediction,
  SIGNAL_CONFIDENCE_THRESHOLD,
  EXTERNAL_SIGNAL_FLOOR,
} from "../realtimeCandleAggregator";

describe("constants — the engine bar is untouched", () => {
  it("keeps the strict 96.5% engine threshold", () => {
    expect(SIGNAL_CONFIDENCE_THRESHOLD).toBe(0.965);
  });

  it("declares a 60% external floor", () => {
    expect(EXTERNAL_SIGNAL_FLOOR).toBe(0.6);
  });
});

describe("isExternalSignalPrediction", () => {
  it("recognizes the n8n tag on either key, case-insensitively", () => {
    expect(isExternalSignalPrediction({ dataSource: "n8n" })).toBe(true);
    expect(isExternalSignalPrediction({ source: "N8N" })).toBe(true);
    expect(isExternalSignalPrediction({ dataSource: " n8n " })).toBe(true);
  });

  it("rejects engine / missing / other tags", () => {
    expect(isExternalSignalPrediction({ dataSource: "engine" })).toBe(false);
    expect(isExternalSignalPrediction({})).toBe(false);
    expect(isExternalSignalPrediction(null)).toBe(false);
    expect(isExternalSignalPrediction(undefined)).toBe(false);
  });
});

describe("buildSignalView — engine verdicts keep the strict bar", () => {
  it("does NOT gate an engine 65% verdict", () => {
    const view = buildSignalView({ signal: "BUY", confidence: 65 });
    expect(view.gated).toBe(false);
    expect(view.gatedSignal).toBeNull();
    expect(view.gatePct).toBe(96.5);
    expect(view.badgeText).toContain("96.5");
  });

  it("gates an engine verdict at 96.5%", () => {
    const view = buildSignalView({ signal: "BUY", confidence: 96.5 });
    expect(view.gated).toBe(true);
    expect(view.gatedSignal).toBe("BUY");
  });
});

describe("buildSignalView — external verdicts use the 60% floor", () => {
  it("gates an n8n 65% verdict", () => {
    const view = buildSignalView({
      signal: "BUY",
      confidence: 65,
      dataSource: "n8n",
    });
    expect(view.gated).toBe(true);
    expect(view.gatedSignal).toBe("BUY");
    expect(view.gatePct).toBe(60);
  });

  it("honors the snake_case source tag too", () => {
    const view = buildSignalView({ signal: "SELL", confidence: 72, source: "n8n" });
    expect(view.gated).toBe(true);
    expect(view.gatedSignal).toBe("SELL");
  });

  it("gates exactly at the 60% boundary and refuses below it", () => {
    expect(
      buildSignalView({ signal: "BUY", confidence: 60, dataSource: "n8n" }).gated,
    ).toBe(true);
    const below = buildSignalView({
      signal: "BUY",
      confidence: 59.9,
      dataSource: "n8n",
    });
    expect(below.gated).toBe(false);
    // The refusal copy must name the 60% bar, not 96.5%.
    expect(below.badgeText).toContain("60");
  });

  it("normalizes a 0..1 fraction the same way", () => {
    const view = buildSignalView({ signal: "BUY", confidence: 0.65, dataSource: "n8n" });
    expect(view.confPct).toBe(65);
    expect(view.gated).toBe(true);
  });

  it("does not gate a neutral (null) external signal even above the floor", () => {
    const view = buildSignalView({ signal: "NEUTRAL", confidence: 80, dataSource: "n8n" });
    expect(view.gated).toBe(false);
  });
});

describe("signalGate — the floor is applied by the caller, gate itself is pure", () => {
  it("accepts an explicit external threshold", () => {
    expect(signalGate("BUY", 0.65, EXTERNAL_SIGNAL_FLOOR)).toBe(true);
    expect(signalGate("BUY", 0.65, SIGNAL_CONFIDENCE_THRESHOLD)).toBe(false);
  });
});
