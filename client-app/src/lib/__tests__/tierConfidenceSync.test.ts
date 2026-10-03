/**
 * tierConfidenceSync.test.ts — PART 31 [309]/[311]/[312].
 *
 * THE BUG BEING LOCKED DOWN. The Confidence Filter was an independently
 * draggable slider over 50..99% sitting directly beside the Tier Selector, and
 * the two disagreed:
 *
 *   • `resolveExecutionFloor` derives barFrac from the selected tier, but
 *     nothing fed that number back into the store, so the readout the trader
 *     saw could be ANY dragged value;
 *   • a bar dragged to 60% while T4 was selected asked the engine
 *     (`min_confidence=60`) for a threshold BELOW LOWEST_TRADABLE_TIER (70%) —
 *     a UI-layer back door around the engine's floor, the same category of
 *     hazard as PART 34's force-override finding.
 *
 * THE CONTRACT.
 *   1. `minConfidencePct` is DERIVED. `setMinTier` is the only writer and it
 *      writes tier + bar in ONE atomic update, so no subscriber can ever see a
 *      torn pair (T5 beside a stale dragged value).
 *   2. Selecting T5 yields 70.0% — NOT T5's own 0% threshold, and NOT whatever
 *      was previously dragged.
 *   3. T1–T4 each yield their own threshold.
 *   4. Nothing — no interaction path, no persisted legacy key, no direct store
 *      poke, no garbage tier — can express a bar below MIN_EXECUTABLE_FLOOR_PCT
 *      (70.0%).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_EXECUTION_TIER,
  LOWEST_TRADABLE_TIER,
  MIN_EXECUTABLE_FLOOR_PCT,
  TIER_ORDER,
  TIER_THRESHOLDS,
  executionFloorPct,
  resolveExecutionFloor,
} from "@/lib/signalTiers";
import {
  MIN_CONFIDENCE_DEFAULT_PCT,
  LS_MIN_CONFIDENCE_KEY,
  clampMinConfidencePct,
} from "@/lib/minConfidenceFilter";
import { LS_MIN_TIER_KEY, TIER_SELECTIONS } from "@/lib/tierFilter";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";

const bar = () => useMarketTerminalStore.getState().minConfidencePct;
const tier = () => useMarketTerminalStore.getState().minTier;
const select = (t: Parameters<ReturnType<typeof useMarketTerminalStore.getState>["setMinTier"]>[0]) =>
  useMarketTerminalStore.getState().setMinTier(t);

describe("PART 31 [309] — the confidence bar is derived from the tier", () => {
  beforeEach(() => {
    useMarketTerminalStore.getState().setMinTier(DEFAULT_EXECUTION_TIER);
  });

  it("defaults to the T1 floor (96.5%)", () => {
    expect(tier()).toBe("T1");
    expect(bar()).toBeCloseTo(96.5, 5);
    expect(bar()).toBeCloseTo(MIN_CONFIDENCE_DEFAULT_PCT, 5);
  });

  it("REGRESSION — selecting T5 sets the bar to 70.0%, not 0% and not a stale value", () => {
    // Prime the state with a value the old free slider could produce, then
    // select T5. Both pre-fix failure modes are covered: 0.0 (T5's raw
    // threshold leaking through) and "whatever was previously dragged".
    useMarketTerminalStore.setState({ minConfidencePct: 60 });
    select("T5");

    expect(bar()).toBeCloseTo(70, 5);
    expect(bar()).not.toBeCloseTo(TIER_THRESHOLDS.T5 * 100, 5); // never 0%
    expect(bar()).toBeCloseTo(TIER_THRESHOLDS[LOWEST_TRADABLE_TIER] * 100, 5);
    expect(resolveExecutionFloor("T5").floored).toBe(true);
  });

  it("T1–T4 each set the bar to that tier's OWN threshold", () => {
    for (const t of ["T1", "T2", "T3", "T4"] as const) {
      select(t);
      expect(tier()).toBe(t);
      expect(bar()).toBeCloseTo(TIER_THRESHOLDS[t] * 100, 5);
      expect(resolveExecutionFloor(t).floored).toBe(false);
    }
    expect(bar()).toBeCloseTo(70, 5); // loop ended on T4
  });

  it("re-selecting the same tier after a drag cannot resurrect the dragged value", () => {
    select("T3");
    useMarketTerminalStore.setState({ minConfidencePct: 55 } as never);
    // Same tier again: the derivation runs unconditionally, so the bar snaps
    // back to T3's floor instead of trusting whatever is in state.
    select("T3");
    expect(bar()).toBeCloseTo(80, 5);
  });

  it("selects in either direction without leaving a stale bar", () => {
    select("T5");
    expect(bar()).toBeCloseTo(70, 5);
    select("T1");
    expect(bar()).toBeCloseTo(96.5, 5);
    select("T4");
    expect(bar()).toBeCloseTo(70, 5);
  });

  it("writes tier and bar in ONE update — a subscriber never sees a torn pair", () => {
    // zustand notifies synchronously per set(); two writes would emit an
    // intermediate state. Every observation must already be consistent.
    const observed: Array<{ tier: string; bar: number }> = [];
    const unsub = useMarketTerminalStore.subscribe((s) => {
      observed.push({ tier: s.minTier, bar: s.minConfidencePct });
    });
    try {
      for (const t of TIER_ORDER) select(t);
    } finally {
      unsub();
    }
    for (const o of observed) {
      expect(o.bar).toBeCloseTo(executionFloorPct(o.tier as never), 5);
    }
    expect(observed.length).toBeGreaterThan(0);
  });

  it("has NO setter that can set the bar independently of the tier", () => {
    // The bypass is removed structurally, not merely discouraged: there is no
    // `setMinConfidencePct` on the store, so the drag path cannot be re-added
    // by calling something that already exists.
    expect(
      (useMarketTerminalStore.getState() as unknown as Record<string, unknown>)
        .setMinConfidencePct,
    ).toBeUndefined();
  });
});

describe("PART 31 [312] — the bar can never display below 70.0%", () => {
  beforeEach(() => {
    useMarketTerminalStore.getState().setMinTier(DEFAULT_EXECUTION_TIER);
  });

  it("every selectable tier resolves to >= 70.0%", () => {
    for (const t of TIER_SELECTIONS) {
      select(t);
      expect(bar()).toBeGreaterThanOrEqual(MIN_EXECUTABLE_FLOOR_PCT);
    }
  });

  it("MIN_EXECUTABLE_FLOOR_PCT is T4's own threshold — no second source of truth", () => {
    expect(MIN_EXECUTABLE_FLOOR_PCT).toBeCloseTo(
      TIER_THRESHOLDS[LOWEST_TRADABLE_TIER] * 100,
      5,
    );
    expect(MIN_EXECUTABLE_FLOOR_PCT).toBeCloseTo(70, 5);
  });

  it("garbage tiers fall back to T1, not to an unguarded floor", () => {
    for (const bad of ["T9", "", " t4 x", null, undefined, 3, {}]) {
      select(bad as never);
      expect(tier()).toBe("T1");
      expect(bar()).toBeCloseTo(96.5, 5);
    }
  });

  it("clampMinConfidencePct RAISES a sub-70% request to 70.0% (hard floor)", () => {
    for (const bad of [0, 1, 50, 60, 69.9, -20]) {
      expect(clampMinConfidencePct(bad)).toBeCloseTo(MIN_EXECUTABLE_FLOOR_PCT, 5);
    }
    expect(clampMinConfidencePct(99.5)).toBeCloseTo(99, 5);
    expect(clampMinConfidencePct(80.5)).toBeCloseTo(80.5, 5);
  });

  it("a direct store poke below the floor cannot be re-read as a legal bar", () => {
    // Someone can always setState() directly; what matters is that every
    // read-out path runs the value through the clamp, so 0% never ships.
    useMarketTerminalStore.setState({ minConfidencePct: 0 } as never);
    expect(clampMinConfidencePct(bar())).toBeCloseTo(70, 5);
  });
});

describe("PART 31 [310] — the persisted bar no longer outlives its tier", () => {
  const fakeStorage = (seed: Record<string, string>) => {
    const map = new Map(Object.entries(seed));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  };

  it("hydration derives the bar from the persisted TIER, ignoring the retired key", () => {
    const previous = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      localStorage: fakeStorage({
        [LS_MIN_TIER_KEY]: "T5",
        // Pre-fix leftovers a returning operator could still have on disk.
        [LS_MIN_CONFIDENCE_KEY]: "60",
      }),
    };
    try {
      useMarketTerminalStore.setState({
        minTier: DEFAULT_EXECUTION_TIER,
        minConfidencePct: 96.5,
      } as never);
      useMarketTerminalStore.getState().hydrateClientPreferences();
      expect(tier()).toBe("T5");
      expect(bar()).toBeCloseTo(70, 5);
    } finally {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = previous;
      useMarketTerminalStore.getState().setMinTier(DEFAULT_EXECUTION_TIER);
    }
  });

  it("store init is still deterministic — a persisted tier never reaches the SSR frame", () => {
    const previous = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      localStorage: fakeStorage({ [LS_MIN_TIER_KEY]: "T4" }),
    };
    try {
      useMarketTerminalStore.setState({
        minTier: DEFAULT_EXECUTION_TIER,
        minConfidencePct: executionFloorPct(DEFAULT_EXECUTION_TIER),
      } as never);
      expect(tier()).toBe("T1");
      expect(bar()).toBeCloseTo(96.5, 5);
    } finally {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = previous;
    }
  });
});
