/**
 * verdict-state.test.ts — the withheld-vs-error contract.
 *
 * This is the regression net for the "T1 PREMIUM + SIGNAL: WAITING" illusion.
 * Two properties are load-bearing and must never regress:
 *
 *  1. A transport ERROR never renders as a withheld-but-healthy verdict, and
 *     never presents a confidence/tier as current.
 *  2. A WITHHELD verdict is NOT an error — the confluence number on it is real
 *     and must remain available for audit.
 *
 * The classification is pure, so it is tested directly with no DOM, no store
 * and no timers — which also keeps it trivially Invariant-1 safe.
 */
import { describe, it, expect } from "vitest";
import {
  classifyVerdictState,
  classifyWithheld,
  classifyErrorKind,
  withheldHeadline,
  errorHeadline,
} from "../verdict-state";

describe("classifyWithheld", () => {
  it("maps the engine's real suppressed_reason values", () => {
    expect(classifyWithheld("no_directional_signal")).toBe("NO_DIRECTIONAL_SIGNAL");
    expect(classifyWithheld("CONFLUENCE_BELOW_THERMAL")).toBe("INSUFFICIENT_CONFLUENCE");
    expect(classifyWithheld("regime_scored_only")).toBe("REGIME_BLOCKED");
    expect(classifyWithheld("no_bid_ask_quotes")).toBe("NO_LIQUIDITY");
  });

  it("never upgrades an unrecognised or missing reason", () => {
    expect(classifyWithheld("something_new")).toBe("UNKNOWN");
    expect(classifyWithheld(null)).toBe("UNKNOWN");
    expect(classifyWithheld(undefined)).toBe("UNKNOWN");
    expect(classifyWithheld("")).toBe("UNKNOWN");
  });
});

describe("classifyErrorKind", () => {
  it("separates timeout, server and transport failures", () => {
    expect(classifyErrorKind("Request timeout")).toBe("TIMEOUT");
    expect(classifyErrorKind("500 Internal Server Error")).toBe("SERVER");
    expect(classifyErrorKind("502 Bad Gateway")).toBe("SERVER");
    // A 504 names both a gateway AND a timeout; TIMEOUT is the more specific
    // and more actionable classification, so it wins.
    expect(classifyErrorKind("504 Gateway Timeout")).toBe("TIMEOUT");
    expect(classifyErrorKind("Failed to fetch")).toBe("NETWORK");
  });

  it("degrades unknown text to UNKNOWN rather than guessing", () => {
    expect(classifyErrorKind("something odd")).toBe("UNKNOWN");
    expect(classifyErrorKind(null)).toBe("UNKNOWN");
  });
});

describe("classifyVerdictState", () => {
  it("returns ACTIONABLE only when a gate explicitly released the call", () => {
    expect(
      classifyVerdictState({ signal: "BUY", executable: true }, null, false),
    ).toEqual({ kind: "ACTIONABLE", signal: "BUY" });
    expect(
      classifyVerdictState({ signal: "SELL", executable: true }, null, false),
    ).toEqual({ kind: "ACTIONABLE", signal: "SELL" });
  });

  it("fails CLOSED: a BUY without executable=true is never actionable", () => {
    // The exact shape that produced "T1 PREMIUM beside SIGNAL: WAITING".
    const s = classifyVerdictState(
      { signal: "BUY", executable: false, suppressed_reason: "no_directional_signal" },
      null,
      false,
    );
    expect(s.kind).toBe("WITHHELD");
  });

  it("treats a withheld verdict as WITHHELD, not ERROR, and keeps it auditable", () => {
    const s = classifyVerdictState(
      {
        signal: null,
        executable: false,
        market_waiting: true,
        waiting_reason: "CONFLUENCE_BELOW_THERMAL",
        suppressed_reason: "regime_scored_only",
      },
      null,
      false,
    );
    expect(s.kind).toBe("WITHHELD");
    // The real reason survives for the audit trail.
    if (s.kind === "WITHHELD") expect(s.reason).toBe("REGIME_BLOCKED");
  });

  it("lets a transport ERROR outrank a stale verdict", () => {
    const s = classifyVerdictState(
      { signal: "BUY", executable: true },
      "503 Service Unavailable",
      false,
    );
    expect(s.kind).toBe("ERROR");
    if (s.kind === "ERROR") expect(s.errorKind).toBe("SERVER");
  });

  it("does not treat a blank/whitespace transport message as an error", () => {
    const s = classifyVerdictState({ signal: null, executable: false }, "   ", false);
    expect(s.kind).not.toBe("ERROR");
  });

  it("reports PENDING when there is no verdict at all", () => {
    expect(classifyVerdictState(null, null, true).kind).toBe("PENDING");
    expect(classifyVerdictState(null, null, false).kind).toBe("PENDING");
  });

  it("never returns ACTIONABLE for a verdict that says nothing actionable", () => {
    const s = classifyVerdictState({ signal: null, market_waiting: false }, null, false);
    expect(s.kind).toBe("WITHHELD");
  });
});

describe("headlines", () => {
  it("labels every withheld state as a RISK GATE decision", () => {
    for (const r of [
      "NO_DIRECTIONAL_SIGNAL",
      "INSUFFICIENT_CONFLUENCE",
      "INCOMPLETE_PILLARS",
      "NO_LIQUIDITY",
      "REGIME_BLOCKED",
      "LOW_CONFIDENCE",
      "QUALITY_BELOW_GATE",
      "TOO_LATE",
      "UNKNOWN",
    ] as const) {
      expect(withheldHeadline(r)).toContain("RISK GATE WITHHELD");
    }
  });

  it("labels errors as engine/connection failures, never as a gate decision", () => {
    for (const k of ["TIMEOUT", "SERVER", "NETWORK", "UNKNOWN"] as const) {
      expect(errorHeadline(k)).not.toContain("RISK GATE");
    }
  });
});
