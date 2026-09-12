/**
 * PURE feed-resilience helpers for the live-market-ingestion pipeline.
 *
 * Every function here is deterministic, side-effect-free, and unit-tested —
 * no axios, no services, no timers — so the retry/logging/signal-gating
 * policy is verifiable in isolation and consistent everywhere it is used.
 *
 * Byte-symmetric with the ingestion contract:
 *   • exponential backoff  1s → 2s → 5s → 10s → 30s → 60s (cap, ±20% jitter)
 *   • per-symbol log rate limiting (warn on first, error every 10th, info on
 *     recovery)
 *   • DEGRADED ⇒ NO SIGNAL gate (fewer than 2 real prices ⇒ never emit).
 */

/** Strict backoff ladder in ms — cap at 60s (mission [2]). */
export const FEED_BACKOFF_LADDER_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** ±20% jitter multiplier range applied to a computed backoff delay. */
export const FEED_BACKOFF_JITTER_RATIO = 0.2;

/**
 * Exponential backoff for a given consecutive-failure attempt, clamped to the
 * FEED_BACKOFF_LADDER_MS cap, with deterministic ±20% jitter (a fixed seed is
 * NEVER used — jitter is pure for a given attempt so tests stay byte-exact).
 *
 *   attempt 1  → 1_000   (min ±20%)
 *   attempt 2  → 2_000
 *   attempt 3  → 5_000
 *   attempt 4  → 10_000
 *   attempt 5  → 30_000
 *   attempt 6+ → 60_000  (cap)
 */
export function exponentialBackoffMs(attempt: number, nowMs: number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const idx = Math.min(safeAttempt - 1, FEED_BACKOFF_LADDER_MS.length - 1);
  const base = FEED_BACKOFF_LADDER_MS[idx];
  const jitter = ((nowMs * 13 + safeAttempt * 7) % 100) / 100 * FEED_BACKOFF_JITTER_RATIO * base;
  // ±20%: expand base by [-0.2, +0.2] of base.
  const offset = jitter - base * FEED_BACKOFF_JITTER_RATIO;
  const ms = Math.round(base + offset);
  return Math.max(1, Math.min(ms, FEED_BACKOFF_LADDER_MS[FEED_BACKOFF_LADDER_MS.length - 1]));
}

/**
 * Per-symbol log rate limiter (mission [3]).
 *
 * Policy:
 *   • failure #1        → warn (first failure of an incident)
 *   • failure % 10 === 0 → error (every 10th, never every retry)
 *   • all others        → silent (no log spam from the 2s/5s/… chain)
 *   • recovery          → info (first successful probe after a failure)
 */
export interface FeedLogLevel {
  level: "warn" | "error" | "silent" | "info";
  failureCount: number;
  isFirst: boolean;
  isEveryTenth: boolean;
  isRecovery: boolean;
}

export function classifyFeedLog(
  failureCount: number,
  wasInDegraded: boolean,
): FeedLogLevel {
  const safeCount = Number.isFinite(failureCount) && failureCount >= 0 ? Math.floor(failureCount) : 0;
  if (safeCount === 1) return { level: "warn", failureCount: safeCount, isFirst: true, isEveryTenth: false, isRecovery: false };
  if (safeCount > 0 && safeCount % 10 === 0) return { level: "error", failureCount: safeCount, isFirst: false, isEveryTenth: true, isRecovery: false };
  if (safeCount > 0) return { level: "silent", failureCount: safeCount, isFirst: false, isEveryTenth: false, isRecovery: false };
  // Zero failures = a success path.
  return { level: wasInDegraded ? "info" : "silent", failureCount: 0, isFirst: false, isEveryTenth: false, isRecovery: wasInDegraded };
}

/**
 * DEGRADED ⇒ NO SIGNAL gate (mission [5]).
 * A feed without at least N REAL distinct prices must never emit a signal —
 * "no data = no signal". Mirrors the live-quant thermal gate: nothing can exit
 * a DEGRADED state with a fabricated direction. Pure predicate, unit-tested.
 */
export const MIN_REAL_PRICES_FOR_SIGNAL = 2;

export function shouldEmitSignal(realPriceCount: number, degraded: boolean): boolean {
  if (degraded) return false;
  return Number.isFinite(realPriceCount) && realPriceCount >= MIN_REAL_PRICES_FOR_SIGNAL;
}

/** Fallback-chain descriptor log (mission [4]). */
export interface SourceAttempt {
  source: string;
  ok: boolean;
  reason?: string;
}

export function renderFallbackChainLog(chain: SourceAttempt[]): string {
  if (!Array.isArray(chain) || chain.length === 0) return "fallback chain empty";
  const parts = chain.map((s) => {
    if (!s) return "?";
    return s.ok ? `${s.source}=OK` : `${s.source}=FAIL${s.reason ? `(${s.reason})` : ""}`;
  });
  return parts.join(" → ");
}