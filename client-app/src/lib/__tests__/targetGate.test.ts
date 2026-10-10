import { describe, it, expect } from "vitest";
import { ALL_UNIVERSE_TICKERS } from "@/constants/symbols";
import { SignalHoldBuffer, type SignalHoldView } from "@/lib/realtimeCandleAggregator";
import { targetCandlesEnabled, TIER_ORDER } from "@/lib/signalTiers";
import {
  targetCandlesLabelFor,
  formatTargetCandlesLabel,
  targetReasonCopy,
  targetRenderState,
  targetStateForPayload,
  targetZoneEnabled,
  type TargetWithheldReason,
} from "@/lib/signalRender";

// ── PART 40 [394]/[395] — THE TARGET GATE ──
// The gate is TWO inputs off ONE view: regime_gate === "tradable" AND tier in
// T1–T3. Nothing else may widen it (confidence, feed status, symbol), and a
// withheld target must always carry the engine's stated reason — a blank slot
// is a defect, an unauthorized target is a worse one. This suite pins BOTH
// halves over the whole 44-symbol universe and the full gate × tier matrix.

const GATES = [null, "scored_only", "pending_high_precision", "tradable"] as const;
const TIERS = [...TIER_ORDER, "PREMIUM", null] as const;

const payload = (over: Record<string, unknown> = {}) => ({
  tier: "T5",
  regime_gate: "pending_high_precision",
  suppressed_reason: "otc_hf_fail",
  target_price: 1.085,
  ...over,
});

