/**
 * quoteProvenance.ts — HONEST DATA-ORIGIN LABEL FOR A QUOTE CARD (PART 38.2)
 *
 * The market terminal used to render every price as if it were live: a held
 * print re-pended for tape continuity (or a Frankfurter/open.er-api fallback
 * for a pair Pocket Option does not list) painted exactly like a genuine PO
 * tick, because `ageMs` counts the newest entry INCLUDING held ones. This
 * module turns the backend's quote provenance (`source` / `stale` /
 * `freshAgeMs` / `staleLive`) into the chip text + tooltip the card shows, so
 * an operator can tell at a glance whether they are looking at:
 *
 *   PO LIVE      — a genuine Pocket Option tick (the SSOT tier)
 *   <SOURCE>     — a REST fallback tier (Frankfurter, ER-API, Yahoo, GitHub …)
 *   HELD Xs      — no live print for X seconds (held / stale price)
 *   UNKNOWN      — payload predates provenance; never claimed as live
 *
 * Pure functions, no React — unit-testable and reusable by any surface.
 */

import type { MarketQuote } from "@/services/api";
import { getAssetSubType } from "@/constants/symbols";
import { isStandaloneMode } from "@/lib/standaloneMode";

/** Freshness floor mirrored from the backend (`QUOTE_STALE_AFTER_MS`). */
export const QUOTE_PROVENANCE_STALE_MS = 15_000;

export type ProvenanceTone = "live" | "fallback" | "held" | "unknown" | "closed";

export interface QuoteProvenance {
  /** Short chip text (fits the card). */
  label: string;
  /** Full tooltip sentence — provenance AND age, no euphemism. */
  title: string;
  tone: ProvenanceTone;
}

type ProvenanceQuote = Partial<
  Pick<
    MarketQuote,
    | "source"
    | "stale"
    | "staleLive"
    | "freshAgeMs"
    | "ageMs"
    | "marketClosed"
    | "lastTickAt"
  >
>;

/** Short, honest chip labels per known authoring feed. */
const SOURCE_LABELS: Record<string, string> = {
  pocket_option_ssot: "PO LIVE",
  pocket_option: "PO LIVE",
  frankfurter: "FRANKFURTER",
  open_er_api: "ER-API",
  coingecko: "COINGECKO",
  yahoo_finance: "YAHOO",
  github_repo: "GITHUB",
  github_repo_cached: "GITHUB",
  github_data_provider: "GITHUB",
  last_known_real: "HELD",
  held_stale_real: "HELD",
  pocket_option_held: "PO HELD",
  pocket_option_last_known: "PO HELD",
  yahoo_intraday_held: "YAHOO HELD",
  none: "NO SOURCE",
  standalone_synthetic: "SIMULATED",
};

/** Human sentence per known authoring feed (tooltip). */
const SOURCE_TITLES: Record<string, string> = {
  pocket_option_ssot: "Pocket Option live tick (SSOT tier)",
  pocket_option: "Pocket Option live tick",
  frankfurter: "Fallback: Frankfurter ECB reference rates",
  open_er_api: "Fallback: open.er-api.com exchange rates",
  coingecko: "Fallback: CoinGecko market price",
  yahoo_finance: "Fallback: Yahoo Finance quote",
  github_repo: "Fallback: GitHub market-data snapshot",
  github_repo_cached: "Fallback: GitHub market-data snapshot (cached)",
  github_data_provider: "GitHub data-provider tick",
  last_known_real: "Held print — last genuinely observed price",
  held_stale_real: "Held print — last genuinely observed price",
  pocket_option_held: "Held Pocket Option print from the bridge handshake",
  pocket_option_last_known: "Held Pocket Option print — last known",
  yahoo_intraday_held: "Held Yahoo intraday print",
  none: "No source recorded",
  standalone_synthetic:
    "Standalone mode — LABELED SYNTHETIC OTC price (no public source; not a real market print)",
};

/** "pocket_option_ssot:live" → "pocket_option_ssot" (HTTP-live stamp suffix). */
function normalizeSource(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().toLowerCase();
  if (!clean) return null;
  return clean.endsWith(":live") ? clean.slice(0, -":live".length) : clean;
}

/** True when raw is a genuine Pocket Option print (any PO tier, held included). */
export function isPocketOptionSource(raw: string | null | undefined): boolean {
  const source = normalizeSource(raw);
  return source != null && source.startsWith("pocket_option");
}

