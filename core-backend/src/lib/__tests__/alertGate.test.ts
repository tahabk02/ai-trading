import { describe, it, expect } from "vitest";
import { isAlertEligible } from "../alertGate";

/**
 * PART 41 [403] — the backend alert predicate. A high-confidence signal may be
 * broadcast ONLY when the verdict is executable && tier in T1..T3 && regime
 * gate "tradable". A 98% score on a pending/gated verdict is silent.
 */
describe("isAlertEligible (PART 41 [403])", () => {
  it("allows an executable T1/tradable verdict", () => {
    expect(
      isAlertEligible({ executable: true, tier: "T1", regime_gate: "tradable" }),
    ).toBe(true);
  });

  it("allows the whole T1..T3 executable ladder, case/whitespace-tolerant", () => {
    for (const tier of ["T1", "T2", "T3"]) {
      expect(isAlertEligible({ executable: true, tier, regime_gate: "tradable" })).toBe(true);
    }
    expect(
      isAlertEligible({ executable: true, tier: "t2", regime_gate: " TRADABLE " }),
    ).toBe(true);
  });

  it("rejects non-executable verdicts even at 98% agreement", () => {
    expect(
      isAlertEligible({ executable: false, tier: "T1", regime_gate: "tradable" }),
    ).toBe(false);
    expect(
      isAlertEligible({ executable: undefined, tier: "T1", regime_gate: "tradable" }),
    ).toBe(false);
  });

  it("rejects T4/T5 dispatch tiers (off the executable ladder)", () => {
    expect(
      isAlertEligible({ executable: true, tier: "T4", regime_gate: "tradable" }),
    ).toBe(false);
    expect(
      isAlertEligible({ executable: true, tier: "T5", regime_gate: "tradable" }),
    ).toBe(false);
  });

  it("rejects a pending/gated regime even when executable", () => {
    expect(
      isAlertEligible({ executable: true, tier: "T1", regime_gate: "pending_high_precision" }),
    ).toBe(false);
    expect(
      isAlertEligible({ executable: true, tier: "T1", regime_gate: "scored_only" }),
    ).toBe(false);
  });

  it("fails closed on missing or garbage fields", () => {
    expect(isAlertEligible({})).toBe(false);
    expect(isAlertEligible(null as never)).toBe(false);
    expect(
      isAlertEligible({ executable: true, tier: null, regime_gate: null }),
    ).toBe(false);
    expect(
      isAlertEligible({ executable: true, tier: "no_tier", regime_gate: "tradable" }),
    ).toBe(false);
  });
});