import { normalizeSymbol } from "@/services/api";

/**
 * PRO DEEP-LINK — canonical route + pure helpers for the Market Terminal →
 * Pro Terminal jump. Kept side-effect free so the four deep-link behaviors are
 * unit-testable in the node environment (no DOM / Next router needed).
 *
 * URL contract: /dashboard/pro?symbol=<ENCODED_CANONICAL>
 *   • canonical form comes from `normalizeSymbol` (EUR/USD, never EURUSD)
 *   • a missing / non-normalizable symbol resolves to a redirect to /dashboard
 */

export const PRO_TERMINAL_ROUTE = "/dashboard/pro";
export const MARKET_TERMINAL_ROUTE = "/dashboard";

/** Canonical symbol from a raw `?symbol=` value, or null when unusable. */
export function normalizeSymbolQuery(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  return normalizeSymbol(String(raw));
}

/** The PRO route href for a symbol: /dashboard/pro?symbol=EUR%2FUSD
 *  Optionally carries the currently selected expiration as tf=<SECONDS>
 *  (canonical PO set: 60/120/180/300/600 …), which the Pro page snaps onto
 *  `selectedExpirationSeconds`. */
export function buildProHref(
  symbol: string,
  expirationSeconds?: number,
): string {
  const canon = normalizeSymbol(symbol) ?? symbol.trim().toUpperCase();
  const base = `${PRO_TERMINAL_ROUTE}?symbol=${encodeURIComponent(canon)}`;
  if (
    expirationSeconds &&
    Number.isFinite(expirationSeconds) &&
    expirationSeconds > 0
  ) {
    return `${base}&tf=${Math.round(expirationSeconds)}`;
  }
  return base;
}

/** Parse the `?tf=` query value (expiration in SECONDS) into a finite positive
 *  integer, or null when absent / non-numeric / non-positive. The Pro page
 *  feeds the result through the store's PO-set snapper. */
export function resolveTfParam(
  raw: string | null | undefined,
): number | null {
  if (raw == null) return null;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

/**
 * Resolves a `?symbol=` query into either a redirect or the canonical symbol.
 * `{ redirect: "/dashboard" }`  — symbol missing or non-normalizable
 * `{ symbol: "EUR/USD" }`       — pre-load this pair
 */
export function resolveProSymbol(
  query: string | null | undefined,
): { redirect: string } | { symbol: string } {
  const canon = normalizeSymbolQuery(query);
  if (!canon) return { redirect: MARKET_TERMINAL_ROUTE };
  return { symbol: canon };
}

/**
 * Stops an event from bubbling to the card's navigate-on-click handler so
 * nested interactive controls (horizon pills, the PRO button) never trigger a
 * card-wide navigation.
 */
export function suppressCardNav(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}