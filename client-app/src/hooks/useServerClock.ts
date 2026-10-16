"use client";

/**
 * useServerClock — the React wiring for the single server↔client clock.
 *
 * Two responsibilities, deliberately split so each is independently testable:
 *
 *   • `useServerClockOffsetSync()` — a low-frequency pump that folds the
 *     aggregator's raw `clockOffsetMs` into the terminal store's
 *     `serverTimeOffsetMs` (smoothed by the pure `estimateClockOffsetMs`). Call
 *     it ONCE per surface that owns the WS lifecycle (the Pro page).
 *
 *   • `useServerNowMs()` — a high-frequency, SSR-safe ticking clock returning
 *     `Date.now() + serverTimeOffsetMs`. Every countdown consumes THIS instead
 *     of the raw browser clock, so all boundaries agree.
 *
 * SSR-SAFE: `useServerNowMs` returns 0 until the browser mounts, so nothing
 * renders a wall-clock value during SSR / first paint (no hydration mismatch).
 */
import { useEffect, useState } from "react";
import { realtimeAggregator } from "@/store/useTradingStore";
import { useTerminalStore } from "@/store/useTerminalStore";
import { estimateClockOffsetMs, serverNowMs } from "@/lib/serverClock";

const DEFAULT_SYNC_INTERVAL_MS = 1_000;
const DEFAULT_NOW_INTERVAL_MS = 250;

/**
 * Pump the aggregator's server↔client offset into the terminal store.
 *
 * Reads the aggregator's PUBLIC `getClockOffsetMs()` (the exact offset the
 * bucket grid uses), smoothes it, and writes through `setServerTimeOffsetMs`
 * (which no-ops on a repeated value, so a converged estimate stops re-rendering
 * the store). Best-effort: any failure leaves the offset at its last value.
 */
export function useServerClockOffsetSync(
  intervalMs: number = DEFAULT_SYNC_INTERVAL_MS,
): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let disposed = false;

    const sync = () => {
      if (disposed) return;
      try {
        const raw = realtimeAggregator?.getClockOffsetMs?.() ?? 0;
        const store = useTerminalStore.getState();
        const next = estimateClockOffsetMs(store.serverTimeOffsetMs, raw);
        store.setServerTimeOffsetMs(next);
      } catch {
        /* never let clock sync break the tree */
      }
    };

    sync();
    const id = window.setInterval(sync, intervalMs);
    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);
}

/**
 * A ticking, server-corrected wall clock (ms since epoch). Returns 0 until the
 * browser mounts. Reads the offset from the store on EVERY tick (not via a
 * subscription), so a late offset write is picked up without re-subscribing.
 */
export function useServerNowMs(
  intervalMs: number = DEFAULT_NOW_INTERVAL_MS,
): number {
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const tick = () => {
      setNowMs(
        serverNowMs(
          Date.now(),
          useTerminalStore.getState().serverTimeOffsetMs,
        ),
      );
    };
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return nowMs;
}
