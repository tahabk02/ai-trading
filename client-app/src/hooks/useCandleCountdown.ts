"use client";

/**
 * useCandleCountdown — live candle-close countdown synchronized to the
 * active barrier/expiry window.
 *
 * Mirrors a professional binary-trading terminal: the countdown ticks down
 * to the next OHLC bucket close aligned to the trading window, giving the
 * trader a precise visual of when the current candle / barrier expires.
 *
 * PO-PARITY, L1-PURE: when a `realtimeAggregator` is provided the countdown
 * is grid-locked to the aggregator's boundary geometry (`getBoundary()` →
 * `leadGeometry`). With the default lead 0 that is the exact PO floor grid —
 * it counts down to the REAL bucket close on the backend's timestamp grid.
 * The browser clock never creates the boundary: with an aggregator the
 * countdown derives purely from upstream PO-aligned timestamps + their
 * wall-clock projection. Only when NO aggregator exists (pre-mount /
 * non-trading surface) does it fall back to an epoch-aligned wall-clock modulo.
 *
 * SSR-safe: 0/-- is rendered on the server and first client paint via the
 * `mounted` guard — the real countdown only starts the instant the browser
 * mounts (no hydration mismatch, no Date.now() during render).
 *
 * @param windowSeconds  Duration of the active trading window (e.g. 60 for 1m).
 * @param tickMs         Refresh cadence (default 250ms for a fluid sweep).
 * @param boundary       Optional lead-shifted boundary source (the aggregator).
 * @returns {remainingSeconds, progressPct, mounted}
 */
import { useEffect, useRef, useState } from "react";
import type { RealtimeCandleAggregator } from "@/lib/realtimeCandleAggregator";

export interface CandleCountdownState {
  /** Whole seconds remaining to the next rollover (0 when unmounted). */
  remainingSeconds: number;
  /** 0..1 fraction of the window already elapsed (for a progress bar). */
  progressPct: number;
  /** True once the browser has mounted (real countdown live). */
  mounted: boolean;
}

export function useCandleCountdown(
  windowSeconds: number,
  tickMs = 250,
  aggregator?: RealtimeCandleAggregator | null,
): CandleCountdownState {
  const [mounted, setMounted] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [progressPct, setProgressPct] = useState(0);
  const windowRef = useRef<number>(Math.max(1, windowSeconds));
  const aggregatorRef = useRef<RealtimeCandleAggregator | null | undefined>(
    aggregator,
  );

  useEffect(() => {
    windowRef.current = Math.max(1, Math.floor(windowSeconds) || 1);
  }, [windowSeconds]);

  useEffect(() => {
    aggregatorRef.current = aggregator;
  }, [aggregator]);

  useEffect(() => {
    let interval = 0;
    let dispose = false;

    // Pure boundary read: the aggregator's geometry already encodes the exact
    // bucket close (PO parity by default — real backend grid; leaded if an
    // explicit offset is configured). countdown = boundaryIn (ms to close);
    // progress = elapsed fraction of that bucket. Browser Date.now() never
    // appears when an aggregator is present.
    const readAggregator = () => {
      const agg = aggregatorRef.current;
      if (!agg) return null;
      // Preferred path (MASTER MISSION part 7.2): the explicit grid formula
      // candleCloseMs = liveTipBucketMs + timeframeMs, remaining = close − now.
      const cc = agg.getLiveCandleClose?.();
      if (cc) {
        const bw = cc.timeframeMs > 0 ? cc.timeframeMs : 60_000;
        const remainMs = cc.remainingMs;
        return {
          remainMs,
          progress: Math.min(1, Math.max(0, (bw - remainMs) / bw)),
          bw,
        };
      }
      const geo = agg.getBoundary();
      if (typeof geo?.boundaryIn !== "number") return null;
      const bw = geo.bucketMs > 0 ? geo.bucketMs : 60_000;
      return {
        remainMs: Math.max(0, geo.boundaryIn),
        progress: Math.min(1, Math.max(0, geo.progress)),
        bw,
      };
    };

    const tick = () => {
      if (dispose) return;
      const win = windowRef.current;
      const agg = readAggregator();
      if (agg) {
        // Bucket boundary — exact expiry against the aggregator's grid.
        setRemainingSeconds(Math.ceil(agg.remainMs / 1000));
        setProgressPct(agg.progress);
        return;
      }
      // Fallback (no aggregator yet): epoch-aligned rollover on the minute
      // grid (Pocket-style :00/:01/:02...). For 1m this equals 60 − (s % 60);
      // for longer windows it tracks the instantly-fixed grid of the selection.
      const nowMs = Date.now();
      const inWindow = nowMs % (win * 1000);
      const remainMs = (win * 1000 - inWindow) || win * 1000;
      const pct =
        (win * 1000 - remainMs) / (win * 1000);
      setRemainingSeconds(Math.ceil(remainMs / 1000));
      setProgressPct(Math.min(1, Math.max(0, pct)));
    };

    if (typeof window !== "undefined") {
      setMounted(true);
      tick();
      interval = window.setInterval(tick, tickMs);
    }

    return () => {
      dispose = true;
      if (interval) clearInterval(interval);
    };
  }, [tickMs]);

  return { remainingSeconds, progressPct, mounted };
}

export default useCandleCountdown;