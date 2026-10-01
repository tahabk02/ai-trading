/**
 * minConfidenceFilter.test.ts — CONFIDENCE FILTER (Alpha.5 Pro).
 *
 * Proves the client-side contract shared by the terminal toolbar + cards:
 *   • clampMinConfidencePct — the operator bar lives in 50..99, anything else
 *     (out-of-range, NaN, missing) falls back to the safe value.
 *   • cardEffectiveConfidence — horizon wins over live; only strictly positive
 *     confidences are measurable (0 = market-waiting convention).
 *   • isBelowConfidenceBar — strictly-below demotion; at/above the bar and
 *     waiting cards are never hidden behind the filter.
 *   • store integration — the store hydrates/persists the bar and honors the
 *     hide-below toggle in the node (no-window) environment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MIN_CONFIDENCE_DEFAULT_PCT,
  MIN_CONFIDENCE_LOW_PCT,
  MIN_CONFIDENCE_HIGH_PCT,
  clampMinConfidencePct,
  cardEffectiveConfidence,
  isBelowConfidenceBar,
} from "@/lib/minConfidenceFilter";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";

describe("clampMinConfidencePct", () => {
  it("keeps in-range values untouched", () => {
    expect(clampMinConfidencePct(96.5)).toBe(96.5);
    expect(clampMinConfidencePct(50)).toBe(50);
    expect(clampMinConfidencePct(99)).toBe(99);
    expect(clampMinConfidencePct(80.5)).toBe(80.5);
  });

  it("clamps out-of-range values into 50..99", () => {
    expect(clampMinConfidencePct(20)).toBe(MIN_CONFIDENCE_LOW_PCT);
    expect(clampMinConfidencePct(0)).toBe(MIN_CONFIDENCE_LOW_PCT);
    expect(clampMinConfidencePct(120)).toBe(MIN_CONFIDENCE_HIGH_PCT);
    expect(clampMinConfidencePct(99.9)).toBe(MIN_CONFIDENCE_HIGH_PCT);
  });

  it("falls back on missing / non-finite input", () => {
    expect(clampMinConfidencePct(undefined)).toBe(MIN_CONFIDENCE_DEFAULT_PCT);
    expect(clampMinConfidencePct(null)).toBe(MIN_CONFIDENCE_DEFAULT_PCT);
    expect(clampMinConfidencePct(Number.NaN)).toBe(MIN_CONFIDENCE_DEFAULT_PCT);
    expect(clampMinConfidencePct(Number.POSITIVE_INFINITY)).toBe(
      MIN_CONFIDENCE_DEFAULT_PCT,
    );
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
    // Reset to the default bar so tests are order-independent.
    useMarketTerminalStore.getState().setMinConfidencePct(MIN_CONFIDENCE_DEFAULT_PCT);
    useMarketTerminalStore.getState().setHideBelowThreshold(false);
  });

  it("hydrates with the engine's default 96.5% bar (no window in node)", () => {
    const s = useMarketTerminalStore.getState();
    expect(s.minConfidencePct).toBe(MIN_CONFIDENCE_DEFAULT_PCT);
    expect(s.hideBelowThreshold).toBe(false);
  });

  it("setMinConfidencePct clamps and persists the live bar", () => {
    useMarketTerminalStore.getState().setMinConfidencePct(88);
    expect(useMarketTerminalStore.getState().minConfidencePct).toBe(88);

    useMarketTerminalStore.getState().setMinConfidencePct(30); // below range
    expect(useMarketTerminalStore.getState().minConfidencePct).toBe(50);

    useMarketTerminalStore.getState().setMinConfidencePct(120); // above range
    expect(useMarketTerminalStore.getState().minConfidencePct).toBe(99);
  });

  it("setHideBelowThreshold reflects immediately", () => {
    useMarketTerminalStore.getState().setHideBelowThreshold(true);
    expect(useMarketTerminalStore.getState().hideBelowThreshold).toBe(true);
    useMarketTerminalStore.getState().setHideBelowThreshold(false);
    expect(useMarketTerminalStore.getState().hideBelowThreshold).toBe(false);
  });

  it("store init stays deterministic even when a persisted bar exists", () => {
    // Simulate a returning operator whose localStorage says 87.0 — the source
    // of the SSR hydration mismatch (server 96.5 vs client 87.0).
    const store = { getItem: () => "87", setItem: () => {}, removeItem: () => {} };
    (globalThis as Record<string, unknown>).window = { localStorage: store };
    try {
      // Re-populate state the way a fresh page load would: module init order
      // is deterministic (default 96.5), NOT the persisted override.
      useMarketTerminalStore.setState({
        minConfidencePct: clampMinConfidencePct(undefined),
        hideBelowThreshold: false,
      });
      expect(useMarketTerminalStore.getState().minConfidencePct).toBe(96.5);
      // The persisted value is applied ONLY via the post-hydration action the
      // terminal hook calls after first paint.
      useMarketTerminalStore.getState().hydrateClientPreferences();
      expect(useMarketTerminalStore.getState().minConfidencePct).toBe(87);
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