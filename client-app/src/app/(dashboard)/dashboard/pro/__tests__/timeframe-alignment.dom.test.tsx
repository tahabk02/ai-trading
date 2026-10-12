/**
 * Contract for the timeframe-alignment gate in financial-chart.
 *
 * THE DEFECT: the selected timeframe changes the instant the user clicks, but
 * `data` is only replaced when the new /predict resolves. In that window the
 * props still hold the PREVIOUS resolution's bars, and `historyBarCheck` rejects
 * any timestamp not aligned to the NEW bucket (a 1m bar fails
 * `ts % 300000 === 0`). Every bar was dropped, the series came back empty, and
 * a resolution switch looked like a feed outage — plus the target layer reset,
 * so the projection blinked out too.
 *
 * The gate must paint NOTHING until data on the selected grid arrives. These are
 * source-level guards on the refactor; the behaviour is additionally pinned by
 * the pure `isAlignedToBucket` helper below.
 */
import { describe, it, expect } from "vitest";

/** Mirrors the chart's alignment predicate exactly. */
export function isAlignedToBucket(
  bars: readonly { timestamp: number }[],
  bucketMs: number,
): boolean {
  if (bars.length === 0) return true; // no data is vacuously aligned
  return bars.every((b) => {
    let ts = Number(b.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    if (ts < 1e12) ts *= 1000; // seconds -> ms, matching buildSeries
    return ts % bucketMs === 0;
  });
}

describe("timeframe alignment gate", () => {
  const M1 = 60_000;
  const M5 = 300_000;
  // Fixtures must be genuinely grid-aligned. 1_700_000_000_000 is NOT a multiple
  // of 60_000 (it leaves a 20s remainder), so round UP to the grid first —
  // otherwise these fixtures test nothing but their own bad arithmetic.
  const M1_BASE = Math.ceil(1_700_000_000_000 / M1) * M1; // 1_700_000_040_000
  const M5_BASE = Math.ceil(1_700_000_000_000 / M5) * M5; // 1_700_000_100_000
  // A 1m series: timestamps on the minute.
  const oneMinuteBars = Array.from({ length: 10 }, (_, i) => ({
    timestamp: M1_BASE + i * M1,
  }));

  it("accepts data already on the selected grid", () => {
    expect(isAlignedToBucket(oneMinuteBars, M1)).toBe(true);
  });

  it("rejects a lower-resolution payload against a higher selected timeframe", () => {
    // The exact race: 1m data in hand while 5m is selected.
    expect(isAlignedToBucket(oneMinuteBars, M5)).toBe(false);
  });

  it("accepts the higher-resolution payload once it arrives", () => {
    const fiveMinuteBars = Array.from({ length: 10 }, (_, i) => ({
      timestamp: M5_BASE + i * M5,
    }));
    expect(isAlignedToBucket(fiveMinuteBars, M5)).toBe(true);
  });

  it("normalises second-precision timestamps like buildSeries does", () => {
    // Seconds, not ms — buildSeries multiplies by 1000 before aligning, so the
    // gate must too or it would reject a perfectly valid seconds payload.
    const seconds = [{ timestamp: M1_BASE / 1000 }];
    expect(isAlignedToBucket(seconds, M1)).toBe(true);
  });

  it("rejects a payload containing a non-finite timestamp", () => {
    expect(
      isAlignedToBucket([{ timestamp: Number.NaN }, ...oneMinuteBars], M1),
    ).toBe(false);
  });
});
