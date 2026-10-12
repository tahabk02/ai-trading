/**
 * quoteLiveness.ts — THE OTC LIVENESS DECISION (PART 43.5 [473])
 *
 * "Is this quote live?" is answered differently for the two instrument classes:
 *
 *   • OTC  — 24/7, normally fed by Pocket Option. "Live" means a PO-sourced
 *            print, so freshness is measured against the newest PO tick. A
 *            non-PO market proxy (Frankfurter / ER-API / GitHub / last-known)
 *            re-served every second must NOT read as live — that is the
 *            PO-offline state the terminal must withhold a verdict/execution on.
 *
 *   • REAL — keeps the any-source freshness rule; the weekly market-close gate
 *            (marketClosed) still forces not-live while the session is shut.
 *
 * Pure and dependency-light (only the source classifier) so the terminal
 * contract is unit-testable without a live ring, registry or socket.
 */

import { isPocketOptionSource } from "./pocketOptionSource";

export interface QuoteLiveness {
  /** Freshness to surface to the terminal for this instrument class. */
  freshAgeMs: number | null;
  /** "This price is NOT live" flag for this instrument class. */
  staleLive: boolean;
  /** True for an OTC instrument currently priced by a non-PO market proxy. */
  poOffline: boolean;
}

export function resolveQuoteLiveness(args: {
  assetSubType: string | null | undefined;
  marketClosed: boolean;
  source: string | null;
  freshAgeMs: number | null;
  staleLive: boolean;
  poFreshAgeMs: number | null;
  poStaleLive: boolean;
}): QuoteLiveness {
  const isOtc = (args.assetSubType ?? "otc") === "otc";
  const poOffline =
    isOtc &&
    !args.marketClosed &&
    args.source != null &&
    !isPocketOptionSource(args.source);
  return {
    freshAgeMs: isOtc ? args.poFreshAgeMs : args.freshAgeMs,
    staleLive: args.marketClosed || (isOtc ? args.poStaleLive : args.staleLive),
    poOffline,
  };
}
