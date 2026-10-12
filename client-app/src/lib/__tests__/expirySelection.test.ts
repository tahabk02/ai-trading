import { describe, it, expect } from "vitest";
import {
  MIN_ACTIONABLE_WINDOW_MS,
  expiryCountdownRemainingSeconds,
  expirySelectionState,
  expirySelectorState,
  remainingToBucketCloseMs,
} from "@/lib/expirySelection";
import { MIN_EXECUTABLE_TIER } from "@/lib/signalTiers";

const PRO_EXPIRY_OPTIONS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "3m", seconds: 180 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
];

describe("PART 24 [163] — switching expiry on a scored_only/T5 symbol never produces an actionable-looking state", () => {
  it("T5 WEAK: no option is action-ready at any point in the bucket sweep", () => {
    for (let now = 0; now < 60_000; now += 1_000) {
      const st = expirySelectorState("T5", null, 60, now, PRO_EXPIRY_OPTIONS);
      expect(st.zoneActive).toBe(false);
      expect(st.anyActionable).toBe(false);
      expect(st.blockedReason).toBe("low_tier");
      for (const opt of st.options) {
        expect(opt.actionReady).toBe(false);
        expect(opt.regimeBlocked).toBe(true);
      }
    }
  });

  it("random_walk scored_only: never tradable even at T1 confidence", () => {
    const st = expirySelectorState(
      "T1",
      "regime_scored_only",
      60,
      30_000,
      PRO_EXPIRY_OPTIONS,
    );
    expect(st.zoneActive).toBe(false);
    expect(st.anyActionable).toBe(false);
    expect(st.blockedReason).toBe("regime_scored_only");
    for (const opt of st.options) {
      expect(opt.actionReady).toBe(false);
      expect(opt.regimeBlocked).toBe(true);
    }
  });

  it("STRICT 96.5% BAR: pending_high_precision (sub-96.5% executable=false) blocks every expiry — never tradable", () => {
    const st = expirySelectorState(
      "T1",
      "pending_high_precision",
      60,
      30_000,
      PRO_EXPIRY_OPTIONS,
    );
    expect(st.zoneActive).toBe(false);
    expect(st.anyActionable).toBe(false);
    expect(st.blockedReason).toBe("regime_pending_high_precision");
    for (const opt of st.options) {
      expect(opt.actionReady).toBe(false);
      expect(opt.regimeBlocked).toBe(true);
    }
  });

  it("no tier yet: selector is held (no data / awaiting first /predict), never actionable", () => {
    const st = expirySelectorState(null, null, 60, 30_000, PRO_EXPIRY_OPTIONS);
    expect(st.zoneActive).toBe(false);
    expect(st.anyActionable).toBe(false);
    expect(st.blockedReason).toBe("no_tier");
  });

  it("genuine T2 mid-bucket: the projection zone is active and 1m fits", () => {
    const st = expirySelectorState("T2", null, 60, 30_000, PRO_EXPIRY_OPTIONS);
    expect(st.zoneActive).toBe(true);
    expect(st.anyActionable).toBe(true);
    expect(st.blockedReason).toBeNull();
    expect(st.options[0].actionReady).toBe(true); // 1m
    expect(st.options[4].actionReady).toBe(true); // 10m
  });

  it("strict execution floor (MIN_EXECUTABLE_TIER=T1) stays honest: T5/T4/T3/T2 are all sub-executable; only T1 dispatches", () => {
    // Projection-horizon floor (default TARGET_CANDLES_MIN_TIER=T3): T1-T3 only.
    const proT4 = expirySelectorState("T4", null, 60, 30_000, PRO_EXPIRY_OPTIONS);
    expect(proT4.zoneActive).toBe(false); // T4 LOW has no projection zone
    expect(proT4.blockedReason).toBe("low_tier");
    const proT3 = expirySelectorState("T3", null, 60, 30_000, PRO_EXPIRY_OPTIONS);
    expect(proT3.zoneActive).toBe(true);
    // Strict execution floor (MIN_EXECUTABLE_TIER=T1 96.5%): only T1 is
    // executable; T2/T3/T4T5 are all honest low_tier holds.
    const execT5 = expirySelectorState(
      "T5",
      null,
      60,
      30_000,
      PRO_EXPIRY_OPTIONS,
      MIN_EXECUTABLE_TIER,
    );
    expect(execT5.zoneActive).toBe(false);
    expect(execT5.blockedReason).toBe("low_tier");
    const execT4 = expirySelectorState(
      "T4",
      null,
      60,
      30_000,
      PRO_EXPIRY_OPTIONS,
      MIN_EXECUTABLE_TIER,
    );
    expect(execT4.zoneActive).toBe(false);
    expect(execT4.blockedReason).toBe("low_tier");
    const execT1 = expirySelectorState(
      "T1",
      null,
      60,
      30_000,
      PRO_EXPIRY_OPTIONS,
      MIN_EXECUTABLE_TIER,
    );
    expect(execT1.zoneActive).toBe(true);
    expect(execT1.anyActionable).toBe(true);
  });
});

