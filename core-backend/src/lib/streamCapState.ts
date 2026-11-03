/**
 * streamCapState.ts — BRIDGE LIVE-STREAM BUDGET TRUTH (PART 43.6 [474])
 *
 * The Python bridge reports two distinct capacity states on every heartbeat:
 *
 *   skipped_symbols  {symbol: "live_stream_cap"} — no slot AND no reader could
 *                    be recycled (transient; a later dynamic request retries).
 *   buffered_symbols [symbol, …]                 — parked/evicted because the
 *                    budget is full (LRU). Still configured and re-armable.
 *
 * Neither is a dead token and neither is a network outage. The market-quotes
 * snapshot reads this set and stamps `streamCapped` so the terminal can say
 * STREAM CAP / BUFFERED instead of "PO OFFLINE · market proxy".
 *
 * Process-local and dependency-free: the bridge heartbeat is the only writer,
 * the quotes snapshot the only reader.
 */

let cappedSymbols = new Set<string>();

/** Replace the capped set from the latest bridge heartbeat. */
export function setBridgeStreamCappedSymbols(symbols: Iterable<string>): void {
  cappedSymbols = new Set(symbols);
}

/** True when the bridge currently has no live stream slot for `symbol`. */
export function isBridgeStreamCapped(symbol: string): boolean {
  return cappedSymbols.has(symbol);
}

/** Sorted snapshot for diagnostics/tests. */
export function getBridgeStreamCappedSymbols(): string[] {
  return [...cappedSymbols].sort();
}
