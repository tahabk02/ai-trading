/**
 * tierFilter.test.ts — TIER SELECTOR (flexible-tier architecture, 2026-09-30).
 *
 * The trader picks which signal bands they want to TRADE. The engine always
 * emits every computed tier T1..T5 with its true confidence; this selection only
 * decides which of them are marked `executable`. These tests root the three
 * properties the whole feature depends on:
 *   1. the ladder mirrors the engine exactly (no drift),
 *   2. a WEAKER selection never RAISES the bar, and T5 can never lower it past
 *      T4 — so a WEAK verdict is never tradable, and
 *   3. NOTHING here hides or rewrites a tier. Bands below the floor are still
 *      emitted, still displayed, and still report their real band.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  TIER_THRESHOLDS,
  TIER_ORDER,
  TIER_LABELS,
  DEFAULT_EXECUTION_TIER,
  LOWEST_TRADABLE_TIER,
  resolveExecutionFloor,
} from "@/lib/signalTiers";
import {
  TIER_SELECTIONS,
  LS_MIN_TIER_KEY,
  clampTierSelection,
  readPersistedTierSelection,
  persistTierSelection,
  tierClearsSelection,
  tierSelectionHint,
  tierSelectionLabel,
  resolveCardTier,
  selectionSortRank,
} from "@/lib/tierFilter";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";

describe("tier ladder mirrors the engine", () => {
  it("exposes the canonical T1..T5 ladder", () => {
    expect(TIER_ORDER).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(TIER_THRESHOLDS.T1).toBeCloseTo(0.965, 5);
    expect(TIER_THRESHOLDS.T2).toBeCloseTo(0.9, 5);
    expect(TIER_THRESHOLDS.T3).toBeCloseTo(0.8, 5);
    expect(TIER_THRESHOLDS.T4).toBeCloseTo(0.7, 5);
    expect(TIER_THRESHOLDS.T5).toBeCloseTo(0.0, 5);
    expect(DEFAULT_EXECUTION_TIER).toBe("T1");
    expect(LOWEST_TRADABLE_TIER).toBe("T4");
  });

  it("stays strictly monotonic, strongest first", () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      expect(TIER_THRESHOLDS[TIER_ORDER[i - 1]]).toBeGreaterThan(
        TIER_THRESHOLDS[TIER_ORDER[i]],
      );
    }
  });

  it("offers every band as a selection, T1 first", () => {
    expect(TIER_SELECTIONS).toEqual(["T1", "T2", "T3", "T4", "T5"]);
  });
});

describe("resolveExecutionFloor", () => {
  it("maps each selection onto its own threshold", () => {
    expect(resolveExecutionFloor("T1").barFrac).toBeCloseTo(0.965, 5);
    expect(resolveExecutionFloor("T2").barFrac).toBeCloseTo(0.9, 5);
    expect(resolveExecutionFloor("T3").barFrac).toBeCloseTo(0.8, 5);
    expect(resolveExecutionFloor("T4").barFrac).toBeCloseTo(0.7, 5);
  });

  it("never lowers the bar past the lowest tradable tier", () => {
    for (const sel of TIER_SELECTIONS) {
      expect(resolveExecutionFloor(sel).barFrac).toBeGreaterThanOrEqual(
        TIER_THRESHOLDS[LOWEST_TRADABLE_TIER],
      );
    }
  });

  it("floors T5 to T4 and reports that it did", () => {
    const floor = resolveExecutionFloor("T5");
    expect(floor.floored).toBe(true);
    expect(floor.effective).toBe("T4");
    expect(floor.barFrac).toBeCloseTo(0.7, 5);
    // The SELECTION is still reported honestly — we never pretend the user
    // chose T4.
    expect(floor.selected).toBe("T5");
  });

  it("never marks a non-T5 selection as floored", () => {
    for (const sel of ["T1", "T2", "T3", "T4"] as const) {
      expect(resolveExecutionFloor(sel).floored).toBe(false);
    }
  });

  it("weaker selections never RAISE the bar", () => {
    const bars = TIER_SELECTIONS.map((s) => resolveExecutionFloor(s).barFrac);
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i]).toBeLessThanOrEqual(bars[i - 1]);
    }
  });

  it("falls back to the strict default for absent/garbage input", () => {
    for (const bad of [null, undefined, "", "T9", "premium", 3, {}]) {
      const floor = resolveExecutionFloor(bad as never);
      expect(floor.effective).toBe(DEFAULT_EXECUTION_TIER);
      expect(floor.barFrac).toBeCloseTo(0.965, 5);
    }
  });
});

describe("tierClearsSelection", () => {
  it("T1 selection admits only T1", () => {
    expect(tierClearsSelection("T1", "T1")).toBe(true);
    for (const t of ["T2", "T3", "T4", "T5"] as const) {
      expect(tierClearsSelection(t, "T1")).toBe(false);
    }
  });

  it("T3 selection admits T1..T3 and rejects T4/T5", () => {
    for (const t of ["T1", "T2", "T3"] as const) {
      expect(tierClearsSelection(t, "T3")).toBe(true);
    }
    expect(tierClearsSelection("T4", "T3")).toBe(false);
    expect(tierClearsSelection("T5", "T3")).toBe(false);
  });

  it("T4 selection admits T1..T4 but NEVER T5", () => {
    for (const t of ["T1", "T2", "T3", "T4"] as const) {
      expect(tierClearsSelection(t, "T4")).toBe(true);
    }
    expect(tierClearsSelection("T5", "T4")).toBe(false);
  });

  it("T5 selection still never admits a WEAK band", () => {
    // The point of flooring: monitoring T5 must not make WEAK tradable.
    expect(tierClearsSelection("T5", "T5")).toBe(false);
    expect(tierClearsSelection("T4", "T5")).toBe(true);
    expect(tierClearsSelection("T1", "T5")).toBe(true);
  });

  it("rejects unknown tiers outright", () => {
    expect(tierClearsSelection("T9", "T4")).toBe(false);
    expect(tierClearsSelection(null, "T4")).toBe(false);
    expect(tierClearsSelection("", "T4")).toBe(false);
  });
});

describe("clampTierSelection", () => {
  it("normalises case and whitespace", () => {
    expect(clampTierSelection("t3")).toBe("T3");
    expect(clampTierSelection("  T4  ")).toBe("T4");
  });

  it("falls back to T1 for anything unrecognised", () => {
    for (const bad of ["T9", "", "premium", null, undefined, 3, {}]) {
      expect(clampTierSelection(bad)).toBe(DEFAULT_EXECUTION_TIER);
    }
  });

  it("accepts every real band", () => {
    for (const t of TIER_SELECTIONS) {
      expect(clampTierSelection(t)).toBe(t);
    }
  });
});

describe("selection labels", () => {
  it("labels each band", () => {
    expect(tierSelectionLabel("T1")).toBe(`T1 ${TIER_LABELS.T1}`);
    expect(tierSelectionLabel("T5")).toBe(`T5 ${TIER_LABELS.T5}`);
  });

  it("tells the user T5 is monitor-only rather than tradable", () => {
    expect(tierSelectionHint("T5")).toMatch(/monitor/i);
    expect(tierSelectionHint("T5")).toMatch(/T1.T4 can trade/i);
    expect(tierSelectionHint("T4")).toMatch(/most permissive/i);
  });
});

describe("resolveCardTier", () => {
  it("prefers the engine's explicit tier over deriving one", () => {
    // The engine NEVER rewrites this field, so it wins outright.
    expect(resolveCardTier({ tier: "T3", confidence: 99.9 }, null)).toBe("T3");
    expect(resolveCardTier(null, { tier: "T2", confidence: 85 })).toBe("T2");
  });

  it("falls back to deriving from confidence for older payloads", () => {
    expect(resolveCardTier({ confidence: 97 }, null)).toBe("T1");
    expect(resolveCardTier({ confidence: 85 }, null)).toBe("T3");
    expect(resolveCardTier({ confidence: 0.2 }, null)).toBe("T5");
  });

  it("returns null when there is nothing measurable", () => {
    expect(resolveCardTier(null, null)).toBeNull();
    expect(resolveCardTier({}, {})).toBeNull();
    expect(resolveCardTier({ confidence: 0 }, null)).toBeNull();
  });

  it("is case/whitespace tolerant on the engine field", () => {
    expect(resolveCardTier({ tier: " t4 " }, null)).toBe("T4");
  });
});

describe("selectionSortRank", () => {
  it("sorts unknown/absent tiers last but never drops them", () => {
    expect(selectionSortRank(null, "T4")).toBe(-1);
    expect(selectionSortRank("T9", "T4")).toBe(-1);
    expect(selectionSortRank("T5", "T4")).toBeGreaterThan(-1);
  });

  it("floats the bands the operator selected above the ones they do not", () => {
    // Same tier rank, but clearing the floor wins the tie.
    expect(selectionSortRank("T3", "T3")).toBeGreaterThan(
      selectionSortRank("T3", "T1"),
    );
  });
});

describe("persistence (node has no window)", () => {
  it("read/persist are safe no-ops without a window", () => {
    expect(() => persistTierSelection("T3")).not.toThrow();
    expect(readPersistedTierSelection()).toBe(DEFAULT_EXECUTION_TIER);
    expect(LS_MIN_TIER_KEY).toBe("terminal_min_tier");
  });
});

describe("useMarketTerminalStore — Tier Selector state", () => {
  beforeEach(() => {
    useMarketTerminalStore.getState().setMinTier(DEFAULT_EXECUTION_TIER);
  });

  it("defaults to the strict T1 selection", () => {
    expect(useMarketTerminalStore.getState().minTier).toBe("T1");
  });

  it("setMinTier stores every real band verbatim", () => {
    for (const t of TIER_SELECTIONS) {
      useMarketTerminalStore.getState().setMinTier(t);
      expect(useMarketTerminalStore.getState().minTier).toBe(t);
    }
  });

  it("setMinTier clamps garbage back to the default", () => {
    useMarketTerminalStore.getState().setMinTier("T9" as never);
    expect(useMarketTerminalStore.getState().minTier).toBe("T1");
    useMarketTerminalStore.getState().setMinTier(null as never);
    expect(useMarketTerminalStore.getState().minTier).toBe("T1");
  });
});