describe("PART 24 [161] — MIN_ACTIONABLE_WINDOW_MS alignment per expiry choice", () => {
  it("remainingToBucketCloseMs matches the broker-grid bucket geometry", () => {
    expect(remainingToBucketCloseMs(0, 60)).toBe(60_000);
    expect(remainingToBucketCloseMs(59_000, 60)).toBe(1_000);
    expect(remainingToBucketCloseMs(30_000, 60)).toBe(30_000);
    expect(remainingToBucketCloseMs(125_000, 120)).toBe(115_000);
  });

  it("1m expiry in the final sub-window of the M1 bucket is too_late and slides to 2m, never silently accepted as 1m", () => {
    const now = 59_000; // 1s before the bucket closes, less than the 1.5s window
    const s = expirySelectionState(60, "1m", 60, now);
    expect(s.tooLate).toBe(true);
    expect(s.actionReady).toBe(false);
    expect(s.reason).toBe("too_late");
    expect(s.alignedSeconds).toBe(120); // silently accepting would have kept 60
    expect(s.remainingToBucketCloseMs).toBe(1_000);
  });

  it("options whose aligned landing clears the window stay actionable", () => {
    const now = 59_000;
    for (const exp of [120, 180, 300, 600]) {
      const s = expirySelectionState(exp, `${exp}s`, 60, now);
      expect(s.tooLate).toBe(false);
      expect(s.actionReady).toBe(true);
      expect(s.alignedSeconds).toBe(exp);
    }
  });

  it("at a fresh bucket edge nothing is too_late (full window available)", () => {
    const now = 1000; // just past the bucket floor — a full 60s remains
    const s = expirySelectionState(60, "1m", 60, now);
    expect(s.tooLate).toBe(false);
    expect(s.alignedSeconds).toBe(60);
  });

  it("the boundary is exact: remaining === window is actionable, remaining < window is not", () => {
    const window = 1500;
    expect(MIN_ACTIONABLE_WINDOW_MS).toBe(window);
    // now = bucketFloor + 58_500 → 1500ms remaining → still actionable.
    const atWindow = expirySelectionState(60, "1m", 60, 58_500, window);
    expect(atWindow.tooLate).toBe(false);
    // now = bucketFloor + 58_700 → 1300ms remaining → too late.
    const belowWindow = expirySelectionState(60, "1m", 60, 58_700, window);
    expect(belowWindow.tooLate).toBe(true);
    expect(belowWindow.alignedSeconds).toBe(120);
  });
});

describe("expiry countdown", () => {
  it("counts down from the selected duration without reset inputs", () => {
    expect(expiryCountdownRemainingSeconds(0, 0, 60)).toBe(60);
    expect(expiryCountdownRemainingSeconds(1_000, 0, 60)).toBe(59);
    expect(expiryCountdownRemainingSeconds(59_000, 0, 60)).toBe(1);
    expect(expiryCountdownRemainingSeconds(60_000, 0, 60)).toBe(0);
    expect(expiryCountdownRemainingSeconds(119_500, 0, 60)).toBe(0);
  });

  it("rejects invalid durations", () => {
    expect(expiryCountdownRemainingSeconds(1_000, 0, 0)).toBe(0);
    expect(expiryCountdownRemainingSeconds(Number.NaN, 0, 60)).toBe(0);
  });
});
