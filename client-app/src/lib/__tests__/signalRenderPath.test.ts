import { describe, it, expect } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import {
  SignalHoldBuffer,
  buildTargetCandles,
  type SignalHoldView,
} from "@/lib/realtimeCandleAggregator";
import { targetCandlesEnabled } from "@/lib/signalTiers";
import {
  barTintForBufferedSignal,
  signalBadgeFor,
  targetCandlesLabelFor,
  formatTargetCandlesLabel,
} from "@/lib/signalRender";

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

// ── PART 21 [137] — THE T2→T5 TRANSITION THROUGH THE REAL CHAIN ──
// One evaluate() produces ONE SignalHoldView; HUD (a), target-candle gate (b)
// and the card badge (c) all read THAT object. A drift bug in any single
// consumer shows up as a single coherence assertion failure here — the
// integration gap PART 20 slipped through (three unit tests passing while the
// renderers disagreed).
describe("PART 21 [137] — tier transition T2→T5; HUD, target candles & badge read ONE view", () => {
  // Pure seam mirroring financial-chart's currentSignalView(): bucket floor
  // (wallSec), hysteresis real clock (realMs), raw gate output, raw tier — fed
  // to the REAL SignalHoldBuffer, then ONE view() consumed by everyone.
  const tick = (
    buf: SignalHoldBuffer,
    rawGated: "BUY" | "SELL" | null,
    wallSec: number,
    realMs: number,
    rawTier: string | null,
  ): SignalHoldView => {
    buf.evaluate(rawGated, wallSec, 60, null, realMs, rawTier);
    return buf.view();
  };

  const candlesFor = (v: SignalHoldView) =>
    buildTargetCandles({
      liveTipBucketMs: v.bucketSec * 1000,
      liveClose: 100,
      targetPrice: 105,
      atr: 1,
      signal: v.gatedSignal,
      tier: v.tier,
      expirationSeconds: 300,
      timeframeSeconds: 60,
    });

  // ONE assertion for ALL the render consumers: badge↔HUD, gate↔view tier, and
  // PART 24 [158] — the "TARGET CANDLES N candles" HUD TEXT follows the SAME
  // view.tier as the shape (a label that drifted independently of the shape is
  // exactly the PART 20/22 drift class, so it belongs in this coherence block).
  const assertCoherent = (v: SignalHoldView) => {
    const badge = signalBadgeFor(v);
    const candles = candlesFor(v);
    const label = targetCandlesLabelFor(v, 5);
    const labelText = formatTargetCandlesLabel(label);
    expect(badge.direction).toBe(v.gatedSignal); // (c) card badge == HUD view
    expect(candles.length > 0).toBe(targetCandlesEnabled(v.tier)); // (b) candle gate == view tier
    expect(label.enabled).toBe(targetCandlesEnabled(v.tier)); // (d) PART 24 label gate == view tier
    expect(label.count != null).toBe(label.enabled); // count only when enabled
    expect(labelText !== null).toBe(label.enabled);
    return { badge, candles, label, labelText };
  };

  it("T2 BUY commits with candles; a mid-freeze T5 drop cannot tear label and candles apart", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    // Tick 1 — T2 BUY commits on bucket floor 100.
    let v = tick(buf, "BUY", 100, 100_000, "T2");
    expect(v.gatedSignal).toBe("BUY");
    expect(v.tier).toBe("T2");
    let { candles } = assertCoherent(v);
    expect(candles.length).toBe(5); // T2 renders the trajectory

    // Tick 2 — INSIDE the freeze window a fresh /predict lands T5 (sub-gate
    // confidence → raw neutral). The HUD label AND the candles must stay
    // coherent, not drift to a split dispatch.
    v = tick(buf, null, 130, 130_100, "T5");
    expect(v.gatedSignal).toBe("BUY"); // (a) hysteresis: still held
    const t2 = assertCoherent(v);
    expect(t2.candles.length).toBe(5); // (b) NOT ripped out mid-freeze
    expect(v.tier).toBe("T2"); // frozen beside the held direction
  });

  it("the T2→T5 drop suppresses candles EXACTLY when the label clears — one tick, one flip", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    tick(buf, "BUY", 100, 100_000, "T2");
    // Bucket rolls to 160; sustained neutral with REAL gaps clears the label.
    tick(buf, null, 160, 160_050, "T5");
    const v = tick(buf, null, 160, 163_100, "T5");
    expect(v.gatedSignal).toBeNull(); // (a) HUD cleared by the hysteresis
    expect(v.tier).toBe("T5");
    const { candles, badge } = assertCoherent(v);
    expect(targetCandlesEnabled(v.tier)).toBe(false);
    expect(candles.length).toBe(0); // (b) suppressed at the SAME tick
    expect(badge.badgeText).toBe("NO SIGNAL"); // (c) badge matches
  });

  it("a frozen contrary SELL keeps badge == label == candles (the T2 family)", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    tick(buf, "BUY", 100, 100_000, "T2");
    const v = tick(buf, "SELL", 130, 130_200, "T5");
    expect(v.suppressedReason).toBe("frozen");
    assertCoherent(v); // badge BUY, candles ON, tier T2 — all from one view
  });

  it("[136] freeze follows bucketSec, hysteresis follows realMs — the SAME chain, provably", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    tick(buf, "BUY", 100, 100_000, "T2");
    // SAME bucket floor, 50s of real time later: freeze MUST hold (bucket clock).
    let v = tick(buf, "SELL", 100, 150_000, "T5");
    expect(v.gatedSignal).toBe("BUY");
    expect(v.tier).toBe("T2");
    // Neutral hysteresis DOES follow realMs: bucket advanced to 160 but the two
    // null reads were < 1.5s apart → still held.
    tick(buf, null, 160, 160_050, "T5");
    v = tick(buf, null, 160, 160_380, "T5");
    expect(v.gatedSignal).toBe("BUY");
    // Measured-gap reads (≥1.5s) clear it.
    v = tick(buf, null, 160, 163_100, "T5");
    expect(v.gatedSignal).toBeNull();
    assertCoherent(v);
  });

  it("PART 24 [160] — at T5/WEAK the 'TARGET CANDLES N candles' TEXT does not render (not just the shape)", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    tick(buf, "BUY", 100, 100_000, "T2");
    // Sustained neutral clears the hold into T5 — the exact screenshot state:
    // a WEAK badge, an empty projection, and a label that pre-PART 24 STILL said
    // "1 candles".
    tick(buf, null, 160, 160_050, "T5");
    const v = tick(buf, null, 160, 163_100, "T5");
    expect(v.tier).toBe("T5");
    expect(targetCandlesEnabled(v.tier)).toBe(false);
    const label = targetCandlesLabelFor(v, 1); // 1 candle would have been claimed
    expect(label.enabled).toBe(false);
    expect(label.count).toBeNull();
    expect(formatTargetCandlesLabel(label)).toBeNull(); // string never assembled
  });

  it("PART 24 [160] — at T2 the label renders the genuine count (positive control)", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    const v = tick(buf, "BUY", 100, 100_000, "T2");
    const label = targetCandlesLabelFor(v, 5);
    expect(label.enabled).toBe(true);
    expect(label.count).toBe(5);
    expect(formatTargetCandlesLabel(label)).toBe("5 candles");
    assertCoherent(v);
  });

  it("PART 24 [164] — every surface agrees at T5 in one tick: blank label, empty candles, NO SIGNAL badge, no label text", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    const v = tick(buf, null, 160, 163_100, "T5");
    const { badge, candles, label, labelText } = assertCoherent(v);
    // (a) HUD direction — blank.
    expect(v.gatedSignal).toBeNull();
    // (b) candle shape — empty overlay, nothing routes into syncMarkers T-HI/T-LO.
    expect(candles.length).toBe(0);
    // (c) card badge — honest neutral.
    expect(badge.badgeText).toBe("NO SIGNAL");
    // (d) PART 24 label — count and string both absent.
    expect(label.count).toBeNull();
    expect(labelText).toBeNull();
  });
});