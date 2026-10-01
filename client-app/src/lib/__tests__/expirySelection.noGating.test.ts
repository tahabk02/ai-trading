/**
 * expirySelection.noGating.test.ts — ARCHITECTURAL REGRESSION GUARD.
 *
 * The defect: the expiry/horizon selector fed its action-readiness state
 * straight into the DOM `disabled` attribute. A verdict below the tier bar (or
 * a `regime_scored_only` symbol, or a too_late bucket landing) therefore
 * disabled EVERY option at once, so the operator could never switch to a
 * horizon that might clear the gate. Selection and enforcement had been fused.
 *
 * The contract these tests lock in:
 *
 *   1. SELECTION IS AN INPUT — never a function of market state. Every option
 *      is always present, always identified, always selectable.
 *   2. ACTION-READINESS IS OUTPUT — reported as status, never enforced.
 *   3. ENFORCEMENT LIVES AT THE ACTION BOUNDARY (`executeTrade`) and in the
 *      engine's SignalLock, not in navigation.
 *
 * Because the components are not DOM-renderable in this suite (vitest runs in
 * `node` env and @testing-library/react is not a dependency), the DOM attribute
 * is asserted at the source level. That is deliberate: the bug WAS an attribute,
 * so the attribute is the thing that must never come back.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expirySelectorState,
  type ExpiryOptionState,
} from "@/lib/expirySelection";

const PRO_EXPIRY_OPTIONS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "3m", seconds: 180 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
];

/** Every adverse regime/tier state the engine can report. */
const ADVERSE_STATES: ReadonlyArray<{
  name: string;
  tier: string | null;
  reason: string | null;
}> = [
  { name: "T5 WEAK", tier: "T5", reason: null },
  { name: "T4 below Pro floor", tier: "T4", reason: null },
  { name: "random_walk scored_only", tier: "T1", reason: "regime_scored_only" },
  { name: "pending_high_precision", tier: "T1", reason: "pending_high_precision" },
  { name: "no verdict yet", tier: null, reason: null },
];

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

/**
 * Strip comments before asserting on source text. The word "disabled" appears
 * in explanatory comments that explicitly say the attribute is forbidden; only
 * real code must be inspected.
 */
const readCode = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Market-state identifiers that must NEVER appear in a `disabled` expression. */
const MARKET_STATE_TOKENS = [
  "suppressed",
  "actionReady",
  "regimeBlocked",
  "tooLate",
  "zoneActive",
  "anyActionable",
  "blockedReason",
  "expirySel",
  "selector",
];

describe("CONTRACT 1 — selection is never a function of market state", () => {
  it("every option is returned, fully identified, in every adverse state", () => {
    for (const st of ADVERSE_STATES) {
      const sel = expirySelectorState(
        st.tier,
        st.reason,
        60,
        30_000,
        PRO_EXPIRY_OPTIONS,
      );
      // The option SET is invariant: gating must never remove a choice.
      expect(sel.options).toHaveLength(PRO_EXPIRY_OPTIONS.length);
      for (let i = 0; i < PRO_EXPIRY_OPTIONS.length; i += 1) {
        const opt = sel.options[i];
        const src = PRO_EXPIRY_OPTIONS[i];
        expect(opt.seconds).toBe(src.seconds);
        expect(opt.label).toBe(src.label);
        // Identity is intact so a click can always be resolved to a horizon.
        expect(Number.isFinite(opt.seconds)).toBe(true);
        expect(opt.alignedSeconds).toBeGreaterThan(0);
      }
    }
  });

  it("the option set survives a full bucket sweep in the worst state", () => {
    // The original deadlock was worst at the bucket edge (too_late). Walk the
    // whole 60s bucket: the count must never change.
    for (const st of ADVERSE_STATES) {
      for (let now = 0; now < 60_000; now += 250) {
        const sel = expirySelectorState(
          st.tier,
          st.reason,
          60,
          now,
          PRO_EXPIRY_OPTIONS,
        );
        expect(sel.options).toHaveLength(5);
      }
    }
  });
});

