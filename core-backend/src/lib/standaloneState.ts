/**
 * standaloneState.ts — the DEPENDENCY-FREE cross-service flag for the
 * Standalone SaaS Mode feed.
 *
 * WHY A SEPARATE MODULE
 * ─────────────────────
 * Two services need to agree on ONE fact — "is the standalone fallback feed
 * currently authoring the tape?" — without importing each other:
 *
 *   • `standaloneFeed.service.ts` WRITES the state (it owns the emitter).
 *   • `tickIngestion.service.ts` READS it (to stand down its per-symbol HTTP
 *     poll while standalone drives every symbol, so a single symbol never
 *     receives two competing tick producers).
 *
 * Importing the writer from the reader directly would create a static import
 * cycle (tickIngestion → standaloneFeed → pocketOptionBridge → tickIngestion).
 * This module has NO imports, so either side can depend on it safely.
 *
 * It holds ONLY plain data — no timers, no sockets, no I/O — so it is trivially
 * testable in isolation.
 */

/** Which authoritative feed the standalone emitter is currently serving. */
export type StandaloneFeedMode =
  | "live" // PO bridge is authoritative — standalone is standing down
  | "standalone_proxy" // real public proxy only (no OTC synthetic needed)
  | "standalone_synthetic" // synthetic OTC only (no proxy symbols live)
  | "mixed"; // both proxy (non-OTC) and synthetic (OTC) symbols live

export interface StandaloneSnapshot {
  /** True while the standalone fallback feed is authoring ticks. */
  active: boolean;
  /** Current mode (see StandaloneFeedMode). "live" when standing down. */
  mode: StandaloneFeedMode;
  /** Count of non-OTC symbols served from a REAL public proxy this beat. */
  proxyPairs: number;
  /** Count of OTC symbols served from the labeled synthetic generator. */
  syntheticPairs: number;
  /** Epoch ms the snapshot was last written. */
  updatedAt: number;
}

const INACTIVE: StandaloneSnapshot = Object.freeze({
  active: false,
  mode: "live",
  proxyPairs: 0,
  syntheticPairs: 0,
  updatedAt: 0,
});

let snapshot: StandaloneSnapshot = { ...INACTIVE };

export const standaloneState = {
  /** Read the latest snapshot (a copy — callers cannot mutate shared state). */
  get(): StandaloneSnapshot {
    return { ...snapshot };
  },

  /** True while the standalone fallback feed is authoring ticks. */
  isActive(): boolean {
    return snapshot.active;
  },

  /** Overwrite the snapshot (called by the standalone feed each beat). */
  set(next: Omit<StandaloneSnapshot, "updatedAt"> & { updatedAt?: number }): void {
    snapshot = {
      active: next.active,
      mode: next.mode,
      proxyPairs: next.proxyPairs,
      syntheticPairs: next.syntheticPairs,
      updatedAt: next.updatedAt ?? Date.now(),
    };
  },

  /** Return to the inactive/"live" state (PO authoritative or service stopped). */
  reset(): void {
    snapshot = { ...INACTIVE, updatedAt: Date.now() };
  },
};
