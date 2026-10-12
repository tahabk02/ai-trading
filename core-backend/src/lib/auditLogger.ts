/**
 * auditLogger.ts — PART 44 [456] SIGNAL & TRADE EXECUTION AUDIT LOG.
 *
 * Records EVERY incoming prediction signal and its resulting execution
 * decision, so the operator can verify after the fact — and compare against a
 * backtest — why a signal was taken or skipped. Each entry captures:
 *
 *   • timestamp    — when the decision was made
 *   • symbol, timeframe, direction, confidence — the signal snapshot
 *   • decision     — "executed" | "skipped" | "rejected"
 *   • status       — the [455] execution status (executed/rejected/dry_run/failed)
 *   • provenance   — how the valuation price was sourced
 *   • riskRules    — the ACTIVE risk rules at decision time (the "why")
 *   • executionId, latencyMs, error, source ("trade" | "signal")
 *
 * STORE: an in-process, bounded ring buffer (newest-first). This mirrors the
 * existing `tradesStore` pattern and is deliberately dependency-free so it can
 * never add latency or an outage to the execution path. The tiny surface below
 * (`recordExecutionAudit` / `queryExecutionLogs`) is the seam to swap in a
 * durable table (e.g. a Prisma `ExecutionLog` model) later WITHOUT touching the
 * callers — backtests that need cross-restart history can repoint that seam.
 *
 * Recording NEVER throws: an audit failure must not fail a real execution.
 */

import { randomUUID } from "node:crypto";
import type {
  ExecutionProvenance,
  ExecutionStatus,
} from "./executionEngine";

export type ExecutionDecision = "executed" | "skipped" | "rejected";

/** The active risk rules / gates snapshot at decision time. */
export interface RiskRuleSnapshot {
  /** OTC whitelist gate — was the symbol permitted? */
  whitelistPassed?: boolean;
  /** Automated kill switch — locked at decision time? */
  killSwitchLocked?: boolean;
  drawdownPct?: number;
  maxDailyDrawdownPct?: number;
  tradesToday?: number;
  lossesToday?: number;
  /** Free-form additional rule state (never a secret). */
  [rule: string]: unknown;
}

export interface ExecutionAuditEntry {
  id: string;
  timestamp: string;
  source: "trade" | "signal";
  symbol: string;
  timeframe: string | null;
  direction: string | null;
  confidence: number | null;
  decision: ExecutionDecision;
  status: ExecutionStatus;
  provenance: ExecutionProvenance;
  executionId: string | null;
  latencyMs: number | null;
  error: string | null;
  riskRules: RiskRuleSnapshot;
}

export interface RecordExecutionAuditInput {
  source: "trade" | "signal";
  symbol: string;
  decision: ExecutionDecision;
  status: ExecutionStatus;
  timeframe?: string | null;
  direction?: string | null;
  confidence?: number | null;
  provenance?: ExecutionProvenance;
  executionId?: string | null;
  latencyMs?: number | null;
  error?: string | null;
  riskRules?: RiskRuleSnapshot;
  id?: string;
  timestamp?: string;
}

export interface ExecutionAuditQuery {
  symbol?: string;
  decision?: ExecutionDecision;
  /** ISO-8601 lower bound (inclusive) on entry timestamp. */
  since?: string;
  limit?: number;
}

export interface ExecutionAuditResult {
  logs: ExecutionAuditEntry[];
  /** Number of entries matching the filter. */
  count: number;
  /** Total entries retained in the store (unfiltered). */
  total: number;
}

const MAX_ENTRIES = Math.max(
  1,
  Math.floor(Number(process.env.AUDIT_LOG_MAX) || 5_000),
);
const MAX_QUERY_LIMIT = 500;

/** Newest-first ring buffer. */
const entries: ExecutionAuditEntry[] = [];

export function recordExecutionAudit(
  input: RecordExecutionAuditInput,
): ExecutionAuditEntry {
  const entry: ExecutionAuditEntry = {
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    source: input.source,
    symbol: String(input.symbol ?? "").trim().toUpperCase(),
    timeframe: input.timeframe ?? null,
    direction: input.direction ?? null,
    confidence:
      input.confidence === undefined || input.confidence === null
        ? null
        : Number(input.confidence),
    decision: input.decision,
    status: input.status,
    provenance: input.provenance ?? "none",
    executionId: input.executionId ?? null,
    latencyMs:
      input.latencyMs === undefined || input.latencyMs === null
        ? null
        : Math.max(0, Math.round(input.latencyMs)),
    error: input.error ?? null,
    riskRules: input.riskRules ?? {},
  };

  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  return entry;
}

export function queryExecutionLogs(
  query: ExecutionAuditQuery = {},
): ExecutionAuditResult {
  const limit = Math.min(
    Math.max(Math.floor(Number(query.limit) || 50), 1),
    MAX_QUERY_LIMIT,
  );
  const symbol = query.symbol
    ? String(query.symbol).trim().toUpperCase()
    : null;
  const sinceMs = query.since ? Date.parse(query.since) : Number.NaN;

  const filtered = entries.filter((e) => {
    if (symbol && e.symbol !== symbol) return false;
    if (query.decision && e.decision !== query.decision) return false;
    if (Number.isFinite(sinceMs) && Date.parse(e.timestamp) < sinceMs) {
      return false;
    }
    return true;
  });

  return {
    logs: filtered.slice(0, limit),
    count: filtered.length,
    total: entries.length,
  };
}

/** Test seam: drop all retained entries. */
export function clearExecutionAuditForTests(): void {
  entries.length = 0;
}
