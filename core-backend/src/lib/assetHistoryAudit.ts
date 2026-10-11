/**
 * assetHistoryAudit.ts — PART 44 [495] DATA PROVENANCE ALL THE WAY DOWN (AUDIT)
 *
 * PURE analysis over persisted AssetHistory rows. No database access, no I/O:
 * the caller (HTTP route / CLI job / test) feeds rows, gets a verdict summary.
 *
 * MISSION:
 *   An OTC instrument is bullish ONLY on the Pocket Option tape. Bars persisted
 *   from a non-PO source (Frankfurter proxy, GitHub data provider, a HELD
 *   re-pended print, ai-engine observation) are NOT PO history; storing them
 *   "as if" real PO history is a data-integrity fault. Before [494], the
 *   collector could persist proxy/history without any provenance stamp, and
 *   there was no way to tell a genuine PO bar from a proxy-shaped one.
 *
 *   This audit therefore separates the persisted OTC universe into three
 *   classes for every symbol:
 *
 *     • po-sourced     — source names a Pocket Option feed  (trusted)
 *     • non-PO sourced — source names any other feed        (INTEGRITY FAULT)
 *     • unstamped      — no source at all (legacy pre-[494] rows; ambiguous —
 *                        must be re-stamped/backfilled, never silently trusted)
 *
 *   Only the non-PO OTC class is actionable by the `--apply` CLI: it is
 *   DEFINITIVELY proxy/hold data wearing an OTC history label. Unstamped OTC
 *   rows are reported loudly but NOT auto-deleted — they may be genuinely old
 *   PO tape and deleting them destroys the only record there is.
 *
 *   Flat bars (open == high == low == close across different symbols' 10m
 *   windows) are additionally tallied as a monotony signal: a bar repeated
 *   verbatim at a static price across a long window is the classic signature
 *   of a stale/hold carrier rather than a live tape.
 */

import { isPocketOptionSource } from "./pocketOptionSource";
import { symbolRegistry } from "../services/symbolRegistry.service";

/** Provenance class of one persisted bar's `source` stamp. */
export type AuditSourceClass = "po" | "nonPo" | "unstamped";

/** One persisted AssetHistory row, normalized for the audit. */
export interface AssetHistoryBarRow {
  symbol: string;
  timeframe: string;
  bucketStartMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  tickCount: number;
  source: string | null;
}

/** A persisted bar flagged as an OTC provenance integrity fault. */
export interface OtcFaultBar {
  symbol: string;
  timeframe: string;
  bucketStartMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  source: string | null;
  /** Why the fault matters (human-readable, one line). */
  reason: string;
}

export interface AssetHistoryPerSymbolReport {
  symbol: string;
  bars: number;
  flatBars: number;
  otcBars: number;
  poSourcedBars: number;
  nonPoSourcedBars: number;
  unstampedBars: number;
  /** OTC bars with a non-PO source — definite integrity faults. */
  otcProxyBars: OtcFaultBar[];
  otcProxyBarCount: number;
  /** OTC bars with no source stamp — legacy ambiguity, needs re-stamping. */
  otcUnstampedBars: OtcFaultBar[];
  otcUnstampedBarCount: number;
  tickCountSum: number;
  tickCountMin: number;
  tickCountMax: number;
  minBucketMs: number | null;
  maxBucketMs: number | null;
}

export interface AssetHistoryAuditSummary {
  generated_at: string;
  symbols: number;
  totalBars: number;
  totalFlatBars: number;
  totalOtcBars: number;
  totalPoSourcedBars: number;
  totalNonPoSourcedBars: number;
  totalUnstampedBars: number;
  /** OTC bars authored by a non-PO feed — the actionable corruption set. */
  otcProxyBarCount: number;
  /** OTC bars with no provenance stamp at all (legacy, needs stamping). */
  otcUnstampedBarCount: number;
  perSymbol: AssetHistoryPerSymbolReport[];
  verdicts: string[];
}

/** True when a bar's OHLC is a single flat value — the stale/hold monotony
 *  signature. Compared with exact equality: a proxy repeatedly printing one
 *  price produces open===high===low===close on the float it re-serves. */
export function isFlatBar(bar: {
  open: number;
  high: number;
  low: number;
  close: number;
}): boolean {
  return (
    bar.open === bar.high &&
    bar.high === bar.low &&
    bar.low === bar.close
  );
}

/** Classify a persisted `source` stamp: PO feed / other feed / absent. */
export function classifySource(source: string | null | undefined): AuditSourceClass {
  if (source == null || String(source).trim() === "") return "unstamped";
  return isPocketOptionSource(String(source).trim()) ? "po" : "nonPo";
}

function toFault(
  row: AssetHistoryBarRow,
  reason: string,
): OtcFaultBar {
  return {
    symbol: row.symbol,
    timeframe: row.timeframe,
    bucketStartMs: row.bucketStartMs,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    source: row.source,
    reason,
  };
}

/**
 * Run the provenance audit over persisted AssetHistory rows.
 *
 * Pure and idempotent: same input ⇒ same summary, no side effects.
 */
