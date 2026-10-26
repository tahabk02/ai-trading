import { describe, it, expect } from "vitest";
import { ALL_UNIVERSE_TICKERS } from "@/constants/symbols";
import {
  buildSignalView,
  SignalHoldBuffer,
  type SignalHoldView,
} from "@/lib/realtimeCandleAggregator";
import {
  targetCandlesEnabled,
  TIER_ORDER,
} from "@/lib/signalTiers";
import {
  targetCandlesLabelFor,
  formatTargetCandlesLabel,
  targetReasonCopy,
  targetRenderState,
  targetStateForPayload,
  targetZoneEnabled,
} from "@/lib/signalRender";

// Visualization must never inherit the execution gate. Every /predict verdict
// with a target is drawn; tier, regime gate and confidence only decide whether
// a trade may be placed (TradingPanel / executeTrade).
const GATES = [null, "scored_only", "pending_high_precision", "tradable"] as const;
const TIERS = [...TIER_ORDER, "PREMIUM", null] as const;

const payload = (over: Record<string, unknown> = {}) => ({
  tier: "T5",
  regime_gate: "pending_high_precision",
  suppressed_reason: "otc_hf_fail",
  target_price: 1.085,
  ...over,
});

const view = (over: Partial<SignalHoldView> = {}): SignalHoldView => ({
  gatedSignal: null,
  rawSignal: null,
  tier: "T5",
  bucketSec: 60,
  suppressedReason: null,
  regimeGate: null,
  regimeDetail: null,
  ...over,
});

describe("target visualization is independent of execution eligibility", () => {
  it("renders the target for every symbol x gate x tier when a price exists", () => {
    const UNIVERSE = [...new Set(ALL_UNIVERSE_TICKERS)];
    expect(UNIVERSE).toHaveLength(26);
    for (const symbol of UNIVERSE) {
      for (const gate of GATES) {
        for (const tier of TIERS) {
          for (const price of [0, 1.085]) {
            const st = targetStateForPayload(
              payload({ symbol, regime_gate: gate, tier, target_price: price }),
            );
            expect(st.showTarget).toBe(true);
            expect(st.regimeGate).toBe(gate);
            expect(st.reason).toBe(price > 0 ? null : "no_target");
            const copy = targetReasonCopy(st.reason, st.detail);
            expect(copy.label.length).toBeGreaterThan(0);
            expect(copy.hint.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("every tier, including absent/unknown, keeps the projection enabled", () => {
    for (const tier of [...TIER_ORDER, "PREMIUM", null, undefined, "T9"]) {
      expect(targetCandlesEnabled(tier)).toBe(true);
    }
  });

  it("targetZoneEnabled ignores regime gate and tier", () => {
    for (const gate of GATES) {
      for (const tier of TIERS) {
        for (const reason of ["too_late", "regime_scored_only", null] as const) {
          expect(
            targetZoneEnabled(
              view({ regimeGate: gate, tier, suppressedReason: reason }),
            ),
          ).toBe(true);
        }
      }
    }
  });

  it("the HUD label renders the genuine candle count at every tier", () => {
    for (const tier of TIERS) {
      const label = targetCandlesLabelFor(
        view({ tier, regimeGate: "pending_high_precision" }),
        5,
      );
      expect(label).toEqual({ enabled: true, count: 5 });
      expect(formatTargetCandlesLabel(label)).toBe("5 candles");
    }
  });

  it("an absent payload is still the honest AWAITING VERDICT state", () => {
    const st = targetStateForPayload(null);
    expect(st.showTarget).toBe(false);
    expect(st.reason).toBe("regime_review");
    expect(st.detail).toBe("awaiting_payload");
    expect(targetReasonCopy(st.reason, st.detail).label).toBe("AWAITING VERDICT");
  });

  it("the payload and view surfaces report the same render state", () => {
    const fromPayload = targetStateForPayload(
      payload({ tier: "T5", regime_gate: "pending_high_precision", suppressed_reason: "otc_hf_fail" }),
      1.085,
    );
    const fromView = targetRenderState(
      view({
        tier: "T5",
        regimeGate: "pending_high_precision",
        regimeDetail: "otc_hf_fail",
      }),
      1.085,
    );
    expect(fromPayload).toEqual(fromView);
    expect(fromPayload.showTarget).toBe(true);
    expect(fromPayload.reason).toBeNull();
  });
});

describe("execution gating remains separate from visualization", () => {
  it("a low-confidence prediction still carries a raw direction for the chart", () => {
    const blocked = buildSignalView({ signal: "SELL", confidence: 25 });
    expect(blocked.gated).toBe(false);
    expect(blocked.gatedSignal).toBeNull();
    expect(blocked.rawSignal).toBe("SELL");

    const st = targetRenderState(
      view({ gatedSignal: blocked.gatedSignal, rawSignal: blocked.rawSignal }),
      1.085,
    );
    expect(st.showTarget).toBe(true);
    expect(st.signal).toBe("SELL");
  });

  it("the hold buffer still blanks execution directions on too_late/scored_only", () => {
    const buf = new SignalHoldBuffer({ holdNeutralEvals: 2, commitBucketSec: 60 });
    buf.evaluate("BUY", 100, 60, "too_late", 100_000, "T5", "pending_high_precision", "otc_hf_fail");
    const v = buf.view();
    expect(v.gatedSignal).toBeNull();
    expect(v.suppressedReason).toBe("too_late");
    // Display still has a projection surface; only the order gate is closed.
    expect(targetZoneEnabled(v)).toBe(true);
    expect(targetRenderState(v, 1.085).showTarget).toBe(true);
    expect(targetRenderState(v, 1.085).reason).toBeNull();
  });
});
