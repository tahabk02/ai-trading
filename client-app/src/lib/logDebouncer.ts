/**
 * logDebouncer.ts — rate-gated 503 warning.
 *
 * The market terminal can emit a burst of HTTP 503s while the AI Engine /
 * feed recovers (34 cards re-polling with backoff). Unbounded logging would
 * flood the devtools console with identical error lines. This debouncer
 * collapses the burst:
 *
 *   • first 503        → console.warn
 *   • next 503 within 10s → silent (swallowed)
 *   • first 503 after 10s → console.warn again
 *
 * Per the mission contract the FIRST failure is surfaced, the burst is held
 * quiet, and a genuine NEW incident (after the window has elapsed) is
 * surfaced again. `reset503Debounce()` exists for deterministic unit tests.
 */

const DEBOUNCE_MS = 10_000;
let lastWarnAt = 0;

/** True when THIS 503 should be printed (first in the 10s window). */
export function shouldLog503(now: number): boolean {
  if (now - lastWarnAt >= DEBOUNCE_MS) {
    lastWarnAt = now;
    return true;
  }
  return false;
}

/** Warn on the first 503 of a window; swallow the burst; re-warn after 10s. */
export function logDebounced503(context: string, detail?: unknown): void {
  if (!shouldLog503(Date.now())) return;
  if (detail !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(context, detail);
  } else {
    // eslint-disable-next-line no-console
    console.warn(context);
  }
}

/** Reset the warning latch (test isolation / incident boundary). */
export function reset503Debounce(): void {
  lastWarnAt = 0;
}