describe("CONTRACT 2 — action-readiness is output only, never a lock", () => {
  it("the option state exposes NO field that could be wired to `disabled`", () => {
    // This is the load-bearing assertion. `suppressed` is what the old code fed
    // into `disabled`; if it (or any equivalent) reappears on the type, the
    // deadlock can silently return.
    const sel = expirySelectorState("T5", null, 60, 30_000, PRO_EXPIRY_OPTIONS);
    const opt = sel.options[0] as unknown as Record<string, unknown>;

    for (const forbidden of [
      "suppressed",
      "disabled",
      "optionEnabled",
      "blocked",
      "locked",
    ]) {
      expect(opt).not.toHaveProperty(forbidden);
    }
    // The reported, non-enforcing fields ARE present.
    for (const reported of [
      "actionReady",
      "regimeBlocked",
      "tooLate",
      "reason",
      "retryInMs",
    ]) {
      expect(opt).toHaveProperty(reported);
    }
  });

  it("a blocked state reports a real, non-fake retry wait", () => {
    // regime gate closed → 0 (no horizon would help; a countdown would lie).
    const blocked = expirySelectorState(
      "T1",
      "regime_scored_only",
      60,
      30_000,
      PRO_EXPIRY_OPTIONS,
    );
    for (const opt of blocked.options) {
      expect(opt.regimeBlocked).toBe(true);
      expect(opt.actionReady).toBe(false);
      expect(opt.retryInMs).toBe(0);
    }

    // timing gate only → a REAL wait, so the UI can say "next bucket in Ns".
    const late = expirySelectorState("T3", null, 60, 59_000, PRO_EXPIRY_OPTIONS);
    const oneMinute = late.options.find((o) => o.seconds === 60);
    expect(oneMinute?.tooLate).toBe(true);
    expect(oneMinute?.regimeBlocked).toBe(false);
    expect(oneMinute?.retryInMs).toBeGreaterThan(0);
  });

  it("the regime reason outranks the transient timing reason", () => {
    // Both gates closed at once: the stable, actionable-to-explain reason wins.
    const both = expirySelectorState(
      "T1",
      "regime_scored_only",
      60,
      59_000,
      PRO_EXPIRY_OPTIONS,
    );
    for (const opt of both.options) {
      expect(opt.reason).toBe("regime_scored_only");
    }
  });
});

describe("CONTRACT 3 — the DOM lock is gone from both expiry surfaces", () => {
  it("ProExpiryBar has no `disabled` attribute at all", () => {
    expect(readCode("src/components/pro/pro-expiry-bar.tsx")).not.toMatch(
      /disabled/,
    );
    // The nav is still a proper toggle group.
    expect(read("src/components/pro/pro-expiry-bar.tsx")).toContain('role="group"');
    expect(read("src/components/pro/pro-expiry-bar.tsx")).toContain("aria-pressed={active}");
  });

  it("ProExpiryBar's active flag depends only on the two store fields", () => {
    const src = read("src/components/pro/pro-expiry-bar.tsx");
    // `active` must be the two-field agreement, with no readiness term mixed in.
    expect(src).toMatch(
      /const active\s*=\s*\r?\n?\s*expirationSeconds === opt\.seconds &&\s*\r?\n?\s*selectedHorizonMinutes === horizonMinutes;/,
    );
  });

  it("Quick Trade locks ONLY on an in-flight trade, never on market state", () => {
    const code = readCode("src/components/trading/trading-panel.tsx");
    const disabledAttrs = code.match(/disabled=\{[^}]*\}/g) ?? [];
    // Three locks are legitimate and must all survive:
    //   * the expiry grid  → transaction lock only (a dispatch is in flight)
    //   * CALL / PUT      → execution guards (signal lock, live tape, kill switch)
    // What must never appear is MARKET STATE inside any of them.
    expect(disabledAttrs).toHaveLength(3);
    expect(disabledAttrs[0]).toBe("disabled={isTradeActive}");
    for (const attr of disabledAttrs) {
      for (const token of MARKET_STATE_TOKENS) {
        expect(attr).not.toContain(token);
      }
    }
    // The execution guards are explicitly retained at the action boundary.
    expect(disabledAttrs[1]).toContain("signalLocked");
    expect(disabledAttrs[1]).toContain("!streamLive");
  });

  it("neither surface renders the preemptive 'no actionable signal at any expiry' banner", () => {
    // The banner was driven by `!anyActionable && !zoneActive`, i.e. it fired
    // BEFORE the operator chose anything — and fired even while merely
    // evaluating (no_tier). Status is now reported per selected horizon.
    for (const rel of [
      "src/components/pro/pro-expiry-bar.tsx",
      "src/components/trading/trading-panel.tsx",
    ]) {
      expect(read(rel)).not.toMatch(/anyActionable\s*&&\s*!?selector\.zoneActive/);
      expect(read(rel)).not.toMatch(/NO ACTIONABLE SIGNAL AT ANY EXPIRY/);
    }
  });

  it("status is scoped to the SELECTED horizon", () => {
    const proBar = read("src/components/pro/pro-expiry-bar.tsx");
    // Resolved from the selected seconds, not from a global fold.
    expect(proBar).toContain("bySeconds.get(expirationSeconds as number)");
    expect(proBar).toContain("data-testid=\"pro-expiry-status\"");
  });
});

describe("CONTRACT — the escape hatch actually exists", () => {
  it("from a fully blocked state a different horizon is still selectable", () => {
    // The concrete user story: T5/scored_only, 1m is too_late. The operator must
    // still be able to pick 10m (and vice versa) without the UI blocking them.
    const sel = expirySelectorState(
      "T1",
      "regime_scored_only",
      60,
      59_000,
      PRO_EXPIRY_OPTIONS,
    );
    const tenMin = sel.options.find((o) => o.seconds === 600);
    // It reports honestly that it is not action-ready…
    expect(tenMin?.actionReady).toBe(false);
    // …while remaining a fully-formed, clickable choice.
    expect(tenMin?.label).toBe("10m");
    expect(tenMin?.seconds).toBe(600);
    expect(tenMin?.alignedSeconds).toBeGreaterThan(0);
  });
});
