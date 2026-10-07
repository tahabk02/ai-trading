/**
 * timeframeGrid.test.ts — PART 39 [371]/[372]/[373] contract.
 *
 * The chart's candle-build grid and its history gate are the two lists that
 * silently drift: the grid lives in TIMEFRAME_MS, the retention windows in
 * MAX_HISTORY_LOOKBACK, and a frame missing from the SECOND one used to fall
 * back to a bare 24h and blank the pane on a timeframe switch.
 *
 * Evidence for the ladder (no guessing — see the module header in
 * realtimeCandleAggregator.ts): PO's own blog fixes the selector at
 * "5 seconds to 1 month"; W1/MN1 are the only frames we lacked; S1 is
 * deliberately excluded (PO's floor is 5 seconds).
 */
import { describe, it, expect } from "vitest";
import {
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_MS,
  MAX_HISTORY_LOOKBACK,
  MIN_HISTORY_CLOSES,
  historyBarCheck,
  historyLookbackMs,
  normalizeTimeframe,
  type Timeframe,
} from "@/lib/realtimeCandleAggregator";
import { aiTimeframeFor } from "@/store/useTradingStore";

describe("[373] confirmed PO ladder", () => {
  it("carries the 16 confirmed frames, including the two slow ones", () => {
    expect(SUPPORTED_TIMEFRAMES).toHaveLength(16);
    for (const tf of [
      "S5", "S10", "S15", "S30",
      "M1", "M2", "M3", "M5", "M10", "M15", "M30",
      "H1", "H4", "D1", "W1", "MN1",
    ] as const) {
      expect(SUPPORTED_TIMEFRAMES).toContain(tf);
    }
  });

  it("does NOT invent an S1 frame — PO's stated floor is 5 seconds", () => {
    expect(SUPPORTED_TIMEFRAMES).not.toContain("S1");
    expect(TIMEFRAME_MS["S5"]).toBe(5_000);
  });

  it("gives every frame its OWN lookback window (no 24h fallback holes)", () => {
    // The [372] defect: only six widths had a table entry, so S10/S15/S30 and
    // M2/M3/M10/M30/H4 (and W1/MN1) fell through to the flat 24h default.
    for (const tf of SUPPORTED_TIMEFRAMES) {
      expect(
        Object.prototype.hasOwnProperty.call(
          MAX_HISTORY_LOOKBACK,
          String(TIMEFRAME_MS[tf]),
        ),
      ).toBe(true);
    }
    // slow frames must look back further than the 24h default, fast ones are
    // free to be shorter — the point is that the entry exists at all.
    expect(historyLookbackMs(TIMEFRAME_MS["H4"])).toBeGreaterThan(86_400_000);
    expect(historyLookbackMs(TIMEFRAME_MS["W1"])).toBeGreaterThan(86_400_000);
    expect(historyLookbackMs(TIMEFRAME_MS["MN1"])).toBeGreaterThan(
      TIMEFRAME_MS["W1"],
    );
  });

  it("aliases 1w onto W1 and resolves the new frames case-insensitively", () => {
    expect(normalizeTimeframe("1w")).toBe("W1");
    expect(normalizeTimeframe("w1")).toBe("W1");
    expect(normalizeTimeframe("mn1")).toBe("MN1");
    expect(normalizeTimeframe("MN1")).toBe("MN1");
  });

  it("coerces the slow frames onto the engine's 1d channel, never a 422 key", () => {
    // ai-engine schemas.validate_timeframe tops out at "1d"; a raw "W1"/"MN1"
    // /predict would 422 and strand the engine in HOLD.
    expect(aiTimeframeFor("W1")).toBe("1d");
    expect(aiTimeframeFor("MN1")).toBe("1d");
  });
});

describe("history grid gate still rejects foreign resolutions", () => {
  const NOW = 1_800_000_000_000;
  const W1 = TIMEFRAME_MS["W1"];
  const MN1 = TIMEFRAME_MS["MN1"];

  it("accepts a weekly-aligned bar and rejects a raw minute bar on W1", () => {
    const aligned = Math.floor(NOW / W1) * W1;
    expect(historyBarCheck(aligned, W1, NOW)).toBe(true);
    // a 1m bar landing 60s after the weekly open is NOT on the weekly grid
    expect(historyBarCheck(aligned + 60_000, W1, NOW)).toBe(false);
  });

  it("accepts a 30-day-block-aligned bar on MN1 (documented epoch-floor grid)", () => {
    const aligned = Math.floor(NOW / MN1) * MN1;
    expect(historyBarCheck(aligned, MN1, NOW)).toBe(true);
    expect(historyBarCheck(aligned + 86_400_000, MN1, NOW)).toBe(false);
  });

  it("pins the 100-close minimum the building-history state reports against", () => {
    expect(MIN_HISTORY_CLOSES).toBe(100);
  });
});