/**
 * feedStatus.ts — PART 44 [496] RESTORED-FEED STATUS DECISION (PURE)
 *
 * A successful probe after an outage flips the broadcast status. What that
 * status SAYS depends on PROVENANCE:
 *
 *   • An OTC instrument is bullish ONLY on the Pocket Option tape. When the
 *     HTTP cascade has "recovered" and is now serving the pair from a non-PO
 *     source (Frankfurter / ER-API / GitHub data provider), the tape is alive
 *     on PROXY prices — that is a DEGRADED condition, never ONLINE. Right up
 *     next to that, the point of the [494] collector gate is that proxy ticks
 *     never author OTC history.
 *
 *   • Any genuinely PO-sourced print (or a non-OTC symbol, where the HTTP
 *     cascade is the legitimate standard feed) is a real recovery → ONLINE.
 *
 * Pure + side-effect free so it is trivially unit-tested.
 */

import { isPocketOptionSource } from "./pocketOptionSource";
import { symbolRegistry } from "../services/symbolRegistry.service";

export type RestoredFeedStatus = "ONLINE" | "DEGRADED";

export interface RestoredFeedStatusResult {
  status: RestoredFeedStatus;
  /** One-line human-readable status message for the engine-status broadcast. */
  message: string;
}

/**
 * Decide the broadcast status for a symbol whose feed probe just succeeded,
 * given the symbol and the PROVENANCE source that produced the recovered print.
 *
 * Strictness: an OTC pair may ONLY read ONLINE when the recovered print is
 * genuinely PO-sourced. A non-PO feed, OR an absent/unknown provenance stamp,
 * keeps the engine DEGRADED — a pair whose tape source we cannot name must
 * never be presented as live-fresh PO.
 */
export function restoredFeedStatus(
  symbol: string,
  source: string | null | undefined,
): RestoredFeedStatusResult {
  const norm = String(symbol || "").trim().toUpperCase();
  const isOtc = symbolRegistry.getAssetSubType(norm) === "otc";
  if (isOtc) {
    const src = source != null ? String(source).trim() : "";
    if (src === "") {
      return {
        status: "DEGRADED",
        message: `DEGRADED · PO offline for ${norm} (recovered source unknown).`,
      };
    }
    if (!isPocketOptionSource(src)) {
      return {
        status: "DEGRADED",
        message: `DEGRADED · PO offline (proxy prices) for ${norm}.`,
      };
    }
  }
  return {
    status: "ONLINE",
    message: `Live tick stream restored for ${norm}.`,
  };
}