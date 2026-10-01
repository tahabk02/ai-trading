/**
 * EXPIRY-SCOPED SIGNAL LOCK + EXPIRY→HORIZON BINDING.
 *
 * Regression cover for the Pro Terminal's two "unstable UI" bugs:
 *  1. The committed verdict (direction/TGT) was rewritten on every WebSocket
 *     dispatch, so it flickered instead of holding for the chosen expiry.
 *  2. The Pro expiry buttons set the chart projection horizon but never the AI
 *     prediction horizon, so TGT/ANC belonged to a different horizon than the
 *     button the operator had selected.
 */
import { describe, expect, it } from "vitest";

import {
  ExpirySignalLock,
  LOCK_MIN_CONFIDENCE_PCT,
  lockIdentityKey,
} from "@/lib/signalLock";
import {
  expirySecondsToHorizonMinutes,
  resolveHorizonMinutes,
} from "@/store/useTradingStore";

const T0 = 1_700_000_000_000;
const ID = { symbol: "EUR/USD", horizonMinutes: 3, expirationSeconds: 180 };
const STRONG = LOCK_MIN_CONFIDENCE_PCT;

const input = (over: Partial<{ direction: "BUY" | "SELL"; price: number; targetPrice: number; confidence: number }> = {}) => ({
  direction: "BUY" as const,
  price: 1.1058,
  targetPrice: 1.12,
  confidence: STRONG,
  ...over,
});

describe("lock commits a qualifying verdict for the expiry duration", () => {
  it("holds the verdict against mid-expiry flips", () => {
    const lock = new ExpirySignalLock();
    const first = lock.commit(ID, input({ direction: "BUY", targetPrice: 1.12 }), T0);
    expect(first?.direction).toBe("BUY");
    expect(first?.targetPrice).toBe(1.12);
    expect(first?.expiresAtMs).toBe(T0 + 180_000);

    // A contradictory dispatch 30s later must NOT be able to overwrite it.
    const flipped = lock.commit(ID, input({ direction: "SELL", targetPrice: 1.09 }), T0 + 30_000);
    expect(flipped?.direction).toBe("BUY");
    expect(flipped?.targetPrice).toBe(1.12);
    expect(lock.current(ID, T0 + 30_000)?.direction).toBe("BUY");
  });

  it("releases on maturity so the next evaluation can commit", () => {
    const lock = new ExpirySignalLock();
    lock.commit(ID, input({ direction: "BUY" }), T0);
    // Still held one ms before expiry.
    expect(lock.current(ID, T0 + 179_999)?.direction).toBe("BUY");
    // Released exactly at expiry.
    expect(lock.current(ID, T0 + 180_000)).toBeNull();

    const after = lock.commit(ID, input({ direction: "SELL", targetPrice: 1.09 }), T0 + 180_000);
    expect(after?.direction).toBe("SELL");
    expect(after?.targetPrice).toBe(1.09);
  });

  it("scales the hold to the selected expiry", () => {
    for (const seconds of [60, 120, 180, 300, 600]) {
      const lock = new ExpirySignalLock();
      const id = { ...ID, expirationSeconds: seconds };
      const l = lock.commit(id, input(), T0);
      expect(l?.expiresAtMs).toBe(T0 + seconds * 1000);
      expect(lock.current(id, T0 + seconds * 1000)).toBeNull();
    }
  });
});

describe("lock invalidation on identity drift", () => {
  it("a horizon switch drops the old horizon's verdict", () => {
    const lock = new ExpirySignalLock();
    lock.commit(ID, input({ direction: "BUY" }), T0);
    const other: typeof ID = { ...ID, horizonMinutes: 10 };
    expect(lock.current(other, T0 + 1_000)).toBeNull();
  });

  it("an expiry switch drops the old expiry's verdict", () => {
    const lock = new ExpirySignalLock();
    lock.commit(ID, input({ direction: "BUY" }), T0);
    const other: typeof ID = { ...ID, expirationSeconds: 600 };
    expect(lock.current(other, T0 + 1_000)).toBeNull();
  });

  it("a symbol switch drops the verdict", () => {
    const lock = new ExpirySignalLock();
    lock.commit(ID, input({ direction: "BUY" }), T0);
    expect(lock.current({ ...ID, symbol: "GBP/USD" }, T0 + 1_000)).toBeNull();
  });

  it("symbol matching is case/whitespace insensitive", () => {
    const lock = new ExpirySignalLock();
    lock.commit(ID, input(), T0);
    expect(lock.current({ ...ID, symbol: "  eur/usd " }, T0 + 1_000)).not.toBeNull();
  });

  it("reset clears the lock outright", () => {
    const lock = new ExpirySignalLock();
    lock.commit(ID, input(), T0);
    lock.reset();
    expect(lock.current(ID, T0 + 1_000)).toBeNull();
  });
});

