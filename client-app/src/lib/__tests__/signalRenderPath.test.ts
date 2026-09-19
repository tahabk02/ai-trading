import { describe, it, expect } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import { SignalHoldBuffer } from "@/lib/realtimeCandleAggregator";
import { barTintForBufferedSignal } from "@/lib/signalRender";

// ── PART 11 — THE SIGNAL RENDER PATH ──
// The production flicker: two store writers (`fetchPrediction` REST at
// useTradingStore.ts:1335 and `applyLiveSignal` WS at :1909) flip
// `predictionData.signal/confidence` on separate cadences. The chart HUD label
// reads the SignalHoldBuffer-stabilized `effectiveSignal()` (financial-chart
// line ~1264), so the BUFFER is fine — but the tests in the PART 8/9 block fed
// clean, seconds-spaced synthetic `wallSec` values (t = 100, 200, 220) that the
// REAL render path never produces. In production:
//   • the paint loop re-evaluates effectiveSignal() every rAF frame/1s HUD tick
//   • `wallSec` is the broker-grid bucket floor, constant between prints
//   • so two null READS arrive ~100ms apart, exactly at the instant the freeze
//     releases on bucket rollover — and 2 consecutive reads cleared the label.
// These tests replay THAT render path (read compression + real clock) so the
// gap is enforced, not just the buffer unit behavior.

describe("PART 11 — HUD/paint render path consumes effectiveSignal(), not the raw store field", () => {
  const HYST = 1500; // matches SignalHoldBuffer default neutralHysteresisMs
  // (measured p95(inter-read jitter) * 1.5 = 984ms * 1.5 = 1476ms → 1500ms)

  it("rollover flicker: ms-apart null reads at ONE wallSec no longer clear a released label", () => {
    const buf = new SignalHoldBuffer({
      holdNeutralEvals: 2,
      commitBucketSec: 60,
    });
    // M1 bucket floor 100 — commit BUY. The broker print advances the grid
    // floor to 160 on the NEXT genuine print, so the freeze (60s) releases.
    expect(buf.evaluate("BUY", 100, 60, null, 100_000)).toBe("BUY");

    // Bucket rollover. Raw goes briefly null (below the 96.5% gate) because
    // the WS writer landed a low-confidence frame while the REST poll hasn't
    // refreshed. Three reads compressed onto the SAME wallSec=160, only a few
    // hundred ms apart in real time:
    expect(buf.evaluate(null, 160, 60, null, 160_050)).toBe("BUY");
    expect(buf.evaluate(null, 160, 60, null, 160_380)).toBe("BUY"); // pre-fix: cleared here
    expect(buf.evaluate(null, 160, 60, null, 160_740)).toBe("BUY");

    // Raw returns above the gate — re-commit is immediate, no stuck stale.
    expect(buf.evaluate("BUY", 160, 60, null, 160_900)).toBe("BUY");
  });

  it("a GENUINE sustained neutral still clears — just not on two render frames", () => {
    const buf = new SignalHoldBuffer({
      holdNeutralEvals: 2,
      commitBucketSec: 60,
    });
    buf.evaluate("BUY", 100, 60, null, 100_000);
    // Reads at the release wallSec=160, observed against the REAL clock:
    expect(buf.evaluate(null, 160, 60, null, 160_050)).toBe("BUY"); // 1st counted
    expect(buf.evaluate(null, 160, 60, null, 160_380)).toBe("BUY"); // <2.5s later → not counted
    expect(buf.evaluate(null, 160, 60, null, 163_100)).toBeNull(); // ≥1.5s gap → 2nd counted → clears
  });

  it("bar tint is driven by the BUFFERED value — the unbuffered paint read is gone", () => {
    const base = {
      time: 160 as UTCTimestamp,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100.2,
    };
    const GREEN = "#16c784";
    const RED = "#ea3943";
    const GAP = "rgba(148,163,184,0.12)";

    // Raw store says BUY, but the buffer is still frozen-neutral → bars stay
    // base (NO green). Pre-PART 11 the paint path read the raw field here.
    const neutralBars = barTintForBufferedSignal(base, false, null, GAP, GREEN, RED);
    expect(neutralBars.color).toBeUndefined();
    expect(neutralBars.borderColor).toBeUndefined();

    // Buffer releases BUY → bars go green.
    const buyBars = barTintForBufferedSignal(base, false, "BUY", GAP, GREEN, RED);
    expect(buyBars.color).toBe(GREEN);

    // Buffer releases SELL → bars go red.
    const sellBars = barTintForBufferedSignal(base, false, "SELL", GAP, GREEN, RED);
    expect(sellBars.color).toBe(RED);

    // Gap rows stay gap-colored no matter what the buffered signal says.
    const gapBars = barTintForBufferedSignal(base, true, "BUY", GAP, GREEN, RED);
    expect(gapBars.color).toBe(GAP);
  });

  it("a raw SELL mid-freeze cannot re-tint bars while the buffer holds BUY", () => {
    const buf = new SignalHoldBuffer({
      holdNeutralEvals: 2,
      commitBucketSec: 60,
    });
    buf.evaluate("BUY", 100, 60, null, 100_000);
    // WS writer flips the raw field INSIDE the same bucket (freeze window).
    const held = buf.evaluate("SELL", 130, 60, null, 130_200);
    expect(held).toBe("BUY");
    const bars = barTintForBufferedSignal(
      { time: 130 as UTCTimestamp, open: 100, high: 100.5, low: 99.5, close: 100.2 },
      false,
      held,
      "gap",
      "green",
      "red",
    );
    expect(bars.color).toBe("green");
  });
});