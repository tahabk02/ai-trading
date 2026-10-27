import { describe, expect, it } from "vitest";
import { BrokerClockCalibrator } from "../serverClock";

const BASE_LOCAL = Date.parse("2026-10-27T12:00:00.000Z");

describe("BrokerClockCalibrator", () => {
  it("estimates a positive broker offset from latency-adjusted samples", () => {
    const clock = new BrokerClockCalibrator({
      warmupSamples: 5,
      maxJitterMs: 50,
    });
    for (let i = 0; i < 8; i += 1) {
      clock.observe({
        brokerTsMs: BASE_LOCAL + 2_000 + i * 10,
        localReceivedMs: BASE_LOCAL + i * 10,
        latencyMs: 40,
      });
    }
    const snap = clock.snapshot(BASE_LOCAL + 100);
    expect(snap.calibrated).toBe(true);
    expect(snap.offsetMs).toBeGreaterThanOrEqual(2_000);
    expect(snap.offsetMs).toBeLessThanOrEqual(2_050);
    expect(snap.jitterMs).toBe(0);
  });

  it("rejects absurd offsets and stays on the fallback clock", () => {
    const clock = new BrokerClockCalibrator({ maxOffsetMs: 60_000 });
    const snap = clock.observe({
      brokerTsMs: BASE_LOCAL + 10 * 60_000,
      localReceivedMs: BASE_LOCAL,
    });
    expect(snap.sampleCount).toBe(0);
    expect(snap.calibrated).toBe(false);
    expect(snap.source).toBe("fallback");
    expect(snap.brokerNowMs).toBe(BASE_LOCAL);
  });

  it("uses the low-latency inliers and ignores jitter spikes", () => {
    const clock = new BrokerClockCalibrator({
      warmupSamples: 4,
      maxJitterMs: 100,
    });
    for (let i = 0; i < 6; i += 1) {
      clock.observe({
        brokerTsMs: BASE_LOCAL + 500,
        localReceivedMs: BASE_LOCAL,
        latencyMs: 100,
      });
    }
    clock.observe({
      brokerTsMs: BASE_LOCAL + 9_000,
      localReceivedMs: BASE_LOCAL,
      latencyMs: 100,
    });
    clock.observe({
      brokerTsMs: BASE_LOCAL + 520,
      localReceivedMs: BASE_LOCAL,
      latencyMs: 100,
    });
    const snap = clock.snapshot(BASE_LOCAL + 1_000);
    expect(snap.calibrated).toBe(true);
    expect(Math.abs(snap.offsetMs - 550)).toBeLessThanOrEqual(25);
  });

  it("never moves the calibrated clock backwards", () => {
    const clock = new BrokerClockCalibrator({
      warmupSamples: 3,
      maxJitterMs: 100,
    });
    for (let i = 0; i < 5; i += 1) {
      clock.observe({
        brokerTsMs: BASE_LOCAL + 1_000,
        localReceivedMs: BASE_LOCAL,
      });
    }
    const forward = clock.now(BASE_LOCAL + 5_000);
    const backward = clock.now(BASE_LOCAL + 1_000);
    expect(backward).toBe(forward);
  });

  it("marks an old calibration stale", () => {
    const clock = new BrokerClockCalibrator({
      warmupSamples: 3,
      staleAfterMs: 1_000,
    });
    for (let i = 0; i < 4; i += 1) {
      clock.observe({
        brokerTsMs: BASE_LOCAL,
        localReceivedMs: BASE_LOCAL,
      });
    }
    const snap = clock.snapshot(BASE_LOCAL + 5_000);
    expect(snap.stale).toBe(true);
    expect(snap.calibrated).toBe(false);
  });
});
