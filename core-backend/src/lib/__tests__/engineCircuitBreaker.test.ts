/**
 * engineCircuitBreaker.test.ts — unit contract for the core→engine circuit
 * breaker (threshold open, cooldown expiry → half-open, success closes,
 * window pruning).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  engineCircuitOpen,
  engineCircuitState,
  recordEngineFailure,
  recordEngineSuccess,
  resetEngineCircuit,
} from "../../lib/engineCircuitBreaker";

const KEY = "http://ai-engine:8000/api/v1/predict";

describe("engineCircuitBreaker", () => {
  beforeEach(() => {
    resetEngineCircuit();
    vi.useRealTimers();
  });
  afterEach(() => {
    resetEngineCircuit();
  });

  it("starts CLOSED — no failures recorded", () => {
    expect(engineCircuitOpen(KEY)).toBe(false);
    expect(engineCircuitState(KEY).failuresInWindow).toBe(0);
  });

  it("opens after the failure threshold", () => {
    recordEngineFailure(KEY);
    recordEngineFailure(KEY);
    expect(engineCircuitOpen(KEY)).toBe(false); // below threshold
    recordEngineFailure(KEY);
    expect(engineCircuitOpen(KEY)).toBe(true); // threshold crossed
    const state = engineCircuitState(KEY);
    expect(state.failuresInWindow).toBe(3);
    expect(state.opensAtMs).toBeGreaterThan(Date.now());
  });

  it("a single SUCCESS closes the circuit and clears the failure ledger", () => {
    recordEngineFailure(KEY);
    recordEngineFailure(KEY);
    recordEngineFailure(KEY);
    expect(engineCircuitOpen(KEY)).toBe(true);
    recordEngineSuccess(KEY);
    expect(engineCircuitOpen(KEY)).toBe(false);
    expect(engineCircuitState(KEY).failuresInWindow).toBe(0);
  });

  it("re-opens immediately on a FAILED half-open probe", () => {
    recordEngineFailure(KEY);
    recordEngineFailure(KEY);
    recordEngineFailure(KEY);
    expect(engineCircuitOpen(KEY)).toBe(true);

    // Cooldown elapses → HALF-OPEN: exactly one probe attempt is allowed.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_000);
    expect(engineCircuitOpen(KEY)).toBe(false);
    expect(engineCircuitState(KEY).halfOpen).toBe(true);

    // Probe fails → circuit re-opens immediately (no warm-up re-count).
    recordEngineFailure(KEY);
    expect(engineCircuitOpen(KEY)).toBe(true);
    expect(engineCircuitState(KEY).halfOpen).toBe(false);
  });

  it("prunes failures older than the sliding window", () => {
    vi.useFakeTimers();
    recordEngineFailure(KEY);
    recordEngineFailure(KEY);
    expect(engineCircuitState(KEY).failuresInWindow).toBe(2);
    // Advance past the window; the failure ledger ages out.
    vi.setSystemTime(Date.now() + 30_000);
    expect(engineCircuitState(KEY).failuresInWindow).toBe(0);
    expect(engineCircuitOpen(KEY)).toBe(false);
    expect(engineCircuitState(KEY).halfOpen).toBe(false);
  });

  it("closes a half-open circuit on a successful probe", () => {
    vi.useFakeTimers();
    recordEngineFailure(KEY);
    recordEngineFailure(KEY);
    recordEngineFailure(KEY);
    expect(engineCircuitOpen(KEY)).toBe(true);
    vi.setSystemTime(Date.now() + 30_000);
    expect(engineCircuitOpen(KEY)).toBe(false); // half-open probe allowed
    recordEngineSuccess(KEY);
    expect(engineCircuitOpen(KEY)).toBe(false);
    expect(engineCircuitState(KEY).halfOpen).toBe(false);
    expect(engineCircuitState(KEY).failuresInWindow).toBe(0);
  });
});