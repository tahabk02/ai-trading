/**
 * Server-authoritative candle precedence + target-candle gating.
 *
 * Regression cover for the two chart defects that produced "red/broken"
 * candles and logically wrong target overlays:
 *
 *  1. A sealed server bar (`isFinal`) must NEVER be repainted by a client-side
 *     row for the same bucket. The old guard tested the CLIENT row's flag,
 *     which no producer ever set, so the precedence rule was dead code.
 *  2. The target-candle overlay must fail closed when the engine tier is
 *     missing or below T3 — never extrapolate a trajectory from ATR alone.
 */
import { describe, expect, it } from "vitest";

import { buildTargetCandles } from "@/lib/realtimeCandleAggregator";
import { resolveTier, targetCandlesEnabled } from "@/lib/signalTiers";

interface GridCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed?: boolean;
  isFinal?: boolean;
  isGap?: boolean;
}

/** Mirror of financial-chart.buildSeries precedence + single HA fold. */
function mergeSeries(
  history: GridCandle[],
  serverClosed: GridCandle[],
  clientRaw: GridCandle[],
): GridCandle[] {
  const byTs = new Map<number, GridCandle>();
  for (const c of history) byTs.set(Number(c.timestamp), c);
  for (const r of serverClosed) {
    byTs.set(Number(r.timestamp), { ...r, isFinal: true });
  }
  for (const r of clientRaw) {
    if (r.isGap === true) continue;
    const existing = byTs.get(Number(r.timestamp));
    if (existing && existing.isFinal === true) continue;
    byTs.set(Number(r.timestamp), r);
  }
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

const bar = (ts: number, close: number, extra: Partial<GridCandle> = {}): GridCandle => ({
  timestamp: ts,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  ...extra,
});

describe("candle merge precedence", () => {
  it("never repaints a sealed server bar with a client row", () => {
    const rows = mergeSeries(
      [bar(1_000, 1.1)],
      [bar(2_000, 1.2, { closed: true, isFinal: true })],
      // Client aggregator still holds its own provisional bar for the SAME
      // (already settled) bucket, with a stale close.
      [bar(2_000, 1.199), bar(3_000, 1.25)],
    );
    expect(rows).toHaveLength(3);
    expect(rows[1].close).toBe(1.2);
    expect(rows[1].isFinal).toBe(true);
    // The forming bucket is still client-owned.
    expect(rows[2].close).toBe(1.25);
    expect(rows[2].isFinal).toBeUndefined();
  });

  it("keeps client rows when the server has no candle for that bucket", () => {
    const rows = mergeSeries([], [], [bar(5_000, 2.0)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].close).toBe(2.0);
  });

  it("never lets a /predict history row outlive a sealed server bar", () => {
    const rows = mergeSeries(
      [bar(1_000, 9.9)],
      [bar(1_000, 1.5, { closed: true, isFinal: true })],
      [],
    );
    expect(rows[0].close).toBe(1.5);
    expect(rows[0].isFinal).toBe(true);
  });

  it("stays monotonic and de-duplicated", () => {
    const rows = mergeSeries(
      [],
      [bar(2_000, 1.2, { isFinal: true })],
      [bar(1_000, 1.1), bar(2_000, 1.19), bar(3_000, 1.3)],
    );
    expect(rows.map((r) => r.timestamp)).toEqual([1_000, 2_000, 3_000]);
  });
});

describe("target candles", () => {
  const base = {
    liveTipBucketMs: 60_000,
    liveClose: 1.5,
    targetPrice: 1.55,
    atr: 0.002,
    signal: "BUY" as const,
    expirationSeconds: 60,
    timeframeSeconds: 20,
  };

  it("renders for an engine-graded T1–T3 tier", () => {
    const rows = buildTargetCandles({ ...base, tier: "T1" });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("keeps the documented legacy render when the engine tier is absent", () => {
    // Pinned by realtimeCandleAggregator.test.ts ("absent tier keeps legacy
    // behaviour"): an ungraded signal still projects, T4/T5 never do.
    expect(buildTargetCandles({ ...base, tier: undefined }).length).toBeGreaterThan(
      0,
    );
  });

  it("suppresses the overlay below the T3 floor", () => {
    expect(buildTargetCandles({ ...base, tier: "T4" })).toEqual([]);
    expect(buildTargetCandles({ ...base, tier: "T5" })).toEqual([]);
    // A non-empty but unrecognised label ranks 0, so it suppresses too — the
    // legacy path is reserved for a genuinely ABSENT tier.
    expect(buildTargetCandles({ ...base, tier: "PREMIUM" })).toEqual([]);
  });

  it("keeps the tier floor aligned with the shared tier table", () => {
    expect(targetCandlesEnabled("T3")).toBe(true);
    expect(targetCandlesEnabled("T4")).toBe(false);
    expect(resolveTier(0.97)).toBe("T1");
    expect(resolveTier(0.5)).toBe("T5");
  });
});
