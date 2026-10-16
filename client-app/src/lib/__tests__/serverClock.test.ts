/**
 * serverClock.test.ts — pure estimator + projection contract (Phase 2).
 *
 * The clock correction is safety-adjacent (it decides when an exact expiry
 * boundary lands), so every branch is pinned: convergence, outlier dampening,
 * non-finite guards, and the additive projection identity.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLOCK_DEADBAND_MS,
  DEFAULT_MAX_CLOCK_STEP_MS,
  estimateClockOffsetMs,
  serverNowMs,
} from "@/lib/serverClock";

describe("estimateClockOffsetMs", () => {
  it("keeps the previous estimate when the sample is non-finite", () => {
    expect(estimateClockOffsetMs(120, Number.NaN)).toBe(120);
    expect(estimateClockOffsetMs(120, Number.POSITIVE_INFINITY)).toBe(120);
  });

  it("adopts a finite sample when the previous estimate is non-finite", () => {
    expect(estimateClockOffsetMs(Number.NaN, 120)).toBe(120);
  });

  it("snaps exactly to a sample within the deadband (convergence)", () => {
    // A 3ms move is inside the 5ms band → adopt verbatim, not chase.
    expect(estimateClockOffsetMs(0, 3)).toBe(3);
    expect(estimateClockOffsetMs(1000, 1000 - DEFAULT_CLOCK_DEADBAND_MS)).toBe(
      1000 - DEFAULT_CLOCK_DEADBAND_MS,
    );
  });

  it("steps toward a large sample by at most maxStepMs (outlier dampening)", () => {
    const next = estimateClockOffsetMs(0, 100_000);
    expect(next).toBe(DEFAULT_MAX_CLOCK_STEP_MS);
    expect(estimateClockOffsetMs(0, -100_000)).toBe(-DEFAULT_MAX_CLOCK_STEP_MS);
  });

  it("honours explicit maxStepMs / deadbandMs overrides", () => {
    expect(estimateClockOffsetMs(0, 100, { maxStepMs: 10 })).toBe(10);
    expect(estimateClockOffsetMs(0, 100, { maxStepMs: 1000, deadbandMs: 0 })).toBe(
      100,
    );
  });

  it("converges monotonically to a fixed sample across repeated ticks", () => {
    let est = 0;
    const target = 900; // bigger than one maxStep
    for (let i = 0; i < 100; i++) est = estimateClockOffsetMs(est, target);
    expect(est).toBe(target);
  });

  it("is idempotent once converged (stable sample → no further movement)", () => {
    const converged = estimateClockOffsetMs(500, 500);
    expect(estimateClockOffsetMs(converged, 500)).toBe(500);
  });
});

describe("serverNowMs", () => {
  it("adds the offset to the local clock (additive identity)", () => {
    expect(serverNowMs(1_000, 250)).toBe(1_250);
    expect(serverNowMs(1_000, -250)).toBe(750);
  });

  it("treats a non-finite offset as zero", () => {
    expect(serverNowMs(1_000, Number.NaN)).toBe(1_000);
    expect(serverNowMs(1_000, Number.POSITIVE_INFINITY)).toBe(1_000);
  });

  it("passes a non-finite local clock through unchanged", () => {
    expect(serverNowMs(Number.NaN, 250)).toBeNaN();
  });

  it("with zero offset is exactly the local clock (PO-parity default)", () => {
    expect(serverNowMs(1_234_567, 0)).toBe(1_234_567);
  });
});
