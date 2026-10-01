// ── P1-2026-09-24 — NON-BLOCKING /predict BUDGET ───────────────────────────
// The Alpha.5 Pro Terminal's "Exécution de l'inférence ML haute vitesse..."
// spinner previously froze the component tree while a cold-cache RandomForest
// train held the FastAPI handler (up to 120s). The engine now ships a fast
// structural verdict via its 150ms inference budget; this client-side budget is
// the LAST line of defense: if /predict has not answered within
// PREDICT_ABORT_MS, the request is aborted so the UI can never lock.
//
// A budget abort is distinct from a user/symbol-switch abort signal (which the
// store already clears silently): it is classified as a recoverable
// PredictionTimeoutError → calm re-poll with backoff, not a spinner freeze.

export const PREDICT_ABORT_MS = 2000;

export interface PredictBudgetController {
  /** Combine into the axios request signal so budget + external aborts both fire. */
  signal: AbortSignal;
  /** True ONLY when the abort was caused by the budget timer (not externally). */
  isBudgetAbort: () => boolean;
  /** Clear the timer + free abort listeners once the request settles. */
  dispose: () => void;
}

/**
 * Install a wall-clock abort budget for a single prediction request.
 * - budgetMs <= 0 disables the timer (never aborts).
 * - After `budgetMs`, `signal` is aborted and `isBudgetAbort()` flips true.
 * - `dispose()` clears the pending timer and releases the listeners.
 */
export function installPredictBudget(
  budgetMs: number = PREDICT_ABORT_MS,
): PredictBudgetController {
  const controller = new AbortController();
  let budgetFired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (budgetMs > 0) {
    timer = setTimeout(() => {
      budgetFired = true;
      controller.abort();
    }, budgetMs);
  }

  return {
    signal: controller.signal,
    isBudgetAbort: () => budgetFired,
    dispose: () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = undefined;
      }
      // A settled request no longer needs the signal; abort frees any listener.
      controller.abort();
    },
  };
}