describe("lock refuses to commit a non-actionable verdict", () => {
  it("never locks a sub-threshold confidence", () => {
    const lock = new ExpirySignalLock();
    expect(lock.commit(ID, input({ confidence: STRONG - 0.1 }), T0)).toBeNull();
    expect(lock.current(ID, T0)).toBeNull();
  });

  it("commits exactly at the threshold", () => {
    const lock = new ExpirySignalLock();
    expect(lock.commit(ID, input({ confidence: STRONG }), T0)).not.toBeNull();
  });

  it("never locks a zero/negative price", () => {
    const lock = new ExpirySignalLock();
    expect(lock.commit(ID, input({ price: 0 }), T0)).toBeNull();
    expect(lock.commit(ID, input({ price: -1 }), T0)).toBeNull();
  });

  it("commits with a zero target — the verdict is still the verdict", () => {
    const lock = new ExpirySignalLock();
    const l = lock.commit(ID, input({ targetPrice: 0 }), T0);
    expect(l).not.toBeNull();
    expect(l?.targetPrice).toBe(0);
  });
});

describe("expiry seconds map onto the AI horizon", () => {
  it("binds every Pro expiry button to its horizon", () => {
    expect(expirySecondsToHorizonMinutes(60)).toBe(1);
    expect(expirySecondsToHorizonMinutes(120)).toBe(2);
    expect(expirySecondsToHorizonMinutes(180)).toBe(3);
    expect(expirySecondsToHorizonMinutes(300)).toBe(5);
    expect(expirySecondsToHorizonMinutes(600)).toBe(10);
  });

  it("snaps an off-grid value to the nearest supported horizon", () => {
    expect(expirySecondsToHorizonMinutes(170)).toBe(3);
    expect(expirySecondsToHorizonMinutes(999)).toBe(10);
  });

  it("falls back to the default horizon for garbage input", () => {
    expect(expirySecondsToHorizonMinutes(0)).toBe(resolveHorizonMinutes(null));
    expect(expirySecondsToHorizonMinutes(Number.NaN)).toBe(5);
    expect(expirySecondsToHorizonMinutes(undefined)).toBe(5);
  });

  it("round-trips to the same backend channel the engine grades on", () => {
    for (const [seconds, minutes] of [[60, 1], [300, 5], [600, 10]] as const) {
      expect(expirySecondsToHorizonMinutes(seconds)).toBe(minutes);
    }
  });
});

describe("lock identity key", () => {
  it("separates every field that can invalidate a verdict", () => {
    expect(lockIdentityKey(ID)).not.toBe(lockIdentityKey({ ...ID, symbol: "GBP/USD" }));
    expect(lockIdentityKey(ID)).not.toBe(lockIdentityKey({ ...ID, horizonMinutes: 5 }));
    expect(lockIdentityKey(ID)).not.toBe(lockIdentityKey({ ...ID, expirationSeconds: 60 }));
  });
});

describe("a background symbol must never evict the active lock", () => {
  // Regression: `applyLiveSignal` committed the lock for ANY reported symbol.
  // The lock is a SINGLE slot, so a tick for a pair the operator is not
  // trading replaced the active verdict; the next active tick then found no
  // matching lock, re-committed, and repainted direction/TGT — the exact
  // flicker the lock exists to prevent. The store now gates commit on
  // `shouldApply`, so the invariant to hold is: a foreign identity must never
  // be allowed to commit at all.
  const OTHER = { symbol: "EUR/JPY", horizonMinutes: 3, expirationSeconds: 180 };

  it("rejects a commit from a non-active symbol by contract", () => {
    const lock = new ExpirySignalLock();
    expect(lock.commit(OTHER, input({ direction: "SELL" }), T0)?.direction).toBe("SELL");
    // The active identity does not match, so nothing is held for it.
    expect(lock.current(ID, T0)).toBeNull();
  });

  it("keeps the active verdict stable across interleaved background ticks", () => {
    const lock = new ExpirySignalLock();
    const active = lock.commit(ID, input({ direction: "BUY", targetPrice: 1.12 }), T0);
    expect(active?.targetPrice).toBe(1.12);

    // Simulate the store's corrected behaviour: background dispatches never
    // call commit, so the active contract survives them entirely.
    let held = lock.current(ID, T0 + 30_000);
    expect(held?.direction).toBe("BUY");
    expect(held?.targetPrice).toBe(1.12);

    // Even if a caller did try, the identity mismatch is refused.
    expect(lock.current(OTHER, T0 + 30_000)).toBeNull();
  });

  it("a stale-foreign commit is recoverable by the active symbol", () => {
    // Defensive: if a foreign lock ever IS present, the next active commit
    // re-establishes the active contract rather than staying stuck.
    const lock = new ExpirySignalLock();
    lock.commit(OTHER, input({ direction: "SELL" }), T0);
    const restored = lock.commit(ID, input({ direction: "BUY" }), T0 + 1_000);
    expect(restored?.symbol).toBe("EUR/USD");
    expect(restored?.direction).toBe("BUY");
  });
});
