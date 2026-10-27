import { describe, expect, it } from "vitest";
import {
  expiryTargetSecondsRemaining,
  resolveExpiryTarget,
} from "../expiryTarget";

const MIN = Date.parse("2026-10-27T12:00:00.000Z");

describe("resolveExpiryTarget (client mirror)", () => {
  it("maps 60s to the current candle close", () => {
    const target = resolveExpiryTarget({
      nowMs: MIN + 10_000,
      expirationSeconds: 60,
      timeframeSeconds: 60,
    });
    expect(target.mode).toBe("CURRENT_CANDLE");
    expect(target.expiresAtMs).toBe(MIN + 60_000);
    expect(target.slippedCandles).toBe(0);
  });

  it("slides past the action window", () => {
    const target = resolveExpiryTarget({
      nowMs: MIN + 59_600,
      expirationSeconds: 60,
      timeframeSeconds: 60,
    });
    expect(target.mode).toBe("NEXT_CANDLE");
    expect(target.expiresAtMs).toBe(MIN + 120_000);
    expect(target.remainingMs).toBeGreaterThanOrEqual(1_500);
  });

  it("counts remaining whole seconds", () => {
    const target = resolveExpiryTarget({
      nowMs: MIN + 10_000,
      expirationSeconds: 60,
      timeframeSeconds: 60,
    });
    expect(expiryTargetSecondsRemaining(target, MIN + 20_500)).toBe(40);
  });

  it("locks out a bad expiry", () => {
    const target = resolveExpiryTarget({
      nowMs: MIN,
      expirationSeconds: -5,
      timeframeSeconds: 60,
    });
    expect(target.mode).toBe("LOCKED_OUT");
    expect(target.actionable).toBe(false);
    expect(expiryTargetSecondsRemaining(target, MIN)).toBe(0);
  });
});
