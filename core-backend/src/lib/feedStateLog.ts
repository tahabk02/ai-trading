/**
 * feedStateLog.ts — PART 44 [497] PERV-SYMBOL FEED STATE LOGGING (PURE)
 *
 * Replaces the per-retry warn/error log cadence with a state machine:
 *
 *   • one LOG LINE per per-symbol state TRANSITION — nothing on the 1s repeats
 *     in between — and
 *   • one compact 60s SUMMARY line listing every tracked symbol's current state.
 *
 * Expected, recoverable states (PO offline / holding last known good / market
 * closed) log INFO — they are operational conditions, not faults. Real failure
 * states (feed_error / lingering) log ERROR so an unexpected outage still
 * rings loudly. Same label ⇒ no line: a 2-hour lingering outage produces the
 * transition line + a summary every 60 seconds, instead of retry spam.
 *
 * Pure class: instances are self-contained; the tick ingestion service owns one
 * and the tests drive it directly.
 */

/** Canonical per-symbol feed states. */
export type FeedStateLabel =
  | "online"
  | "po_offline"
  | "market_closed"
  | "holding_stale"
  | "lingering"
  | "feed_error";

/** Interval between compact per-symbol state summaries (mission: 60s). */
export const FEED_STATE_SUMMARY_INTERVAL_MS = 60_000;

/** A state is EXPECTED when it is a known operational condition that the
 *  platform handles (proxy/held/market-closed) — such states log INFO, never
 *  ERROR. Real unknowns (feed_error, lingering) log ERROR. */
export interface FeedStateCategory {
  label: FeedStateLabel;
  expected: boolean;
}

function category(label: FeedStateLabel, expected: boolean): FeedStateCategory {
  return { label, expected };
}

const STATE_MARKERS: Array<{ re: RegExp; category: FeedStateCategory }> = [
  { re: /market closed|week closed|market re-opened|reopen/i, category: category("market_closed", true) },
  { re: /holding last known good|held_stale|held print/i, category: category("holding_stale", true) },
  { re: /linger/i, category: category("lingering", false) },
  {
    re: /po offline|proxy prices|live sources exhausted|source.*exhausted|awaiting_ssid|session_expired|no_ssid/i,
    category: category("po_offline", true),
  },
];

/**
 * Categorize a feed diagnostic/message into its canonical state.
 *
 * `isOtc` matters: **PO offline / sources exhausted is an EXPECTED state only
 * for an OTC pair** — an OTC instrument is bullish only on the Pocket Option
 * tape, so falling back to proxy/held prices there is a known, handled
 * condition. For a REAL (forex/crypto) pair the market may have genuinely gone
 * away while open, and "sources exhausted" is a real outage that must stay at
 * ERROR level. `market_closed` and `holding_stale` remain expected for both.
 *
 * Defaults to `feed_error` (a REAL, unexpected failure) when nothing matches.
 */
export function categorizeFeedState(
  detail: string,
  isOtc = true,
): FeedStateCategory {
  const text = String(detail || "");
  for (const marker of STATE_MARKERS) {
    if (!marker.re.test(text)) continue;
    const cat = marker.category;
    // OTC-only expectation: a real pair may not claim PO-offline as expected.
    if (cat.label === "po_offline" && !isOtc) {
      return category("feed_error", false);
    }
    return cat;
  }
  return category("feed_error", false);
}

export interface FeedStateChangeOutcome {
  symbol: string;
  transitioned: boolean;
  from: FeedStateLabel | null;
  to: FeedStateLabel;
  expected: boolean;
  logLevel: "info" | "error";
  detail: string;
}

export interface FeedStateSummary {
  /** Current state of every tracked symbol, oldest→newest. */
  per_symbol: Array<{ symbol: string; state: FeedStateLabel; forSec: number }>;
  /** Duration over which this summary applies. */
  intervalMs: number;
}

export interface FeedStateReport {
  /** One line worth of output when the symbol's state CHANGED (else null). */
  outcome: FeedStateChangeOutcome | null;
  /** The 60s summary payload when it is due (else null). */
  summary: FeedStateSummary | null;
}

export class FeedStateReporter {
  private readonly states: Map<string, { label: FeedStateLabel; sinceMs: number }> = new Map();
  private lastSummaryAt = 0;
  private readonly summaryIntervalMs: number;

  constructor(opts?: { summaryIntervalMs?: number }) {
    this.summaryIntervalMs =
      opts?.summaryIntervalMs ?? FEED_STATE_SUMMARY_INTERVAL_MS;
  }

  /** Reset all state — used by tests (and could be used for a clean re-arm). */
  public reset(): void {
    this.states.clear();
    this.lastSummaryAt = 0;
  }

  /** Symbol count currently tracked (for diagnostics). */
  public get size(): number {
    return this.states.size;
  }

  /** Current canonical state for a symbol, or null when never reported. */
  public stateOf(symbol: string): FeedStateLabel | null {
    return this.states.get(String(symbol || "").toUpperCase())?.label ?? null;
  }

  /**
   * Report one symbol's state derived from a diagnostic message, emitting a
   * change-outcome (exactly when the state actually changed) and, once per
   * summary interval, the aggregate 60s summary.
   *
   * `isOtc` scopes the "expected" downgrade: for a REAL pair, PO-offline /
   * sources-exhausted is a genuine outage and stays ERROR (see
   * {@link categorizeFeedState}).
   */
  public inspect(
    symbol: string,
    detail: string,
    nowMs = Date.now(),
    opts?: { isOtc?: boolean },
  ): FeedStateReport {
    const cat = categorizeFeedState(detail, opts?.isOtc ?? true);
    return this.transact(symbol, cat.label, cat.expected, detail, nowMs);
  }

  /**
   * Report a symbol as ONLINE (success path) — always info, never error.
   */
  public markOnline(symbol: string, detail: string, nowMs = Date.now()): FeedStateReport {
    return this.transact(symbol, "online", true, detail, nowMs);
  }

  private transact(
    symbol: string,
    label: FeedStateLabel,
    expected: boolean,
    detail: string,
    nowMs: number,
  ): FeedStateReport {
    const norm = String(symbol || "").trim().toUpperCase();
    const prev = this.states.get(norm);
    const transitioned = !prev || prev.label !== label;
    this.states.set(norm, {
      label,
      sinceMs: prev && prev.label === label ? prev.sinceMs : nowMs,
    });

    const outcome: FeedStateChangeOutcome | null = transitioned
      ? {
          symbol: norm,
          transitioned,
          from: prev?.label ?? null,
          to: label,
          expected,
          logLevel: label === "online" || expected ? "info" : "error",
          detail: String(detail || ""),
        }
      : null;

    let summary: FeedStateSummary | null = null;
    if (this.lastSummaryAt === 0) {
      // Anchor the summary clock on the first report (no summary line yet).
      this.lastSummaryAt = nowMs;
    } else if (nowMs - this.lastSummaryAt >= this.summaryIntervalMs) {
      this.lastSummaryAt = nowMs;
      summary = {
        per_symbol: [...this.states.entries()].map(([sym, s]) => ({
          symbol: sym,
          state: s.label,
          forSec: Math.max(0, Math.round((nowMs - s.sinceMs) / 1000)),
        })),
        intervalMs: this.summaryIntervalMs,
      };
    }

    return { outcome, summary };
  }
}

/** Process-wide default reporter for the ingestion service. */
export const feedStateReporter = new FeedStateReporter();