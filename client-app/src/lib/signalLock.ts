/**
 * EXPIRY-SCOPED SIGNAL LOCK.
 *
 * Binary options are a COMMIT-at-entry product: the direction the operator acts
 * on must be the one that was evaluated for the horizon they selected. The
 * store previously overwrote `predictionData` (direction + confidence +
 * target_price) on EVERY WebSocket dispatch, so the Pro Terminal's TGT/ANC and
 * direction badge re-evaluated per tick — the "clignotent" flickering the
 * operator reported, and a TGT that never stayed put for the chosen expiry.
 *
 * The existing `SignalHoldBuffer` does not solve this: it stabilizes the CHART's
 * bar tint and target-candle gate on a fixed 60s bucket, and it never touches
 * the store contract the Pro Terminal reads.
 *
 * Lock semantics:
 *  • A qualifying directional signal is COMMITTED with a snapshot of the
 *    contract fields and an `expiresAtMs` derived from the selected expiry.
 *  • While locked, incoming dispatches are recorded for diagnostics but CANNOT
 *    mutate the locked fields. The live PRICE keeps ticking — only the committed
 *    verdict is frozen, which is exactly the entry contract.
 *  • The lock is bound to (symbol, horizon, expiry). Changing ANY of them
 *    invalidates it, so switching expiry forces a genuine fresh evaluation
 *    rather than inheriting a verdict graded for a different horizon.
 *  • On maturity the lock releases and the next qualifying signal may commit.
 */
import { MIN_EXECUTABLE_TIER, TIER_THRESHOLDS } from "./signalTiers";

/**
 * Execution gate in PERCENT (0..100), matching the scale the store's
 * `predictionData.confidence` and `applyLiveSignal`'s `conf100` use.
 * TIER_THRESHOLDS is 0..1 (T1 = 0.965) — convert once, here, so the two scales
 * can never be silently compared against each other.
 */
export const LOCK_MIN_CONFIDENCE_PCT = TIER_THRESHOLDS[MIN_EXECUTABLE_TIER] * 100;

export interface LockedSignal {
  symbol: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  targetPrice: number;
  confidence: number;
  horizonMinutes: number;
  expirationSeconds: number;
  /** Epoch ms when this verdict was committed. */
  lockedAtMs: number;
  /** Epoch ms when it matures and a new evaluation is allowed. */
  expiresAtMs: number;
}

export interface LockIdentity {
  symbol: string;
  horizonMinutes: number;
  expirationSeconds: number;
}

export function lockIdentityKey(identity: LockIdentity): string {
  const sym = (identity.symbol || "").trim().toUpperCase();
  const hz = Number.isFinite(identity.horizonMinutes)
    ? identity.horizonMinutes
    : 0;
  const exp = Number.isFinite(identity.expirationSeconds)
    ? identity.expirationSeconds
    : 0;
  return `${sym}|h${hz}|e${exp}`;
}

function positive(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export class ExpirySignalLock {
  private lock: LockedSignal | null = null;

  /** The active lock, or null when absent, mismatched, or matured. */
  current(identity: LockIdentity, nowMs: number): LockedSignal | null {
    const lock = this.lock;
    if (!lock) return null;
    // Identity drift (symbol / horizon / expiry change) invalidates the lock:
    // a verdict graded for 1m must never survive a switch to 10m.
    if (lockIdentityKey(lock) !== lockIdentityKey(identity)) return null;
    if (!Number.isFinite(nowMs) || nowMs >= lock.expiresAtMs) return null;
    return lock;
  }

  /**
   * Try to commit a signal. Returns the ACTIVE lock after the call — either the
   * freshly committed one, or a pre-existing one that was preserved (an
   * in-window dispatch is IGNORED, never allowed to overwrite).
   *
   * Returns null when nothing is locked: the input was not commit-eligible and
   * no prior lock is active.
   */
  commit(
    identity: LockIdentity,
    input: {
      direction: "BUY" | "SELL";
      price: number;
      targetPrice: number;
      confidence: number;
    },
    nowMs: number,
    minConfidencePct: number = LOCK_MIN_CONFIDENCE_PCT,
  ): LockedSignal | null {
    const existing = this.current(identity, nowMs);
    if (existing) return existing;

    const direction = input.direction;
    const price = positive(input.price);
    const confidence = positive(input.confidence);
    const threshold = positive(minConfidencePct) || LOCK_MIN_CONFIDENCE_PCT;
    const durationMs = Math.max(1, positive(identity.expirationSeconds)) * 1000;

    // Not commit-eligible: no direction, no real price, or a sub-threshold
    // verdict. Nothing is held — the next qualifying dispatch may commit.
    if (direction !== "BUY" && direction !== "SELL") return null;
    if (price <= 0) return null;
    if (confidence < threshold) return null;

    const lock: LockedSignal = {
      symbol: (identity.symbol || "").trim().toUpperCase(),
      direction,
      entryPrice: price,
      targetPrice: positive(input.targetPrice),
      confidence,
      horizonMinutes: identity.horizonMinutes,
      expirationSeconds: identity.expirationSeconds,
      lockedAtMs: nowMs,
      expiresAtMs: nowMs + durationMs,
    };
    this.lock = lock;
    return lock;
  }

  /** Drop the lock (symbol switch, manual reset, hard error). */
  reset(): void {
    this.lock = null;
  }
}