/**
 * PART 43.4 [469] — TRUE when an OTC instrument is being priced by a NON-Pocket
 * Option feed (a "market proxy": Frankfurter / ER-API / GitHub / last-known-real
 * …). For an OTC pair that is PO OFFLINE: the number on screen is NOT a PO
 * print, so it must not be dimmed-but-traded like one. Real-forex fallbacks (a
 * weekday Frankfurter ECB rate) and crypto feeds are NOT this state, and a
 * genuine PO print (PO-held included) is not either. Market-closed is its own
 * state — say so plainly, never "PO OFFLINE".
 */
export function isPoOfflineOtc(
  symbol: string,
  quote?: ProvenanceQuote | null,
): boolean {
  // STANDALONE SaaS MODE — when the fallback feed is engaged the OTC price is a
  // LABELED proxy/synthetic tick (disclosed by the standalone badge), not a
  // silent PO-offline proxy. It is a usable, continuously-flowing tape, so it
  // must not trip the "PO OFFLINE — not tradeable" blocker. The honest origin is
  // announced by the badge instead of by withholding the verdict.
  if (isStandaloneMode()) return false;
  if (!quote || quote.marketClosed === true) return false;
  if (getAssetSubType(symbol) !== "otc") return false;
  const source = normalizeSource(quote.source);
  return source != null && !source.startsWith("pocket_option");
}

function secondsText(ms: number | null | undefined): string {
  const value = Number.isFinite(ms as number) ? Math.max(0, ms as number) : 0;
  return `${Math.round(value / 1000)}s`;
}

/** "2026-10-09T20:59:00.000Z" → "20:59" (UTC), or "unknown". */
function closeTimeText(iso?: string | null): string {
  if (typeof iso !== "string" || iso.length < 16) return "unknown";
  const t = iso.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(t) ? t : "unknown";
}

/**
 * Derive the provenance chip for a quote.
 *
 * Liveness is decided by the backend's `staleLive` flag when present (it is
 * the authoritative ">15s without a fresh tick" state); for payloads that
 * predate provenance it falls back to `stale` — and NEVER calls a held print
 * live just because its `ageMs` is small.
 */
export function quoteProvenance(quote?: ProvenanceQuote | null): QuoteProvenance {
  // PART 42.1 [422] — market closed is a STATE ahead of any provenance: the
  // price shown is the last close, not a held live print. Say so plainly
  // (never "HELD", never a live/fallback tone).
  if (quote?.marketClosed === true) {
    const at = closeTimeText(quote.lastTickAt);
    return {
      label: "MARKET CLOSED",
      title: `Weekly forex market closed — price is the last close (${at} UTC), never live`,
      tone: "closed",
    };
  }

  const source = normalizeSource(quote?.source);
  const ageText = secondsText(quote?.freshAgeMs ?? quote?.ageMs ?? null);

  const declaredLive =
    quote?.staleLive != null
      ? quote.staleLive === false
      : quote?.stale !== true && quote?.freshAgeMs != null
        ? quote.freshAgeMs <= QUOTE_PROVENANCE_STALE_MS
        : quote?.stale !== true;

  if (!declaredLive) {
    const held = source && source.includes("held") ? SOURCE_LABELS[source] : "HELD";
    return {
      label: held === "HELD" ? `HELD ${ageText}` : `${held} ${ageText}`,
      title: `No live tick for ${ageText} — held print, not a current market price`,
      tone: "held",
    };
  }

  if (!source) {
    return {
      label: "UNKNOWN SRC",
      title: "Quote predates provenance tracking — origin unverified",
      tone: "unknown",
    };
  }

  // STANDALONE SaaS MODE provenance — a labeled fallback tape, never disguised.
  if (source.startsWith("standalone:") || source === "standalone_synthetic") {
    const synthetic = source === "standalone_synthetic";
    const tier = source.startsWith("standalone:")
      ? source.slice("standalone:".length)
      : null;
    return {
      label: synthetic ? "SIMULATED" : "STANDALONE",
      title: synthetic
        ? "Standalone mode — labeled synthetic OTC price (no public source; not a real market print)"
        : `Standalone mode — real public proxy price (${tier})`,
      tone: "fallback",
    };
  }

  const isPo = source.startsWith("pocket_option");
  const label = SOURCE_LABELS[source] ?? source.toUpperCase();
  const title = SOURCE_TITLES[source] ?? `Source: ${source}`;

  return {
    label: isPo && label === "PO LIVE" ? "PO LIVE" : label,
    title,
    tone: isPo ? "live" : "fallback",
  };
}
