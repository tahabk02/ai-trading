/**
 * engineCircuitBreaker — per-target circuit breaker for the AI Engine proxy.
 *
 * Enterprise resilience: consecutive transient failures against the Python
 * engine (timeout / unreachable / 5xx) open the circuit for a cooldown window,
 * after which /predict stops re-attempting the dead engine and serves the
 * stale-while-unavailable / layered fallback immediately (fast, no 503 storm,
 * no hammering a still-starting service).
 *
 * States:
 *   CLOSED     — normal; outcomes counted in a sliding window.
 *   OPEN       — engine not attempted; every call serves the fallback.
 *   HALF-OPEN  — cooldown elapsed; ONE probe attempt allowed. A probe
 *                SUCCESS closes the circuit; a probe FAILURE re-opens it
 *                immediately (anti-flap, no 3-failure warm-up again).
 *
 * Tunable via env:
 *   AI_ENGINE_CIRCUIT_FAILURES   (default 3) failures within the window
 *   AI_ENGINE_CIRCUIT_WINDOW_MS  (default 20_000) sliding window
 *   AI_ENGINE_CIRCUIT_OPEN_MS    (default 15_000) cooldown once open
 */

const FAILURE_THRESHOLD = Math.max(
  1,
  Number(process.env.AI_ENGINE_CIRCUIT_FAILURES) || 3,
);
const WINDOW_MS = Math.max(1_000, Number(process.env.AI_ENGINE_CIRCUIT_WINDOW_MS) || 20_000);
const OPEN_COOLDOWN_MS = Math.max(1_000, Number(process.env.AI_ENGINE_CIRCUIT_OPEN_MS) || 15_000);

const failuresByKey = new Map<string, number[]>();
const openUntilByKey = new Map<string, number>();
const halfOpenKeys = new Set<string>();

export interface CircuitState {
  open: boolean;
  halfOpen: boolean;
  failuresInWindow: number;
  opensAtMs?: number;
  cooldownMs: number;
}

function pruneFailures(key: string): void {
  const now = Date.now();
  const kept = (failuresByKey.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  failuresByKey.set(key, kept);
}

/** True when the circuit for `key` is OPEN (do not attempt the engine). */
export function engineCircuitOpen(key: string): boolean {
  pruneFailures(key);
  const until = openUntilByKey.get(key);
  if (until == null) return false;
  if (Date.now() < until) return true;
  // Cooldown elapsed → HALF-OPEN: the next engine attempt is the single probe
  // (the caller either succeeds → recordEngineSuccess, or fails → the failure
  // re-opens the circuit immediately).
  openUntilByKey.delete(key);
  halfOpenKeys.add(key);
  return false;
}

/** Register a transient engine failure; opens / re-opens the circuit. */
export function recordEngineFailure(key: string): void {
  pruneFailures(key);
  if (halfOpenKeys.has(key)) {
    // Failed probe → re-open immediately (no warm-up re-count).
    halfOpenKeys.delete(key);
    openUntilByKey.set(key, Date.now() + OPEN_COOLDOWN_MS);
    return;
  }
  const arr = failuresByKey.get(key) ?? [];
  arr.push(Date.now());
  failuresByKey.set(key, arr);
  if (arr.length >= FAILURE_THRESHOLD) {
    openUntilByKey.set(key, Date.now() + OPEN_COOLDOWN_MS);
  }
}

/** Register a successful engine call — closes any open or half-open circuit. */
export function recordEngineSuccess(key: string): void {
  failuresByKey.delete(key);
  openUntilByKey.delete(key);
  halfOpenKeys.delete(key);
}

/** Inspect the breaker state for `key` (diagnostics / tests). */
export function engineCircuitState(key: string): CircuitState {
  pruneFailures(key);
  const now = Date.now();
  const until = openUntilByKey.get(key);
  const open = until != null && now < until;
  return {
    open,
    halfOpen: !open && halfOpenKeys.has(key),
    failuresInWindow: (failuresByKey.get(key) ?? []).length,
    ...(until != null ? { opensAtMs: until } : {}),
    cooldownMs: OPEN_COOLDOWN_MS,
  };
}

/** Reset the breaker for one key (or all keys when omitted) — ops tooling. */
export function resetEngineCircuit(key?: string): void {
  if (key) {
    failuresByKey.delete(key);
    openUntilByKey.delete(key);
    halfOpenKeys.delete(key);
  } else {
    failuresByKey.clear();
    openUntilByKey.clear();
    halfOpenKeys.clear();
  }
}