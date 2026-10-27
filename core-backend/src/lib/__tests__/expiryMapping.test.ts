import { describe, expect, it } from "vitest";
import { resolveExpiryTarget } from "../expiryMapping";

const MIN = Date.parse("2026-10-27T12:00:00.000Z");

describe("resolveExpiryTarget", () => {
  it("maps a 1m expiry to the current candle close", () => {
    const target = resolveExpiryTarget({
      nowMs: MIN + 10_000,
      expirationSeconds: 60,
      timeframeSeconds: 60,
      minActionableWindowMs: 1_500,
    });
    expect(target.mode).toBe("CURRENT_CANDLE");
    expect(target.actionable).toBe(true);
    expect(target.expiresAtMs).toBe(MIN + 60_000);
    expect(target.remainingMs).toBe(50_000);
    expect(target.slippedCandles).toBe(0);
  });

  it("slides to the next candle when the current one is too close", () => {
    const target = resolveExpiryTarget({
      nowMs: MIN + 59_500,
      expirationSeconds: 60,
      timeframeSeconds: 60,
      minActionableWindowMs: 1_500,
    });
    expect(target.mode).toBe("NEXT_CANDLE");
    expect(target.expiresAtMs).toBe(MIN + 120_000);
    expect(target.slippedCandles).toBe(1);
    expect(target.remainingMs).toBeGreaterThanOrEqual(1_500);
  });

  it("aligns a 300s expiry to the 5m grid", () => {
    const target = resolveExpiryTarget({
      nowMs: MIN + 12_000,
      expirationSeconds: 300,
      timeframeSeconds: 60,
    });
    expect(target.expiresAtMs).toBe(MIN + 300_000);
    expect(target.targetCandleStartMs).toBe(MIN + 240_000);
    expect(target.alignedSeconds).toBe(300);
  });

  it("locks out invalid input", () => {
    const target = resolveExpiryTarget({
      nowMs: MIN,
      expirationSeconds: 0,
      timeframeSeconds: 60,
    });
    expect(target.mode).toBe("LOCKED_OUT");
    expect(target.actionable).toBe(false);
    expect(target.lockReason).toBe("invalid_input");
  });

  it("locks out expiries beyond the configured horizon", () => {
    const target = resolveExpiryTarget({
      nowMs: MIN,
      expirationSeconds: 60,
      timeframeSeconds: 60,
      maxHorizonMs: 30_000,
    });
    expect(target.mode).toBe("LOCKED_OUT");
    expect(target.lockReason).toBe("expiry_exceeds_max_horizon");
  });
});
