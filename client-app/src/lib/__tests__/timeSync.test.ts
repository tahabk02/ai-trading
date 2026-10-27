import { describe, expect, it } from "vitest";
import { ClientClockSync } from "../timeSync";

const T0 = Date.parse("2026-10-27T12:00:00.000Z");

describe("ClientClockSync", () => {
  it("computes broker offset from a timed round trip", () => {
    const clock = new ClientClockSync({ warmupSamples: 2, maxJitterMs: 50 });
    for (let i = 0; i < 3; i += 1) {
      clock.beginSync(T0 + i * 1_000);
      clock.ingest(
        {
          brokerNowMs: T0 + i * 1_000 + 500,
          localNowMs: T0 + i * 1_000 + 50,
        },
        T0 + i * 1_000 + 100,
      );
    }
    const snap = clock.snapshot(T0 + 3_100);
    expect(snap.calibrated).toBe(true);
    expect(snap.offsetMs).toBe(400);
    expect(snap.latencyMs).toBe(100);
  });

  it("falls back to local time before the first sync", () => {
    const clock = new ClientClockSync();
    const snap = clock.snapshot(T0);
    expect(snap.calibrated).toBe(false);
    expect(snap.brokerNowMs).toBe(T0);
  });

  it("never moves backwards", () => {
    const clock = new ClientClockSync({ warmupSamples: 1 });
    clock.beginSync(T0);
    clock.ingest(
      { brokerNowMs: T0 + 1_000, localNowMs: T0 },
      T0 + 10,
    );
    const first = clock.now(T0 + 5_000);
    const second = clock.now(T0 + 1_000);
    expect(second).toBe(first);
  });

  it("rejects an absurd offset", () => {
    const clock = new ClientClockSync({ maxOffsetMs: 1_000 });
    clock.ingest({ brokerNowMs: T0 + 60_000, localNowMs: T0 }, T0);
    const snap = clock.snapshot(T0 + 1);
    expect(snap.sampleCount).toBe(0);
    expect(snap.offsetMs).toBe(0);
  });
});
