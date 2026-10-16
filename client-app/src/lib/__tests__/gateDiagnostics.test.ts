/**
 * gateDiagnostics.test.ts — PART 52 TRANSPARENT GATE DIAGNOSTICS.
 *
 * The card must be able to say WHY a pair is locked, using the engine's own
 * reason, and NEVER invent one. These tests pin: engine-code translation,
 * unknown-code passthrough (never swallowed), and the resolution precedence
 * (engine reason → regime reason → operator filter → nothing).
 */
import { describe, it, expect } from "vitest";

import {
  GATE_REASON_COPY,
  humanizeGateReason,
  resolveCardGateDiagnostic,
} from "@/lib/gateDiagnostics";

describe("[52] humanizeGateReason", () => {
  it("translates known engine codes to readable copy", () => {
    expect(humanizeGateReason("insufficient_history")).toMatchObject({
      code: "insufficient_history",
      label: "HISTORY TOO SHORT",
      tone: "gold",
    });
    expect(humanizeGateReason("insufficient_history")?.unlock).toMatch(/160/);
    expect(humanizeGateReason("otc_hf_fail")?.label).toBe("OTC HF QUALITY FAIL");
    expect(humanizeGateReason("below_high_precision_bar")?.label).toBe(
      "CONFLUENCE UNDER BAR",
    );
    expect(humanizeGateReason("regime_scored_only")?.label).toBe(
      "RANDOM-WALK REGIME",
    );
  });

  it("normalizes case and whitespace", () => {
    expect(humanizeGateReason("  INSUFFICIENT_HISTORY  ")?.code).toBe(
      "insufficient_history",
    );
    expect(humanizeGateReason("Spread Too Wide")?.code).toBe("spread_too_wide");
  });

  it("returns null for missing/empty codes (nothing to say)", () => {
    expect(humanizeGateReason(null)).toBeNull();
    expect(humanizeGateReason(undefined)).toBeNull();
    expect(humanizeGateReason("")).toBeNull();
    expect(humanizeGateReason("   ")).toBeNull();
  });

  it("surfaces an UNKNOWN code verbatim instead of swallowing it", () => {
    const d = humanizeGateReason("brand_new_gate");
    expect(d?.code).toBe("brand_new_gate");
    expect(d?.label).toBe("BRAND NEW GATE");
    expect(d?.tone).toBe("slate");
  });

  it("every table entry carries a non-empty label and unlock hint", () => {
    for (const [code, copy] of Object.entries(GATE_REASON_COPY)) {
      expect(copy.label.length, code).toBeGreaterThan(0);
      expect(copy.unlock.length, code).toBeGreaterThan(0);
    }
  });
});

describe("[52] resolveCardGateDiagnostic precedence", () => {
  it("returns null for market-closed cards (that state explains itself)", () => {
    expect(
      resolveCardGateDiagnostic({
        marketClosed: true,
        suppressedReason: "insufficient_history",
      }),
    ).toBeNull();
  });

  it("returns null for interactive (tradable) cards", () => {
    expect(
      resolveCardGateDiagnostic({
        interactive: true,
        suppressedReason: "insufficient_history",
      }),
    ).toBeNull();
  });

  it("prefers the engine's suppressed_reason over the regime reason", () => {
    const d = resolveCardGateDiagnostic({
      suppressedReason: "flow_against_direction",
      regimeReason: "regime_scored_only",
    });
    expect(d?.code).toBe("flow_against_direction");
  });

  it("falls back to the regime display reason when there is no engine reason", () => {
    expect(
      resolveCardGateDiagnostic({ regimeReason: "regime_scored_only" })?.code,
    ).toBe("regime_scored_only");
    expect(
      resolveCardGateDiagnostic({
        regimeReason: "regime_pending_high_precision",
      })?.code,
    ).toBe("below_high_precision_bar");
    expect(
      resolveCardGateDiagnostic({
        regimeReason: "regime_pending_confirmation",
      })?.code,
    ).toBe("awaiting_payload");
  });

  it("falls back to operator-filter diagnostics only when no engine reason exists", () => {
    expect(
      resolveCardGateDiagnostic({ demotedByFilter: true })?.code,
    ).toBe("filter_confidence_bar");
    expect(resolveCardGateDiagnostic({ demotedByTier: true })?.code).toBe(
      "filter_tier_floor",
    );
    // Engine reason wins over a filter demotion.
    expect(
      resolveCardGateDiagnostic({
        suppressedReason: "mtf_misaligned",
        demotedByFilter: true,
      })?.code,
    ).toBe("mtf_misaligned");
  });

  it("returns null when there is nothing to diagnose", () => {
    expect(resolveCardGateDiagnostic({})).toBeNull();
  });
});
