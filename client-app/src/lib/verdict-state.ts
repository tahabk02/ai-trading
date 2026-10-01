/**
 * verdict-state.ts — classify a /predict verdict into exactly ONE terminal
 * state for the UI, so "risk gate withheld" and "transport/server error" can
 * never be rendered as the same thing.
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend now returns HTTP 200 with an explicit `suppressed_reason` /
 * `waiting_reason` whenever a risk gate withholds a call. Before the tier
 * coherence clamp, a withheld verdict could still carry a PREMIUM-tier badge
 * (tier resolved from the raw confluence score alone), which rendered as
 * "T1 PREMIUM 99.32%" beside "SIGNAL: WAITING".
 *
 * Two DIFFERENT things were previously indistinguishable in the UI:
 *
 *   1. RISK WITHHELD  — the engine worked, the maths ran, and a gate
 *                       deliberately declined to release a call. The number on
 *                       screen is a real confluence score. This is a NORMAL,
 *                       HEALTHY state and must be presented calmly.
 *   2. TRANSPORT FAILURE — the request never produced a verdict (timeout, 5xx,
 *                       aborted, offline). There is NO authoritative number, so
 *                       any confidence shown would be a stale fabrication.
 *
 * Collapsing these is what produced the "PREMIUM badge + WAITING" illusion, so
 * the distinction is made here ONCE, in a pure function, and unit-tested.
 *
 * This module is PURE and store-free on purpose: it is called during render,
 * so it must never subscribe to the tick store. Reading the verdict prop is
 * Invariant-1 safe (a React prop changes at React's cadence, not per tick).
 */

/** Transport / server-level failure. No authoritative verdict exists. */
export type VerdictErrorKind =
  | "TIMEOUT" // request budget elapsed
  | "SERVER" // 5xx / gateway / upstream crash
  | "NETWORK" // offline, DNS, connection refused
  | "UNKNOWN";

/** Why a gate withheld an otherwise-computed verdict. */
export type WithheldReason =
  | "NO_DIRECTIONAL_SIGNAL" // engine produced no BUY/SELL
  | "INSUFFICIENT_CONFLUENCE" // sub-thermal confluence
  | "INCOMPLETE_PILLARS" // a required confluence pillar was missing
  | "NO_LIQUIDITY" // real_liquidity_gate: no book / proxy refused
  | "REGIME_BLOCKED" // random-walk regime, scored-only
  | "LOW_CONFIDENCE" // below the dispatched minimum tier
  | "QUALITY_BELOW_GATE" // five-factor watershed
  | "TOO_LATE" // expiry window closed
  | "UNKNOWN";

export type VerdictState =
  /** A BUY/SELL the gates released. Safe to render as actionable. */
  | { kind: "ACTIONABLE"; signal: "BUY" | "SELL" }
  /** Engine answered; a gate withheld the call. Real number, no call. */
  | { kind: "WITHHELD"; reason: WithheldReason; detail: string | null }
  /** No verdict could be obtained at all. */
  | { kind: "ERROR"; errorKind: VerdictErrorKind; detail: string | null }
  /** Verdict is genuinely still being computed (cold start). */
  | { kind: "PENDING" };

const WITHHELD_MAP: Record<string, WithheldReason> = {
  no_directional_signal: "NO_DIRECTIONAL_SIGNAL",
  confluence_below_thermal: "INSUFFICIENT_CONFLUENCE",
  insufficient_confluence: "INSUFFICIENT_CONFLUENCE",
  incomplete_pillars: "INCOMPLETE_PILLARS",
  no_bid_ask_quotes: "NO_LIQUIDITY",
  no_liquidity: "NO_LIQUIDITY",
  regime_scored_only: "REGIME_BLOCKED",
  regime_random_walk: "REGIME_BLOCKED",
  low_confidence: "LOW_CONFIDENCE",
  quality_below_gate: "QUALITY_BELOW_GATE",
  too_late: "TOO_LATE",
};

/** Map a backend reason string onto the closed set. Unknown stays UNKNOWN —
 *  never silently upgraded to "actionable" or to a prettier reason. */
export function classifyWithheld(reason: string | null | undefined): WithheldReason {
  if (!reason) return "UNKNOWN";
  return WITHHELD_MAP[reason.trim().toLowerCase()] ?? "UNKNOWN";
}

