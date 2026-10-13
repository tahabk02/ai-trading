/**
 * executionEngine.ts — PART 44 [455] UNIFIED EXECUTION RESPONSE CONTRACT.
 *
 * Every endpoint that EVALUATES a signal or EXECUTES a trade (the signal/trade
 * execution bridge: `POST /trades`, `POST /signals/receive`) answers with the
 * SAME envelope so a caller — the terminal, the AI engine's HTTP fallback, or a
 * backtest harness — can branch on one shape instead of guessing per route:
 *
 *   {
 *     status:      "executed" | "rejected" | "dry_run" | "failed",
 *     executionId: "<uuid>",                 // stable id for this decision
 *     provenance:  "pocket_option_ws"        // how the valuation price was sourced
 *                | "proxy_fallback"
 *                | "held_price"
 *                | "none",
 *     latencyMs:   <number>,                 // decision roundtrip, whole ms
 *     error:       <string | null>,          // why, when status != "executed"
 *     timestamp:   "<ISO>",
 *     result?:     { ... }                   // endpoint-specific payload
 *   }
 *
 * The contract is ADDITIVE where it matters: a route that produced a record
 * still returns it, nested under `result`, so nothing is silently dropped — the
 * envelope is just the stable outer frame.
 *
 * `error` is null on success and a human-facing reason on every non-success
 * status. The helpers here are pure (no I/O) so both routes and tests share one
 * definition and can never drift.
 */

import { randomUUID } from "node:crypto";

/** The terminal outcome of one signal evaluation / trade execution decision. */
export type ExecutionStatus = "executed" | "rejected" | "dry_run" | "failed";

/** Canonical provenance tags, open to extra source strings. */
export const EXECUTION_PROVENANCE = {
  PO_WS: "pocket_option_ws",
  PROXY_FALLBACK: "proxy_fallback",
  HELD_PRICE: "held_price",
  NONE: "none",
} as const;

export type ExecutionProvenance =
  | (typeof EXECUTION_PROVENANCE)[keyof typeof EXECUTION_PROVENANCE]
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

export interface ExecutionResponse<T = unknown> {
  status: ExecutionStatus;
  executionId: string;
  provenance: ExecutionProvenance;
  latencyMs: number;
  error: string | null;
  timestamp: string;
  /** Endpoint-specific payload (the persisted trade/signal record, if any). */
  result?: T;
}

/** Fresh, collision-resistant id for one execution decision. */
export function newExecutionId(): string {
  return randomUUID();
}

/**
 * Map a live-price source tag (as reported by `forexDataService` / the tick
 * buffer) onto a provenance tag. Centralised so every route classifies the
 * SAME source string identically:
 *   • a held / carried-over print          → `held_price`
 *   • a Pocket Option WS / PO source print  → `pocket_option_ws`
 *   • anything else that is still a price   → `proxy_fallback`
 *   • no price at all                       → `none`
 */
export function provenanceFromPriceSource(
  source: string | null | undefined,
): ExecutionProvenance {
  const s = String(source ?? "").trim().toLowerCase();
  if (!s || s === "none") return EXECUTION_PROVENANCE.NONE;
  if (s.includes("held")) return EXECUTION_PROVENANCE.HELD_PRICE;
  if (
    s.includes("pocket_option") ||
    s.includes("pocketoption") ||
    s === "live_ws_tick" ||
    s.startsWith("po_")
  ) {
    return EXECUTION_PROVENANCE.PO_WS;
  }
  return EXECUTION_PROVENANCE.PROXY_FALLBACK;
}

/**
 * True when the execution engine must NOT send anything (dry-run).
 *
 * FAIL-CLOSED (PART 46.2 [514]): dry-run is the DEFAULT. The engine only goes
 * live when the operator has explicitly opted out with one of the negations
 * `0|false|no|off`. An UNSET variable, an empty string, or any unrecognised
 * value keeps dry-run ON — so a missing/mistyped env var can never silently
 * enable real execution. No broker is wired yet, so the live path is a
 * deliberate, explicit choice, never an accident.
 */
export function executionDryRunEnabled(): boolean {
  const raw = String(process.env.EXECUTION_DRY_RUN ?? "").trim();
  if (raw === "") return true;
  return !/^(0|false|no|off)$/i.test(raw);
}

/** Build the unified envelope. Pure — the caller owns HTTP status + audit. */
export function buildExecutionResponse<T = unknown>(input: {
  status: ExecutionStatus;
  latencyMs: number;
  executionId?: string;
  provenance?: ExecutionProvenance;
  error?: string | null;
  result?: T;
  timestamp?: string;
}): ExecutionResponse<T> {
  const env: ExecutionResponse<T> = {
    status: input.status,
    executionId: input.executionId ?? newExecutionId(),
    provenance: input.provenance ?? EXECUTION_PROVENANCE.NONE,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    error: input.error ?? null,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  if (input.result !== undefined) env.result = input.result;
  return env;
}
