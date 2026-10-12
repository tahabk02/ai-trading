/**
 * predictFailure.test.ts — PART 43.4 [470].
 *
 * Contract: the transient "awaiting live data" 503 the engine sends while it
 * waits for a fresh tick / enough real bars is a HANDLED state (recoverable →
 * per-symbol backoff, never a console.error). Every other 5xx — and a 503 that
 * ISN'T the awaiting marker (cache/db unavailable) — stays a real error.
 */
import { describe, it, expect } from "vitest";

import {
  isAwaitingLiveData,
  isRecoverablePredictFailure,
} from "@/lib/predictFailure";

describe("[470] isAwaitingLiveData", () => {
  it("recognises the exact engine error codes", () => {
    expect(isAwaitingLiveData({ error: "Awaiting real-time tick" })).toBe(true);
    expect(isAwaitingLiveData({ error: "Awaiting live market data" })).toBe(true);
  });

  it("recognises the connecting / collecting flags", () => {
    expect(isAwaitingLiveData({ connecting: true })).toBe(true);
    expect(isAwaitingLiveData({ collecting: true })).toBe(true);
  });

  it("recognises the message copy as a defensive fallback", () => {
    expect(
      isAwaitingLiveData({
        message: "No fresh live quote observed for 4000ms — signal generation is paused.",
      }),
    ).toBe(true);
    expect(
      isAwaitingLiveData({
        message:
          "Not enough real historical bars yet (3/60). Live ticks are being recorded.",
      }),
    ).toBe(true);
  });

  it("is false for non-awaiting bodies", () => {
    expect(isAwaitingLiveData({ error: "cache_unavailable" })).toBe(false);
    expect(isAwaitingLiveData({ error: "db_unavailable" })).toBe(false);
    expect(isAwaitingLiveData({ error: "Internal Server Error" })).toBe(false);
    expect(isAwaitingLiveData(null)).toBe(false);
    expect(isAwaitingLiveData("nope")).toBe(false);
  });
});

describe("[470] isRecoverablePredictFailure", () => {
  it("treats the awaiting-tick 503 as recoverable (handled, not an error)", () => {
    expect(
      isRecoverablePredictFailure(503, { error: "Awaiting real-time tick" }),
    ).toBe(true);
    expect(
      isRecoverablePredictFailure(503, { connecting: true }),
    ).toBe(true);
  });

  it("treats 429 as recoverable (request never accepted)", () => {
    expect(isRecoverablePredictFailure(429, {})).toBe(true);
  });

  it("treats a real 5xx as a hard error", () => {
    expect(isRecoverablePredictFailure(500, { error: "Internal Server Error" })).toBe(
      false,
    );
    expect(isRecoverablePredictFailure(502, {})).toBe(false);
    expect(isRecoverablePredictFailure(504, {})).toBe(false);
  });

  it("treats a 503 WITHOUT the awaiting marker as a hard error", () => {
    expect(isRecoverablePredictFailure(503, { error: "cache_unavailable" })).toBe(
      false,
    );
    expect(isRecoverablePredictFailure(503, { error: "db_unavailable" })).toBe(false);
    expect(isRecoverablePredictFailure(503, {})).toBe(false);
  });

  it("treats 4xx validation failures as hard errors", () => {
    expect(isRecoverablePredictFailure(400, { message: "bad symbol" })).toBe(false);
    expect(isRecoverablePredictFailure(404, {})).toBe(false);
  });
});