export function classifyErrorKind(message: string | null | undefined): VerdictErrorKind {
  const m = (message ?? "").toLowerCase();
  if (!m) return "UNKNOWN";
  if (m.includes("timeout") || m.includes("aborted") || m.includes("budget")) return "TIMEOUT";
  if (/\b5\d\d\b/.test(m) || m.includes("gateway") || m.includes("internal server")) return "SERVER";
  if (m.includes("network") || m.includes("offline") || m.includes("failed to fetch") || m.includes("econnrefused")) {
    return "NETWORK";
  }
  return "UNKNOWN";
}

interface VerdictLike {
  signal?: string | null;
  executable?: boolean;
  market_waiting?: boolean;
  waiting_reason?: string | null;
  suppressed_reason?: string | null;
}

/**
 * Single source of truth for the banner.
 *
 * Precedence is deliberate: a transport ERROR outranks any verdict, because a
 * stale verdict left on screen after a failed request is precisely the thing
 * that makes a broken backend look like a confident market. Only when the
 * transport is healthy do we classify the verdict itself.
 */
export function classifyVerdictState(
  verdict: VerdictLike | null | undefined,
  transportError: string | null | undefined,
  isLoading: boolean,
): VerdictState {
  if (transportError && transportError.trim()) {
    return { kind: "ERROR", errorKind: classifyErrorKind(transportError), detail: transportError };
  }
  if (!verdict) {
    return isLoading ? { kind: "PENDING" } : { kind: "PENDING" };
  }

  const signal = typeof verdict.signal === "string" ? verdict.signal.toUpperCase() : "";

  // The gate released a directional call: executable is the authority. A
  // missing `executable` field is treated as NOT released — fail closed, so a
  // future backend omission can never flash an actionable-looking state.
  if (signal === "BUY" || signal === "SELL") {
    if (verdict.executable === true) return { kind: "ACTIONABLE", signal };
    return {
      kind: "WITHHELD",
      reason: classifyWithheld(verdict.suppressed_reason ?? verdict.waiting_reason),
      detail: verdict.waiting_reason ?? verdict.suppressed_reason ?? null,
    };
  }

  // No directional signal released. The engine still answered, so this is a
  // WITHHELD verdict with a real (if unactionable) confluence number — not an
  // error, and not "PENDING".
  const reason = classifyWithheld(verdict.suppressed_reason ?? verdict.waiting_reason);
  if (verdict.market_waiting === true || verdict.executable === false) {
    return { kind: "WITHHELD", reason, detail: verdict.waiting_reason ?? verdict.suppressed_reason ?? null };
  }

  // A verdict object exists but says nothing actionable and is not explicitly
  // marked waiting. Treat as withheld rather than actionable (fail closed).
  return { kind: "WITHHELD", reason, detail: null };
}

/** Human-facing copy for a withheld verdict. Kept out of the state machine so
 *  the classification stays pure and trivially testable. */
export function withheldHeadline(reason: WithheldReason): string {
  switch (reason) {
    case "NO_DIRECTIONAL_SIGNAL":
      return "RISK GATE WITHHELD — no directional confluence";
    case "INSUFFICIENT_CONFLUENCE":
      return "RISK GATE WITHHELD — confluence below thermal bar";
    case "INCOMPLETE_PILLARS":
      return "RISK GATE WITHHELD — incomplete confluence pillars";
    case "NO_LIQUIDITY":
      return "RISK GATE WITHHELD — no executable liquidity";
    case "REGIME_BLOCKED":
      return "RISK GATE WITHHELD — regime scored-only";
    case "LOW_CONFIDENCE":
      return "RISK GATE WITHHELD — below minimum tier";
    case "QUALITY_BELOW_GATE":
      return "RISK GATE WITHHELD — quality watershed";
    case "TOO_LATE":
      return "RISK GATE WITHHELD — expiry window closed";
    default:
      return "RISK GATE WITHHELD";
  }
}

export function errorHeadline(kind: VerdictErrorKind): string {
  switch (kind) {
    case "TIMEOUT":
      return "ENGINE TIMEOUT — no verdict for this cycle";
    case "SERVER":
      return "ENGINE ERROR — verdict unavailable";
    case "NETWORK":
      return "CONNECTION LOST — verdict unavailable";
    default:
      return "ENGINE ERROR — verdict unavailable";
  }
}
