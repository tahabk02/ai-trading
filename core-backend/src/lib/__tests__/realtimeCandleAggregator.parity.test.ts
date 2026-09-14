import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realtimeCandleAggregatorService } from "../../services/realtimeCandleAggregator.service";

/**
 * Byte-conform tests for the CANDLE PARITY subsystem (mission item 3):
 * raw ticks must produce bucket writes for the pair they arrive under — else
 * the pair is flat-lining and the watchdog must say so. Pure service-level
 * tests on a deterministic broker clock (fake timers), no network, no DB.
 */

const OPEN_TS = 1_000_000_000; // broker-clock anchor used across all scenarios
const TRACKED_TF = "20s"; // sub-minute PO-parity frame, intra PARITY_TRACK_MAX_MS

beforeEach(() => {
  vi.useFakeTimers();
  // Place the wall clock 10s BEFORE the broker-clock anchor so the open buckets
  // produced by the opening tick are NOT yet closeable inside the 3s test window.
  vi.setSystemTime(OPEN_TS - 10_000);
  realtimeCandleAggregatorService.destroy();
  realtimeCandleAggregatorService.resetParityTelemetry();
  realtimeCandleAggregatorService.start();
});

afterEach(() => {
  realtimeCandleAggregatorService.stop();
  realtimeCandleAggregatorService.resetParityTelemetry();
  realtimeCandleAggregatorService.setParityHandler(null);
  vi.useRealTimers();
});

describe("candle parity — canonical symbol keying", () => {
  it("keys telemetry under ONE canonical form regardless of tick spelling", () => {
    realtimeCandleAggregatorService.addTick("EURUSD", 1.105, OPEN_TS);
    realtimeCandleAggregatorService.addTick("eur/usd", 1.106, OPEN_TS + 1);
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.107, OPEN_TS + 2);

    const telemetry = realtimeCandleAggregatorService.getParityTelemetry();
    expect(Object.keys(telemetry)).toEqual(["EUR/USD"]);
    expect(telemetry["EUR/USD"].ticks).toBe(3);
    expect(telemetry["EUR/USD"].writes).toBeGreaterThan(0);
  });
});

describe("candle parity — healthy flow never false-positives", () => {
  it("does not breach while ticks keep producing bucket writes", () => {
    const alerts: { symbol: string; timeframe: string | null }[] = [];
    realtimeCandleAggregatorService.setParityHandler((a) => {
      alerts.push({ symbol: a.symbol, timeframe: a.timeframe });
    });

    // Feed one in-bucket tick per sweep for 6 sweeps: every tick lands in the
    // still-open bucket for every resolution and increments writes, so the
    // parity delta is always healthy.
    for (let i = 0; i < 6; i += 1) {
      realtimeCandleAggregatorService.addTick(
        "EUR/USD",
        1.10 + i / 1000,
        OPEN_TS + i,
      );
      vi.advanceTimersByTime(1_000);
    }

    expect(alerts).toHaveLength(0);
    const telemetry = realtimeCandleAggregatorService.getParityTelemetry();
    expect(telemetry["EUR/USD"].ticks).toBe(6);
    expect(telemetry["EUR/USD"].writes).toBeGreaterThan(6);
    expect(telemetry["EUR/USD"].byTf[TRACKED_TF]).toBe(6);
  });
});

describe("candle parity — flat-line breach detection", () => {
  it("raises a per-pair breach alert when ticks advance without intra-family writes", () => {
    const alerts: { symbol: string; timeframe: string | null }[] = [];
    realtimeCandleAggregatorService.setParityHandler((a) => {
      alerts.push({ symbol: a.symbol, timeframe: a.timeframe });
    });

    // Opening tick — anchors the bucket grid with a real write.
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.1, OPEN_TS);

    // Baseline sweep: the opening writes are observed, so the window starts
    // unarmed.
    vi.advanceTimersByTime(1_000);

    // Stale-replay phase: one ancient tick per sweep. Each is far older than
    // REORDER_MS on the broker clock, so it is dropped WITHOUT writing a bucket,
    // reproducing the raw-tick-without-bucket-increment failure mode. The 20s
    // bucket stays open the whole window (it would not close for 22s), so it
    // never masks the breach with a boundary write.
    for (let i = 0; i < 3; i += 1) {
      realtimeCandleAggregatorService.addTick(
        "EUR/USD",
        1.11,
        OPEN_TS - 5_000 - i,
      );
      vi.advanceTimersByTime(1_000);
    }

    const pairwise = alerts.filter((a) => a.timeframe === TRACKED_TF);
    expect(pairwise.length).toBeGreaterThanOrEqual(1);

    const telemetry = realtimeCandleAggregatorService.getParityTelemetry();
    expect(telemetry["EUR/USD"].ticks).toBe(4);
    // The stale-replay ticks produced NO writes for the tracked family: only the
    // opening tick landed in the 20s bucket (1 write), the 3 ancient ticks below
    // REORDER recency were dropped by parityRecord.
    expect(telemetry["EUR/USD"].byTf[TRACKED_TF]).toBe(1);
  });
});