export function summarizeAssetHistory(rows: AssetHistoryBarRow[]): AssetHistoryAuditSummary {
  const generated_at = new Date().toISOString();
  const perSymbol = new Map<string, AssetHistoryPerSymbolReport>();

  for (const row of rows) {
    const isOtc = symbolRegistry.getAssetSubType(row.symbol) === "otc";
    const cls = classifySource(row.source);
    let report = perSymbol.get(row.symbol);
    if (!report) {
      report = {
        symbol: row.symbol,
        bars: 0,
        flatBars: 0,
        otcBars: 0,
        poSourcedBars: 0,
        nonPoSourcedBars: 0,
        unstampedBars: 0,
        otcProxyBars: [],
        otcProxyBarCount: 0,
        otcUnstampedBars: [],
        otcUnstampedBarCount: 0,
        tickCountSum: 0,
        tickCountMin: Number.POSITIVE_INFINITY,
        tickCountMax: Number.NEGATIVE_INFINITY,
        minBucketMs: null,
        maxBucketMs: null,
      };
      perSymbol.set(row.symbol, report);
    }
    report.bars += 1;
    if (isFlatBar(row)) report.flatBars += 1;
    if (isOtc) report.otcBars += 1;
    if (cls === "po") report.poSourcedBars += 1;
    else if (cls === "nonPo") report.nonPoSourcedBars += 1;
    else report.unstampedBars += 1;
    report.tickCountSum += Math.max(0, Math.round(Number(row.tickCount) || 0));
    report.tickCountMin = Math.min(report.tickCountMin, Math.round(Number(row.tickCount) || 0));
    report.tickCountMax = Math.max(report.tickCountMax, Math.round(Number(row.tickCount) || 0));
    if (row.bucketStartMs != null && Number.isFinite(Number(row.bucketStartMs))) {
      const b = Number(row.bucketStartMs);
      report.minBucketMs = report.minBucketMs == null ? b : Math.min(report.minBucketMs, b);
      report.maxBucketMs = report.maxBucketMs == null ? b : Math.max(report.maxBucketMs, b);
    }
    if (isOtc && cls === "nonPo") {
      report.otcProxyBars.push(
        toFault(row, `OTC bar authored by a non-PO feed (${row.source ?? "?"}) — not PO history`),
      );
      report.otcProxyBarCount += 1;
    } else if (isOtc && cls === "unstamped") {
      report.otcUnstampedBars.push(
        toFault(row, "OTC bar with no provenance stamp (legacy pre-[494] row) — needs re-stamping"),
      );
      report.otcUnstampedBarCount += 1;
    }
  }

  const symbols = [...perSymbol.values()];
  const totalBars = symbols.reduce((a, s) => a + s.bars, 0);
  const totalFlatBars = symbols.reduce((a, s) => a + s.flatBars, 0);
  const totalOtcBars = symbols.reduce((a, s) => a + s.otcBars, 0);
  const totalPoSourcedBars = symbols.reduce((a, s) => a + s.poSourcedBars, 0);
  const totalNonPoSourcedBars = symbols.reduce((a, s) => a + s.nonPoSourcedBars, 0);
  const totalUnstampedBars = symbols.reduce((a, s) => a + s.unstampedBars, 0);
  const otcProxyBarCount = symbols.reduce((a, s) => a + s.otcProxyBarCount, 0);
  const otcUnstampedBarCount = symbols.reduce((a, s) => a + s.otcUnstampedBarCount, 0);

  const verdicts: string[] = [];
  if (totalBars === 0) {
    verdicts.push("No persisted AssetHistory rows. Nothing to audit.");
  }
  if (otcProxyBarCount > 0) {
    verdicts.push(
      `DATA-INTEGRITY FAULT: ${otcProxyBarCount} OTC bar(s) were authored by a NON-PO feed ` +
        `(proxy / ai_engine / held). They are NOT Pocket Option history and must be ` +
        `quarantined (re-stamped) or deleted with the CLI --apply flag.`,
    );
  } else if (totalOtcBars > 0 && otcUnstampedBarCount === 0) {
    verdicts.push(`All ${totalOtcBars} OTC bar(s) are PO-sourced — genuine Pocket Option history.`);
  }
  if (otcUnstampedBarCount > 0) {
    verdicts.push(
      `${otcUnstampedBarCount} OTC bar(s) carry no provenance stamp (written before the [494] ` +
        `column). Not auto-deleted — re-stamp via a backfill or quarantine them explicitly.`,
    );
  }
  const flatOnly = symbols.filter((s) => s.bars > 0 && s.flatBars === s.bars);
  if (flatOnly.length > 0) {
    verdicts.push(
      `MONOTONY: ${flatOnly.map((s) => `${s.symbol} (${s.bars})`).join(", ")} is/are verbatim ` +
        `flat (O===H===L===C across ${totalFlatBars} bar(s)) — the stale/hold signature.`,
    );
  }

  return {
    generated_at,
    symbols: symbols.length,
    totalBars,
    totalFlatBars,
    totalOtcBars,
    totalPoSourcedBars,
    totalNonPoSourcedBars,
    totalUnstampedBars,
    otcProxyBarCount,
    otcUnstampedBarCount,
    perSymbol: symbols,
    verdicts,
  };
}