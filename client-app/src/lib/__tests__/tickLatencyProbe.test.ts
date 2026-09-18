import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isTickLatencyProbeEnabled,
  logTickLatencySummary,
} from "../tickLatencyProbe";

describe("tickLatencyProbe — default silence contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Clean up any window mock we injected.
    if (typeof globalThis.window !== "undefined") {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("test_tick_latency_probe_silent_by_default", () => {
    // No window (node env) → disabled
    expect(isTickLatencyProbeEnabled()).toBe(false);

    // Even if logTickLatencySummary is called it must be a total no-op.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const tableSpy = vi.spyOn(console, "table").mockImplementation(() => {});
    logTickLatencySummary(
      { window: 0, dropped: 0, brokerToBrowserMs: { min: 1, p50: 1, p95: 2, max: 2 }, interArrivalMs: { min: 0, p50: 0, p95: 0, max: 0 } },
      [{ index: 1, symbol: "EUR/USD", tBroker: 1, tLocal: 1, brokerToBrowserMs: 1, interArrivalMs: 0, seqGap: 0 }],
    );
    expect(infoSpy).not.toHaveBeenCalled();
    expect(tableSpy).not.toHaveBeenCalled();
  });

  it("test_tick_latency_probe_respects_opt_in_flag", () => {
    // Simulate a browser with the opt-in flag explicitly OFF.
    (globalThis as Record<string, unknown>).window = {
      __ENABLE_TICK_LATENCY_PROBE: false,
    };
    expect(isTickLatencyProbeEnabled()).toBe(false);

    // Now flip it on.
    (globalThis as Record<string, unknown>).window = {
      __ENABLE_TICK_LATENCY_PROBE: true,
    };
    expect(isTickLatencyProbeEnabled()).toBe(true);
  });
});