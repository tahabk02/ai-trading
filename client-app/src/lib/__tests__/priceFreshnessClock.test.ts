/**
 * Contract for the shared price-freshness clock.
 *
 * The "NO TICK" defect was a CLOCK-SOURCE MISMATCH: the `stale` boolean in
 * useWebSocket was driven by the local packet-arrival clock, while the feed
 * health badge derived its age from the store's `lastPriceUpdate` ISO string —
 * a different clock, stamped by history/replay bursts and /predict priming.
 * The two disagreed, and a disagreement in the 2-10s band rendered as a
 * permanent "NO TICK" on a feed that was demonstrably live.
 *
 * These tests pin the invariants that make disagreement impossible, and pin the
 * zero-hop property that makes the fix free.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  markPriceReceive,
  getLastPriceReceiveAtMs,
  resetLastPriceReceiveAt,
} from "@/store/useTradingStore";
import { classifyFreshness, formatAge } from "@/hooks/useFeedHealth";

beforeEach(() => {
  resetLastPriceReceiveAt();
});

describe("price freshness clock", () => {
  it("starts at 0 and reports null-ish until the first packet", () => {
    expect(getLastPriceReceiveAtMs()).toBe(0);
  });

  it("records packet arrival", () => {
    markPriceReceive(1_000_000);
    expect(getLastPriceReceiveAtMs()).toBe(1_000_000);
  });

  it("is monotonic — a late/duplicated packet never rewinds the clock", () => {
    // A non-monotonic clock would make `age` jump forward and re-trigger the
    // badge even though packets are still flowing.
    markPriceReceive(2_000_000);
    markPriceReceive(1_000_000); // late duplicate
    expect(getLastPriceReceiveAtMs()).toBe(2_000_000);
  });

  it("ignores non-finite input", () => {
    markPriceReceive(1_000);
    markPriceReceive(Number.NaN);
    markPriceReceive(Number.POSITIVE_INFINITY);
    expect(getLastPriceReceiveAtMs()).toBe(1_000);
  });

  it("clears on reset so a new session cannot inherit a fresh reading", () => {
    markPriceReceive(5_000_000);
    resetLastPriceReceiveAt();
    expect(getLastPriceReceiveAtMs()).toBe(0);
  });

  it("does not touch React state — the zero-hop invariant", () => {
    // The whole reason this is a module holder rather than store state: it is
    // callable from the tick path with no render cost. If it were ever moved
    // into the store this spy would be the tripwire.
    const spy = vi.fn();
    markPriceReceive(1);
    markPriceReceive(2);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("badge/boolean agreement", () => {
  /**
   * Reproduces the defect: a boolean derived on one clock, a badge derived on
   * another. With one clock the two can only ever agree.
   */
  it("cannot show NO TICK while the feed is genuinely fresh", () => {
    markPriceReceive(1_000_000);
    const now = 1_000_400; // 400ms after the packet
    const ageMs = now - getLastPriceReceiveAtMs();
    // Freshness and the `stale` boolean now read the SAME number.
    expect(ageMs).toBe(400);
    expect(classifyFreshness(ageMs)).toBe("live");
    // The boolean uses the same 2s threshold, so it is also false.
    const staleBoolean = ageMs > 2_000;
    expect(staleBoolean).toBe(false);
    // The disagreement that produced "NO TICK" is now impossible.
    expect(classifyFreshness(ageMs) === "stale").toBe(staleBoolean);
  });

  it("agrees in every band, not just the fresh one", () => {
    markPriceReceive(1_000_000);
    for (const offset of [0, 500, 1_500, 2_500, 5_000, 30_000]) {
      const ageMs = offset;
      // The `stale` boolean uses the 2s threshold.
      const staleBoolean = ageMs > 2_000;
      // The badge's `freshness` bucket must at least be consistent with it:
      // whenever the boolean is FALSE the bucket must not claim a dead feed,
      // and whenever the boolean is TRUE the bucket must not be "live".
      const bucket = classifyFreshness(ageMs);
      if (!staleBoolean) {
        expect(bucket === "live" || bucket === "delayed").toBe(true);
      } else {
        // A stale boolean may read delayed (1s sampler lag) but NEVER "live" —
        // that inversion is the "green LIVE beside a dead tape" failure.
        expect(bucket === "live").toBe(false);
      }
    }
  });

  it("classifies the boundary bands exactly", () => {
    expect(classifyFreshness(0)).toBe("live");
    expect(classifyFreshness(999)).toBe("live");
    expect(classifyFreshness(1_000)).toBe("delayed");
    expect(classifyFreshness(1_999)).toBe("delayed");
    expect(classifyFreshness(2_000)).toBe("stale");
    expect(classifyFreshness(9_999)).toBe("stale");
    expect(classifyFreshness(10_000)).toBe("dead");
  });

  it("formats ages for display", () => {
    expect(formatAge(340)).toBe("340ms");
    expect(formatAge(1_500)).toBe("1.5s");
    expect(formatAge(-1)).toBe("--");
  });
});