describe("PART 40 [394] — showTarget ⇔ regime_gate tradable AND tier T1–T3 (the ONLY two inputs)", () => {
  it("holds for every symbol × gate × tier × target-price combination", () => {
    // OTC_FOREX_PAIRS spreads REAL_FOREX_PAIRS, so the ticker list carries the
    // 10 real pairs twice — the universe is the 44 DISTINCT instruments.
    const UNIVERSE = [...new Set(ALL_UNIVERSE_TICKERS)];
    expect(UNIVERSE).toHaveLength(44);
    for (const symbol of UNIVERSE) {
      for (const gate of GATES) {
        for (const tier of TIERS) {
          for (const price of [0, 1.085]) {
            const st = targetStateForPayload(
              payload({ symbol, regime_gate: gate, tier, target_price: price }),
            );
            const inZone =
              gate === "tradable" && targetCandlesEnabled(tier as string | null);
            expect(st.showTarget).toBe(inZone);
            expect(st.regimeGate).toBe(gate);
            if (st.showTarget) {
              // A gated target with no value is stated, never silently blank.
              expect(st.reason).toBe(price > 0 ? null : "no_target");
            } else {
              expect(st.reason).not.toBeNull();
            }
            const copy = targetReasonCopy(st.reason, st.detail);
            expect(copy.label.length).toBeGreaterThan(0);
            expect(copy.hint.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("an open gate does NOT widen it past the tier (tradable + T5 stays withheld)", () => {
    const st = targetStateForPayload(payload({ regime_gate: "tradable", tier: "T5" }));
    expect(st.showTarget).toBe(false);
    expect(st.reason).toBe("below_tier");
    expect(targetCandlesLabelFor({ tier: "T5", regimeGate: st.regimeGate }, 5).enabled).toBe(false);
  });

  it("a tradable tier does NOT widen it past the gate (pending + T1 stays withheld)", () => {
    const st = targetStateForPayload(payload({ regime_gate: "pending_high_precision", tier: "T1" }));
    expect(st.showTarget).toBe(false);
    expect(st.reason).toBe("pending_high_precision");
    expect(targetCandlesLabelFor({ tier: "T1", regimeGate: st.regimeGate }, 5).enabled).toBe(false);
  });

  it("fails CLOSED on an unknown/missing gate — no ghost projection", () => {
    for (const gate of [null, undefined, "", "   ", "garbage", "enabled", "ready"]) {
      const st = targetStateForPayload(
        payload({ regime_gate: gate as string | null | undefined, tier: "T1" }),
      );
      expect(st.showTarget).toBe(false);
      expect(st.reason).not.toBeNull();
    }
  });

  it("tolerates case/whitespace on the ONE value that may open the gate", () => {
    for (const gate of ["tradable", "TRADABLE", " Tradable ", "tradable\t"]) {
      const st = targetStateForPayload(payload({ regime_gate: gate, tier: "T2" }));
      expect(st.showTarget).toBe(true);
      expect(st.reason).toBeNull();
    }
  });

  it("an absent payload is the honest AWAITING VERDICT state, not a blank", () => {
    const st = targetStateForPayload(null);
    expect(st.showTarget).toBe(false);
    expect(st.reason).toBe("regime_review");
    expect(st.detail).toBe("awaiting_payload");
    expect(targetReasonCopy(st.reason, st.detail).label).toBe("AWAITING VERDICT");
  });
});

describe("PART 40 [394] — the SAME gate drives the view-level surfaces (candles + HUD label)", () => {
  const tick = (
    buf: SignalHoldBuffer,
    tier: string | null,
    gate: string | null,
    detail: string | null,
    raw: "BUY" | "SELL" | null = "BUY",
  ): SignalHoldView => {
    buf.evaluate(raw, 100, 60, null, 100_000, tier, gate, detail);
    return buf.view();
  };

  it("T2 + tradable → zone open, candles + label render", () => {
    const v = tick(new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 }), "T2", "tradable", "high_precision_composite");
    expect(targetZoneEnabled(v)).toBe(true);
    expect(targetCandlesLabelFor(v, 5)).toEqual({ enabled: true, count: 5 });
    expect(formatTargetCandlesLabel(targetCandlesLabelFor(v, 5))).toBe("5 candles");
    const st = targetRenderState(v, 1.085);
    expect(st.showTarget).toBe(true);
    expect(st.reason).toBeNull();
  });

  it("T2 + pending_high_precision → zone closed, label blank with the engine reason", () => {
    const v = tick(new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 }), "T2", "pending_high_precision", "below_high_precision_bar");
    expect(targetZoneEnabled(v)).toBe(false);
    expect(targetCandlesLabelFor(v, 5)).toEqual({ enabled: false, count: null });
    expect(formatTargetCandlesLabel(targetCandlesLabelFor(v, 5))).toBeNull();
    const st = targetRenderState(v, 1.085);
    expect(st.showTarget).toBe(false);
    expect(st.reason).toBe("pending_high_precision");
    expect(targetReasonCopy(st.reason, st.detail).label).toBe(
      "PENDING HIGH PRECISION · BELOW_HIGH_PRECISION_BAR",
    );
  });

  it("the gate is committed on EVERY evaluate, suppressed returns included", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    tick(buf, "T2", "tradable", "high_precision_composite");
    expect(buf.view().regimeGate).toBe("tradable");
    // too_late suppression blanks the signal but the LATEST gate still lands —
    // the projection must follow the current verdict, not a frozen one.
    buf.evaluate("SELL", 70, 60, "too_late", 70_000, "T2", "pending_high_precision", "otc_hf_fail");
    const v = buf.view();
    expect(v.suppressedReason).toBe("too_late");
    expect(v.regimeGate).toBe("pending_high_precision");
    expect(targetZoneEnabled(v)).toBe(false);
    expect(targetRenderState(v, 1.085).reason).toBe("too_late");
  });
});

describe("PART 40 [395] — every withheld state carries one truthful reason", () => {
  const view = (over: Partial<SignalHoldView>): SignalHoldView => ({
    gatedSignal: null,
    tier: "T5",
    bucketSec: 60,
    suppressedReason: null,
    regimeGate: null,
    regimeDetail: null,
    ...over,
  });

  const cases: Array<{
    name: string;
    view: SignalHoldView;
    price: number;
    reason: TargetWithheldReason;
    showTarget: boolean;
  }> = [
    {
      name: "engine demoted the emission (too_late outranks the open gate)",
      view: view({ tier: "T4", regimeGate: "tradable", suppressedReason: "too_late" }),
      price: 1.085,
      reason: "too_late",
      showTarget: false,
    },
    {
      name: "feed outside safety bounds (outranks a closed gate)",
      view: view({ regimeGate: "pending_high_precision", regimeDetail: "stale_market_out_of_safety_bounds" }),
      price: 1.085,
      reason: "stale_feed",
      showTarget: false,
    },
    {
      name: "random_walk regime",
      view: view({ regimeGate: "scored_only", suppressedReason: "regime_scored_only" }),
      price: 1.085,
      reason: "scored_only",
      showTarget: false,
    },
    {
      name: "regime not cleared (the live state of all 44 symbols)",
      view: view({ regimeGate: "pending_high_precision", regimeDetail: "otc_hf_fail" }),
      price: 1.085,
      reason: "pending_high_precision",
      showTarget: false,
    },
    {
      name: "gate open, band too low",
      view: view({ regimeGate: "tradable", tier: "T5" }),
      price: 1.085,
      reason: "below_tier",
      showTarget: false,
    },
    {
      name: "no verdict yet",
      view: view({ regimeGate: null }),
      price: 1.085,
      reason: "regime_review",
      showTarget: false,
    },
    {
      name: "gate open, no price in the payload",
      view: view({ gatedSignal: "BUY", regimeGate: "tradable", tier: "T2" }),
      price: 0,
      reason: "no_target",
      showTarget: true,
    },
  ];

  for (const c of cases) {
    it(`${c.name} → "${c.reason}"`, () => {
      const st = targetRenderState(c.view, c.price);
      expect(st.reason).toBe(c.reason);
      expect(st.showTarget).toBe(c.showTarget);
      if (st.showTarget) {
        expect(c.reason).toBe("no_target"); // the only gated-but-empty state
        expect(st.signal).not.toBeNull();
      } else {
        expect(st.signal).toBeNull();
      }
      const copy = targetReasonCopy(st.reason, st.detail);
      expect(copy.label).not.toHaveLength(0);
      expect(copy.hint).not.toHaveLength(0);
    });
  }

  it("too_late outranks a closed gate (the most specific verdict wins)", () => {
    const st = targetRenderState(
      view({ tier: "T4", suppressedReason: "too_late", regimeGate: "pending_high_precision", regimeDetail: "otc_hf_fail" }),
      1.085,
    );
    expect(st.reason).toBe("too_late");
  });

  it("the same withheld state reads identically for a payload and for a view", () => {
    const fromPayload = targetStateForPayload(
      payload({ tier: "T5", regime_gate: "pending_high_precision", suppressed_reason: "otc_hf_fail" }),
      1.085,
    );
    const fromView = targetRenderState(
      view({ tier: "T5", regimeGate: "pending_high_precision", regimeDetail: "otc_hf_fail" }),
      1.085,
    );
    expect(fromPayload).toEqual(fromView);
    expect(targetReasonCopy(fromPayload.reason, fromPayload.detail)).toEqual(
      targetReasonCopy(fromView.reason, fromView.detail),
    );
  });
});
