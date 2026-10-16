/**
 * serverClock — the SINGLE server↔client wall-clock correction (PRO terminal).
 *
 * The Pro countdown, the candle countdown, and the expiry action-window gate
 * must all agree on "what time is it on the backend's grid?". The browser clock
 * can be seconds off a NTP-synced server, and that skew is exactly the kind of
 * error that turns an exact expiry boundary into an early/late one.
 *
 * The source of truth is the aggregator's own `clockOffsetMs`
 * (`latestUpstreamTimestamp − Date.now()`, captured on every genuine upstream
 * print) — the SAME offset it already uses to roll buckets on the PO grid. This
 * module holds the PURE math used to (a) fold raw samples into a stable
 * estimate and (b) project a server-corrected "now"; the React wiring lives in
 * `useServerClock`.
 *
 * L1-PURE: no clocks are read here — `localNowMs` and `sampleMs` are always
 * passed in, so every branch is a total function of its arguments and testable
 * without fake timers.
 */

/** Largest single step the estimate may take toward a fresh sample (ms). A
 *  genuine reconnect/step is still absorbed, just over a few ticks, so one
 *  outlier timestamp (a reprinted/skewed print) cannot slam the whole clock. */
export const DEFAULT_MAX_CLOCK_STEP_MS = 250;

/** Once a sample lands within this band of the running estimate, adopt it
 *  EXACTLY — this is what lets the estimate converge to a fixed value (and stop
 *  emitting store writes) instead of asymptotically chasing it forever. */
export const DEFAULT_CLOCK_DEADBAND_MS = 5;

export interface ClockOffsetEstimateOptions {
  maxStepMs?: number;
  deadbandMs?: number;
}

/**
 * Fold a raw offset sample into the running estimate.
 *
 *   • non-finite sample → keep the previous estimate (never poison the clock);
 *   • within `deadbandMs` → snap to the sample (convergence / stability);
 *   • otherwise → step by at most `maxStepMs` toward it (outlier dampening).
 */
export function estimateClockOffsetMs(
  previousMs: number,
  sampleMs: number,
  options: ClockOffsetEstimateOptions = {},
): number {
  if (!Number.isFinite(sampleMs)) return previousMs;
  if (!Number.isFinite(previousMs)) return sampleMs;
  const maxStep = options.maxStepMs ?? DEFAULT_MAX_CLOCK_STEP_MS;
  const deadband = options.deadbandMs ?? DEFAULT_CLOCK_DEADBAND_MS;
  const delta = sampleMs - previousMs;
  if (Math.abs(delta) <= deadband) return sampleMs;
  const step = Math.max(-maxStep, Math.min(maxStep, delta));
  return previousMs + step;
}

/**
 * Project a server-corrected wall clock. The offset is additive by construction
 * (`offset = serverAtIngest − localAtIngest`), so `localNow + offset` tracks the
 * backend grid even during a silent tape (local and server clocks advance 1:1).
 */
export function serverNowMs(localNowMs: number, offsetMs: number): number {
  if (!Number.isFinite(localNowMs)) return localNowMs;
  return localNowMs + (Number.isFinite(offsetMs) ? offsetMs : 0);
}
