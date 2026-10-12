/**
 * minConfidenceFilter.test.ts — CONFIDENCE FILTER (Alpha.5 Pro).
 *
 * Proves the client-side contract shared by the terminal toolbar + cards:
 *   • clampMinConfidencePct — the bar is HARD-FLOORED at
 *     MIN_EXECUTABLE_FLOOR_PCT (70.0%, i.e. LOWEST_TRADABLE_TIER) and capped at
 *     99. PART 31 [311] removed the free 50..99 drag; anything below the floor
 *     is RAISED, not honoured.
 *   • cardEffectiveConfidence — horizon wins over live; only strictly positive
 *     confidences are measurable (0 = market-waiting convention).
 *   • isBelowConfidenceBar — strictly-below demotion; at/above the bar and
 *     waiting cards are never hidden behind the filter.
 *   • store integration — the store derives the bar from the tier and honors the
 *     hide-below toggle in the node (no-window) environment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MIN_CONFIDENCE_DEFAULT_PCT,
  MIN_CONFIDENCE_HIGH_PCT,
  MIN_EXECUTABLE_FLOOR_PCT,
  clampMinConfidencePct,
  cardEffectiveConfidence,
  isBelowConfidenceBar,
} from "@/lib/minConfidenceFilter";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";

describe("clampMinConfidencePct", () => {
  it("keeps in-range values untouched", () => {
    expect(clampMinConfidencePct(96.5)).toBe(96.5);
    expect(clampMinConfidencePct(MIN_EXECUTABLE_FLOOR_PCT)).toBe(
      MIN_EXECUTABLE_FLOOR_PCT,
    );
    expect(clampMinConfidencePct(99)).toBe(99);
    expect(clampMinConfidencePct(80.5)).toBe(80.5);
  });

  it("RAISES anything below the LOWEST_TRADABLE_TIER floor instead of honouring it", () => {
    // PART 31 [311]: the retired slider's 50..99 range included sub-70% values,
    // which would have asked the engine for a bar under T4.
    for (const below of [20, 50, 60, 69.9, 0]) {
      expect(clampMinConfidencePct(below)).toBe(MIN_EXECUTABLE_FLOOR_PCT);
    }
    expect(clampMinConfidencePct(-5)).toBe(MIN_EXECUTABLE_FLOOR_PCT);
  });

  it("caps at 99", () => {
    expect(clampMinConfidencePct(120)).toBe(MIN_CONFIDENCE_HIGH_PCT);
    expect(clampMinConfidencePct(99.9)).toBe(MIN_CONFIDENCE_HIGH_PCT);
  });

  it("falls back on missing / non-finite input", () => {
    expect(clampMinConfidencePct(undefined)).toBe(MIN_CONFIDENCE_DEFAULT_PCT);
    expect(clampMinConfidencePct(null)).toBe(MIN_CONFIDENCE_DEFAULT_PCT);
    expect(clampMinConfidencePct(Number.NaN)).toBe(MIN_CONFIDENCE_DEFAULT_PCT);
    // Non-finite is treated as absent (there is no honest bar of Infinity),
    // so it takes the fallback rather than being clamped up to the 99 cap.
    expect(clampMinConfidencePct(Number.POSITIVE_INFINITY)).toBe(
      MIN_CONFIDENCE_DEFAULT_PCT,
    );
    expect(clampMinConfidencePct(Number.NEGATIVE_INFINITY)).toBe(
      MIN_CONFIDENCE_DEFAULT_PCT,
    );
  });

  it("floors an explicit sub-70% FALLBACK too — the floor is not a default", () => {
    expect(clampMinConfidencePct(undefined, 10)).toBe(MIN_EXECUTABLE_FLOOR_PCT);
  });
});

describe("cardEffectiveConfidence", () => {
  it("prefers the horizon prediction confidence", () => {
    expect(cardEffectiveConfidence(92.5, 88.0)).toBe(92.5);
  });

  it("falls back to the live micro-quant verdict", () => {
    expect(cardEffectiveConfidence(null, 88.0)).toBe(88.0);
    expect(cardEffectiveConfidence(undefined, 88.0)).toBe(88.0);
  });

  it("treats 0 / missing as unmeasurable (market-waiting), never hides", () => {
    expect(cardEffectiveConfidence(null, null)).toBeNull();
    expect(cardEffectiveConfidence(null, 0)).toBeNull();
    expect(cardEffectiveConfidence(0, undefined)).toBeNull();
    expect(cardEffectiveConfidence(Number.NaN, 80)).toBe(80);
  });
});

describe("isBelowConfidenceBar", () => {
  it("demotes only strictly-below measurable confidences", () => {
    expect(isBelowConfidenceBar(80, 96.5)).toBe(true);
    expect(isBelowConfidenceBar(96.4, 96.5)).toBe(true);
    // EXACTLY at the bar is passable (>= semantics, mirrors the engine).
    expect(isBelowConfidenceBar(96.5, 96.5)).toBe(false);
    expect(isBelowConfidenceBar(98, 96.5)).toBe(false);
  });

  it("respects a lowered bar", () => {
    expect(isBelowConfidenceBar(90, 90)).toBe(false);
    expect(isBelowConfidenceBar(89.9, 90)).toBe(true);
    expect(isBelowConfidenceBar(70, 70)).toBe(false);
  });

  it("never treats waiting / absent confidences as below-the-bar", () => {
    expect(isBelowConfidenceBar(null, 96.5)).toBe(false);
    expect(isBelowConfidenceBar(undefined, 96.5)).toBe(false);
    expect(isBelowConfidenceBar(0, 96.5)).toBe(false);
    expect(isBelowConfidenceBar(-1, 96.5)).toBe(false);
  });
});

describe("useMarketTerminalStore — Confidence Filter state", () => {
  beforeEach(() => {
    // Reset to the default tier so tests are order-independent. The bar is
    // DERIVED (PART 31 [309]) so there is no bar setter left to reset.
    useMarketTerminalStore.getState().setMinTier("T1");
    useMarketTerminalStore.getState().setHideBelowThreshold(false);
  });

  it("hydrates with the engine's default T1 floor (96.5%, no window in node)", () => {
    const s = useMarketTerminalStore.getState();
    expect(s.minTier).toBe("T1");
    expect(s.minConfidencePct).toBe(MIN_CONFIDENCE_DEFAULT_PCT);
    expect(s.hideBelowThreshold).toBe(false);
  });

  it("setHideBelowThreshold reflects immediately", () => {
    useMarketTerminalStore.getState().setHideBelowThreshold(true);
    expect(useMarketTerminalStore.getState().hideBelowThreshold).toBe(true);
    useMarketTerminalStore.getState().setHideBelowThreshold(false);
    expect(useMarketTerminalStore.getState().hideBelowThreshold).toBe(false);
  });

  it("store init stays deterministic even when a persisted tier exists", () => {
    // Simulate a returning operator whose localStorage says T4 — the source of
    // the SSR hydration mismatch (server 96.5 vs client 70.0). The bar follows
    // the tier, so it is the tier's disagreement that must not leak pre-paint.
    const store = { getItem: () => "T4", setItem: () => {}, removeItem: () => {} };
    (globalThis as Record<string, unknown>).window = { localStorage: store };
    try {
      // Re-populate state the way a fresh page load would: module init order
      // is deterministic (T1 / 96.5), NOT the persisted override.
      useMarketTerminalStore.setState({
        minTier: "T1",
        minConfidencePct: clampMinConfidencePct(undefined),
        hideBelowThreshold: false,
      } as never);
      expect(useMarketTerminalStore.getState().minConfidencePct).toBe(96.5);
      // The persisted value is applied ONLY via the post-hydration action the
      // terminal hook calls after first paint.
      useMarketTerminalStore.getState().hydrateClientPreferences();
      expect(useMarketTerminalStore.getState().minTier).toBe("T4");
      expect(useMarketTerminalStore.getState().minConfidencePct).toBe(70);
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("hydrateClientPreferences applies a persisted hide-below toggle", () => {
    const store = {
      getItem: (k: string) => (k === "terminal_hide_below_threshold" ? "1" : null),
      setItem: () => {},
      removeItem: () => {},
    };
    (globalThis as Record<string, unknown>).window = { localStorage: store };
    try {
      expect(useMarketTerminalStore.getState().hideBelowThreshold).toBe(false);
      useMarketTerminalStore.getState().hydrateClientPreferences();
      expect(useMarketTerminalStore.getState().hideBelowThreshold).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });
});