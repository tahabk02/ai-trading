/**
 * standaloneMode.ts — STANDALONE SaaS MODE client flag.
 *
 * The backend authors a labeled fallback tape when the Pocket Option bridge is
 * offline (real public proxy for non-OTC, labeled synthetic for OTC). When that
 * mode is engaged the client must:
 *   • stop treating an OTC proxy/synthetic price as a hard "PO OFFLINE" blocker
 *     (the tape IS live, just not authoritatively PO), and
 *   • disclose it with an always-visible badge.
 *
 * This is a tiny module-level flag (NOT React state) because `isPoOfflineOtc`
 * is a pure, non-React helper called from half a dozen render paths and cannot
 * take a hook. `useWebSocket` writes it the instant a `standalone` feed_status
 * arrives — BEFORE the store `feedStatus` update, so every component that
 * re-renders on that store change reads the already-correct value.
 */

export type StandaloneFeedMode =
  | "standalone_proxy"
  | "standalone_synthetic"
  | "mixed";

let active = false;
let feedMode: StandaloneFeedMode | null = null;

/** Engage/disengage standalone mode. `mode` is required when engaging. */
export function setStandaloneMode(
  next: boolean,
  mode: StandaloneFeedMode | null = null,
): void {
  active = next;
  feedMode = next ? mode : null;
}

/** True while the backend is serving the standalone fallback tape. */
export function isStandaloneMode(): boolean {
  return active;
}

/** Current standalone feed mode, or null when not in standalone mode. */
export function getStandaloneFeedMode(): StandaloneFeedMode | null {
  return feedMode;
}

/** Test/support helper — returns to the default (PO authoritative) state. */
export function resetStandaloneMode(): void {
  active = false;
  feedMode = null;
}
