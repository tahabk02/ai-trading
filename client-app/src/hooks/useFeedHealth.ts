"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * FEED HEALTH — 1 Hz REF-SAMPLED READOUT
 * ============================================================================
 * WHY THIS HOOK EXISTS
 *
 * The health BOOLEANS (`connected`, `stalePrice`, `streamStalled`) are already
 * safe to render: `useWebSocket` change-gates them behind a ref comparison and
 * re-evaluates them on a 1s heartbeat, so they flip only on genuine transitions
 * (typically a handful of times per session, not per tick).
 *
 * The continuous READOUT is the danger. "Last tick 340ms ago" is a number that
 * changes on every single incoming packet. Rendering it straight from live store
 * state means one React render per tick, which re-renders the Pro page and
 * re-invokes the chart's render path — the exact render storm the zero-hop
 * invariant exists to prevent.
 *
 * THE PATTERN
 *
 *   ticks ──► ref (no render) ──► 1 Hz interval ──► setState ONLY on change
 *
 * Three properties make this safe:
 *
 *   1. The tick loop never touches React state. It only writes `lastUpdateRef`.
 *      A ref write costs nothing and schedules no render.
 *   2. The interval runs at 1 Hz, so the ceiling is 1 render/second regardless
 *      of how fast packets arrive (1 Hz or 200 Hz).
 *   3. `setSnapshot` returns the PREVIOUS object reference when nothing changed.
 *      React bails out of re-rendering on an identical state reference, so a
 *      steady feed produces ZERO renders — the 1 Hz tick is not a 1 Hz render.
 *
 * The bail-out in (3) is the whole trick. Without it this hook would re-render
 * every second forever, which is still far better than per-tick but is still
 * avoidable.
 *
 * ZERO-HOP COMPLIANCE: this module subscribes to nothing and adds no listener to
 * the aggregator. The caller injects `getLastUpdateMs`, which reads a ref-backed
 * clock via `store.getState()` OUTSIDE of render. No tick handler is modified.
 */

export type FeedFreshness = "live" | "delayed" | "stale" | "dead";

export interface FeedHealthSnapshot {
  /** Sampled age of the newest price packet, in ms. Monotonic-ish. */
  ageMs: number;
  /** Coarse bucket derived from ageMs — what the badge colours key off. */
  freshness: FeedFreshness;
  /**
   * PRE-FORMATTED display string. Pre-formatting matters: a formatter that
   * returns a new string each sample would defeat the reference bail-out in
   * `setSnapshot`, because the string differs by value even when the meaning
   * ("0.4s") is unchanged between two samples.
   */
  displayAge: string;
}

const SAMPLE_INTERVAL_MS = 1_000;

/** Age thresholds. Mirrors useWebSocket's STALE_PRICE_MS (2s) intent. */
const DELAYED_MS = 1_000;
const STALE_MS = 2_000;
const DEAD_MS = 10_000;

export function classifyFreshness(ageMs: number): FeedFreshness {
  if (ageMs < DELAYED_MS) return "live";
  if (ageMs < STALE_MS) return "delayed";
  if (ageMs < DEAD_MS) return "stale";
  return "dead";
}

export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "--";
  if (ageMs < 1_000) return `${Math.round(ageMs)}ms`;
  if (ageMs < 60_000) return `${(ageMs / 1_000).toFixed(1)}s`;
  return `${Math.floor(ageMs / 60_000)}m`;
}

const EMPTY: FeedHealthSnapshot = {
  ageMs: 0,
  freshness: "live",
  displayAge: "--",
};

function sameSnapshot(a: FeedHealthSnapshot, b: FeedHealthSnapshot): boolean {
  return (
    a.ageMs === b.ageMs &&
    a.freshness === b.freshness &&
    a.displayAge === b.displayAge
  );
}

export interface UseFeedHealthOptions {
  /**
   * Reads the newest price timestamp (ms epoch) WITHOUT subscribing.
   * Implementations MUST read a ref or call `store.getState()` outside render —
   * reading reactive state here would re-subscribe and defeat the sampler.
   */
  getLastUpdateMs: () => number | null;
  /** Injectable clock, so tests are deterministic. */
  now?: () => number;
  /** Sampling cadence. Defaults to 1 Hz. Tests may raise it. */
  intervalMs?: number;
}

export function useFeedHealth({
  getLastUpdateMs,
  now = Date.now,
  intervalMs = SAMPLE_INTERVAL_MS,
}: UseFeedHealthOptions): FeedHealthSnapshot {
  const [snapshot, setSnapshot] = useState<FeedHealthSnapshot>(EMPTY);

  // Keep the reader in a ref so the interval never needs re-creating when the
  // caller's closure identity changes. A re-created interval would restart the
  // cadence on every render of the parent, which is its own subtle bug.
  const readerRef = useRef(getLastUpdateMs);
  readerRef.current = getLastUpdateMs;

  const sample = useCallback(() => {
    const last = readerRef.current();
    if (last == null) return; // no packet yet — keep the previous reading
    const ageMs = Math.max(0, now() - last);
    setSnapshot((prev) => {
      const next: FeedHealthSnapshot = {
        ageMs,
        freshness: classifyFreshness(ageMs),
        displayAge: formatAge(ageMs),
      };
      // Bail out with the SAME reference so React skips the render entirely.
      return sameSnapshot(prev, next) ? prev : next;
    });
  }, [now]);

  useEffect(() => {
    sample(); // paint a real reading immediately instead of showing "--" for 1s
    const id = setInterval(sample, intervalMs);
    return () => clearInterval(id);
  }, [sample, intervalMs]);

  return snapshot;
}
