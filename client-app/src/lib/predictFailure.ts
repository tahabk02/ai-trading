/**
 * predictFailure.ts — PART 43.4 [470] /predict FAILURE CLASSIFIER
 *
 * A `/predict` HTTP failure is one of two very different things:
 *
 *   • A TRANSIENT "awaiting live data" 503 — the engine has no fresh real tick
 *     yet, or not enough real 1-minute bars to run the zero-fabrication
 *     pipeline (see `signal.controller.ts`: `connecting` / `collecting`
 *     states). This is a HANDLED WAITING STATE the terminal is designed around:
 *     the store keeps the last good signal, flips the calm "waiting" banner and
 *     re-polls with a per-symbol backoff. It is NOT an application error and
 *     must never be logged as `console.error`.
 *
 *   • EVERYTHING ELSE — a real 500/502/504, a 503 WITHOUT the awaiting marker
 *     (cache/db unavailable), or a 4xx validation failure — is a genuine error
 *     the UI must surface. 429 (rate limited) is transient: the request was
 *     never accepted, so it is recoverable.
 *
 * Transport-level failures (axios timeout / no HTTP response) are classified in
 * the api layer, not here. Pure functions — no axios, unit-testable.
 */

/** The engine's own "no fresh tick yet" error codes (signal.controller). */
export const AWAITING_LIVE_DATA_ERRORS = [
  "Awaiting real-time tick",
  "Awaiting live market data",
] as const;

interface PredictErrorBody {
  error?: unknown;
  message?: unknown;
  /** `true` on the 503 "awaiting real-time tick" payload. */
  connecting?: unknown;
  /** `true` on the 503 "awaiting live market data" (building real bars) payload. */
  collecting?: unknown;
}

/**
 * True when a 503 response body is the engine's transient "still waiting"
 * state. Recognises the exact error codes, the `connecting`/`collecting`
 * flags, and (defensively) the message copy.
 */
export function isAwaitingLiveData(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as PredictErrorBody;
  if (b.connecting === true || b.collecting === true) return true;
  const err = typeof b.error === "string" ? b.error : "";
  if ((AWAITING_LIVE_DATA_ERRORS as readonly string[]).includes(err)) return true;
  const msg = typeof b.message === "string" ? b.message : "";
  return /awaiting (real-?time tick|live market data)|no fresh live quote observed|waiting for real-?time tick|not enough real historical bars/i.test(
    msg,
  );
}

/**
 * Recoverable (handled, re-poll with per-symbol backoff) vs. hard error.
 *   • 429                                  → recoverable
 *   • 503 carrying the awaiting-live-data  → recoverable (the waiting state)
 *   • any other status (500/502/504, a bare 503, 4xx) → hard error
 */
export function isRecoverablePredictFailure(
  status: number | undefined,
  body: unknown,
): boolean {
  if (status === 429) return true;
  if (status === 503 && isAwaitingLiveData(body)) return true;
  return false;
}
