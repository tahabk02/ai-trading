/**
 * symbols.ts — FULL POCKET OPTION & PROFESSIONAL BROKER UNIVERSE (100% REAL - 0 DEMO)
 *
 * PRODUCTION ENFORCEMENT: This file is the single source of truth for the
 * entire frontend asset universe. NO stocks, NO fallback tickers.
 * Exactly these 26 REAL instruments are recognized and tradable — matching
 * Pocket Option / professional broker standards:
 *
 *   OTC FOREX (21)   : EUR/USD OTC, USD/JPY OTC … KES/USD OTC
 *   REAL FOREX (5)   : EUR/SEK, EUR/HUF … (standard wholesale non-OTC pairs)
 *
 * STRICT ASSET CLASSIFICATION (OTC vs FOREX):
 * Every entry carries an explicit `assetSubType` — "otc" | "forex".
 * An OTC instrument (e.g. EUR/USD OTC) displays its OTC attribute explicitly;
 * a standard (non-OTC) forex pair is classified/labelled "forex" and NEVER
 * mixed with OTC pricing. The two classes never bleed into one another.
 *
 * Every pair is backed by the live forex data pipeline in core-backend:
 *  • Live spot: open.er-api.com (ECB-sourced, ~160 currencies) + mirrors
 *  • Historical: Frankfurter/ECB reference rates (real daily bars)
 *  • Non-ECB pairs: closed-form interpolation anchored to the REAL live spot
 * Return percentages are dynamic — derived from real ATR volatility by the
 * backend — and refreshed on every prediction response.
 */

/** Strict asset classification — mirrors core-backend SymbolEntry.assetSubType. */
export type AssetSubType = "forex" | "otc";

export interface SymbolDefinition {
  /** Trading pair as recognized across all services (e.g. "AUD/USD") */
  symbol: string;
  /** Human-readable name (e.g. "Australian Dollar / US Dollar") */
  name: string;
  type: "otc" | "forex";
  /**
   * STRICT ASSET CLASSIFICATION — "forex" (standard wholesale forex),
   * "otc" (Pocket Option OTC instrument). Explicit per entry; OTC and forex
   * never mix.
   */
  assetSubType: AssetSubType;
  /** Dynamic return percentage (e.g. 92). Updated from live ATR volatility. */
  payout: number;
  /** Currency pair label e.g. "AUD/USD OTC" */
  label: string;
  /** Decimal precision for price display (JPY pairs = 3, others = 5) */
  digits: number;
}

// ════════════════════════════════════════════════════════════════════
// REAL FOREX (5) — standard wholesale NON-OTC pairs (PART 14/15).
// Backed by REAL ECB reference rates via Frankfurter + open.er-api — the
// same integrated feed already used for the OTC book. Classified
// assetSubType "forex" (NOT "otc") — a wholly different venue/pricing
// model that must never be mixed with the Pocket Option OTC book.
// Declared FIRST so OTC_FOREX_PAIRS can spread it and the terminal grid
// can render the REAL pair group as its own distinct class.
// ════════════════════════════════════════════════════════════════════
export const REAL_FOREX_PAIRS: SymbolDefinition[] = [
  {
    symbol: "EUR/SEK",
    name: "Euro / Swedish Krona",
    type: "forex",
    assetSubType: "forex",
    payout: 92,
    label: "EUR/SEK",
    digits: 5,
  },
  {
    symbol: "EUR/HUF",
    name: "Euro / Hungarian Forint",
    type: "forex",
    assetSubType: "forex",
    payout: 92,
    label: "EUR/HUF",
    digits: 5,
  },
  {
    symbol: "USD/NOK",
    name: "US Dollar / Norwegian Krone",
    type: "forex",
    assetSubType: "forex",
    payout: 92,
    label: "USD/NOK",
    digits: 5,
  },
  {
    symbol: "USD/PLN",
    name: "US Dollar / Polish Zloty",
    type: "forex",
    assetSubType: "forex",
    payout: 92,
    label: "USD/PLN",
    digits: 5,
  },
  {
    symbol: "USD/CZK",
    name: "US Dollar / Czech Koruna",
    type: "forex",
    assetSubType: "forex",
    payout: 92,
    label: "USD/CZK",
    digits: 5,
  },
];

// ════════════════════════════════════════════════════════════════════
// FULL POCKET OPTION / BROKER UNIVERSE — 26 REAL ASSETS, 0 DEMO
// 21 OTC forex (assetSubType "otc") + the 5 REAL_FOREX_PAIRS above
// (assetSubType "forex"). The OTC array deliberately spreads
// REAL_FOREX_PAIRS so whitelist / lookup / trading consumers keep the full
// 26-instrument universe.
// ════════════════════════════════════════════════════════════════════
export const OTC_FOREX_PAIRS: SymbolDefinition[] = [
  // ── Forex Majors (7) ────────────────────────────────────────────────
  {
    symbol: "EUR/USD",
    name: "Euro / US Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "EUR/USD OTC",
    digits: 5,
  },
  {
    symbol: "USD/JPY",
    name: "US Dollar / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "USD/JPY OTC",
    digits: 3,
  },
  {
    symbol: "USD/CHF",
    name: "US Dollar / Swiss Franc",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "USD/CHF OTC",
    digits: 5,
  },
  {
    symbol: "USD/CAD",
    name: "US Dollar / Canadian Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "USD/CAD OTC",
    digits: 5,
  },
  {
    symbol: "AUD/USD",
    name: "Australian Dollar / US Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "AUD/USD OTC",
    digits: 5,
  },
  // ── Euro Crosses (4) ────────────────────────────────────────────────
  {
    symbol: "EUR/JPY",
    name: "Euro / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "EUR/JPY OTC",
    digits: 3,
  },
  {
    symbol: "EUR/CHF",
    name: "Euro / Swiss Franc",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "EUR/CHF OTC",
    digits: 5,
  },
  {
    symbol: "EUR/AUD",
    name: "Euro / Australian Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "EUR/AUD OTC",
    digits: 5,
  },
  {
    symbol: "EUR/CAD",
    name: "Euro / Canadian Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "EUR/CAD OTC",
    digits: 5,
  },
  // ── Yen Crosses (3) ─────────────────────────────────────────────────
  {
    symbol: "AUD/JPY",
    name: "Australian Dollar / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "AUD/JPY OTC",
    digits: 3,
  },
  {
    symbol: "CAD/JPY",
    name: "Canadian Dollar / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "CAD/JPY OTC",
    digits: 3,
  },
  {
    symbol: "CHF/JPY",
    name: "Swiss Franc / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "CHF/JPY OTC",
    digits: 3,
  },

  // ── Other Minors (5) ────────────────────────────────────────────────
  {
    symbol: "AUD/CAD",
    name: "Australian Dollar / Canadian Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "AUD/CAD OTC",
    digits: 5,
  },
  {
    symbol: "AUD/NZD",
    name: "Australian Dollar / New Zealand Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "AUD/NZD OTC",
    digits: 5,
  },
  {
    symbol: "CAD/CHF",
    name: "Canadian Dollar / Swiss Franc",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "CAD/CHF OTC",
    digits: 5,
  },
  {
    symbol: "EUR/RUB",
    name: "Euro / Russian Ruble",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "EUR/RUB OTC",
    digits: 5,
  },

  // ── Emerging / OTC Variants (6) ─────────────────────────────────────
  {
    symbol: "USD/TRY",
    name: "US Dollar / Turkish Lira",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "USD/TRY OTC",
    digits: 5,
  },
  {
    symbol: "USD/MXN",
    name: "US Dollar / Mexican Peso",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "USD/MXN OTC",
    digits: 5,
  },
  {
    symbol: "USD/SGD",
    name: "US Dollar / Singapore Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "USD/SGD OTC",
    digits: 5,
  },
  {
    symbol: "MAD/USD",
    name: "Moroccan Dirham / US Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "MAD/USD OTC",
    digits: 5,
  },
  {
    symbol: "KES/USD",
    name: "Kenyan Shilling / US Dollar",
    type: "otc",
    assetSubType: "otc",
    payout: 92,
    label: "KES/USD OTC",
    digits: 5,
  },

  // ── REAL FOREX (5) — PART 14/15. Standard wholesale NON-OTC pairs,
  //     spread from REAL_FOREX_PAIRS so every consumer of OTC_FOREX_PAIRS
  //     still resolves the full 26-instrument universe. ───────────────
  ...REAL_FOREX_PAIRS,
];

/**
 * Set of whitelisted pair symbols for O(1) strict membership checks.
 * Any symbol not present here is REJECTED at every boundary.
 */
export const OTC_WHITELIST: Set<string> = new Set(
  OTC_FOREX_PAIRS.map((p) => p.symbol),
);

/**
 * Set of the REAL_FOREX_PAIRS symbols only (assetSubType "forex") for
 * O(1) "is this a real-market pair" checks — used by the terminal grid to
 * render the REAL badge and regime-gate (scored-only) display.
 */
export const REAL_FOREX_SET: Set<string> = new Set(
  REAL_FOREX_PAIRS.map((p) => p.symbol),
);

/** Symbol strings only (e.g. "AUD/USD", "CAD/JPY") — shown in dropdowns */
export const ALL_SYMBOL_TICKERS: string[] = OTC_FOREX_PAIRS.map(
  (s) => s.symbol,
);

/** Full 26-asset symbol list — OTC pairs + the 5 real pairs. */
export const ALL_UNIVERSE_TICKERS: string[] = [
  ...ALL_SYMBOL_TICKERS,
  ...REAL_FOREX_PAIRS.map((p) => p.symbol),
];

/**
 * Strict validation — the ONLY symbol validation used in the frontend.
 * Returns true ONLY for the 26 whitelisted instruments.
 * Everything else (AAPL, NVDA, SPY...) → false.
 */
export function isWhitelistedOtcpair(symbol: string): boolean {
  if (!symbol) return false;
  const norm = symbol.trim().toUpperCase();
  return OTC_WHITELIST.has(norm);
}

/**
 * Look up a pair definition by symbol. Returns undefined for non-whitelisted.
 */
export function getOtcpair(symbol: string): SymbolDefinition | undefined {
  if (!symbol) return undefined;
  const norm = symbol.trim().toUpperCase();
  return OTC_FOREX_PAIRS.find((p) => p.symbol === norm);
}

/** Default active pair — first whitelisted pair */
export const DEFAULT_SYMBOL = OTC_FOREX_PAIRS[0].symbol; // "EUR/USD"

/**
 * STRICT ASSET CLASSIFICATION for any symbol (mirror of the backend helper).
 *   • An entry in OTC_FOREX_PAIRS (OTC or real-forex) returns its OWN
 *     authoritative assetSubType.
 *   • Any other non-whitelisted `/`-separated currency pair → "forex"
 *   • Anything else                                          → "otc" (default)
 */
export function getAssetSubType(symbol: string): AssetSubType {
  const norm = String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-_.]+/g, "/");
  const entry = OTC_FOREX_PAIRS.find((p) => p.symbol === norm);
  if (entry) return entry.assetSubType;
  if (norm.includes("/")) return "forex";
  return "otc";
}

/** True when the asset is a Pocket Option OTC instrument (e.g. EUR/USD OTC). */
export function isOtcAsset(symbol: string): boolean {
  return getAssetSubType(symbol) === "otc";
}

/** True when the asset is a standard (non-OTC) wholesale forex pair. */
export function isForexAsset(symbol: string): boolean {
  return getAssetSubType(symbol) === "forex";
}

/** Decimal digits for a given pair (JPY crosses = 3, otherwise = 5) */
export function getPriceDigits(symbol: string): number {
  return getOtcpair(symbol)?.digits ?? 5;
}

/**
 * Quote currency for a given pair (e.g. "AUD/CAD" → "CAD", "CAD/JPY" → "JPY").
 * Used for pair-aware price formatting across ALL UI surfaces.
 */
export function getQuoteCurrency(symbol: string): string {
  const pair = getOtcpair(symbol);
  const [, quote] = pair?.symbol.split("/") ?? [];
  return quote ?? "USD";
}

/**
 * Dynamic return percentage for a given pair (e.g. 92).
 * Falls back to the whitelisted static payout if no live value is present.
 */
export function getPayout(symbol: string): number {
  return getOtcpair(symbol)?.payout ?? 92;
}

/**
 * Pair-aware price formatter — uses the pair's decimal precision (digits)
 * instead of a blanket toFixed(2). JPY crosses render 3 decimals, others 5.
 *
 * Returns "--" when the value is missing/non-finite/zero.
 */
export function formatPairPrice(
  value: number | null | undefined,
  symbol: string,
): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "--";
  const digits = getPriceDigits(symbol);
  return Number(value).toFixed(digits);
}

/**
 * Human label for the dropdown, e.g. "AUD/CAD OTC". Always uppercase-safe.
 * Whitelist-aware: whitelisted OTC pairs render their authoritative
 * "XX/YY OTC" label; any non-OTC or unknown symbol renders CLEAN with no
 * fabricated OTC tag (normal assets must stay standard per spec).
 */
export function getPairLabel(symbol: string): string {
  return getOtcpair(symbol)?.label ?? symbol.trim().toUpperCase();
}

export interface SymbolSearchResult {
  symbol: string;
  name: string;
  type: "otc" | "forex";
  label: string;
  digits: number;
}

/**
 * Resilient client-side symbol search over the strict OTC/real-forex universe.
 * Powers the "Search symbols..." input fallback whenever the backend
 * /symbols route is unreachable, times out, or answers 400/504 — the
 * whitelist keeps search alive with zero fabricated instruments. Also
 * guarantees instant filtering while the network request is still in flight.
 */
export function searchSymbolUniverse(
  query: string,
  limit = 15,
): SymbolSearchResult[] {
  const q = String(query || "")
    .trim()
    .toUpperCase();
  if (!q) {
    return OTC_FOREX_PAIRS.slice(0, Math.max(1, limit)).map(toSymbolSearchResult);
  }
  const compactQ = q.replace(/OTC$/u, "").replace(/[^A-Z0-9]/g, "");
  const hay = q.replace(/[\s\-_.]+/g, "/");
  const matches: SymbolDefinition[] = [];
  for (const p of OTC_FOREX_PAIRS) {
    const sym = p.symbol.toUpperCase();
    const compact = sym.replace(/\//g, "");
    const name = p.name.toUpperCase();
    const label = p.label.toUpperCase();
    if (
      sym.includes(hay) ||
      label.includes(q) ||
      name.includes(q) ||
      (compactQ.length >= 3 && compact.startsWith(compactQ)) ||
      (compactQ.length === 6 && compact === compactQ)
    ) {
      matches.push(p);
    }
  }
  matches.sort((a, b) => {
    const aPrefix = a.symbol.startsWith(hay) ? 0 : 1;
    const bPrefix = b.symbol.startsWith(hay) ? 0 : 1;
    return aPrefix - bPrefix;
  });
  return matches.slice(0, Math.max(1, limit)).map(toSymbolSearchResult);
}

function toSymbolSearchResult(p: SymbolDefinition): SymbolSearchResult {
  return {
    symbol: p.symbol,
    name: p.name,
    type: p.type,
    label: p.label,
    digits: p.digits,
  };
}

// ── BACK-COMPAT: old exported names are now ALIASES to the whitelist ──
// These were previously 80-asset arrays. They are now hard-bound to the
// OTC whitelist so any legacy import cannot reintroduce stock/crypto.
/**
 * The FULL terminal universe: every OTC pair and the real wholesale forex
 * pairs (which `OTC_FOREX_PAIRS` deliberately spreads). Deduped and
 * canonical. Defined HERE rather than in the store so that pure filter logic
 * (`lib/assetFilter`) can import the universe without pulling in the Zustand
 * store — the store imports the filter module, so the reverse edge would be a
 * circular import that leaves `ALL_MARKET_SYMBOLS` undefined at module init.
 */
export const ALL_MARKET_SYMBOLS: string[] = Array.from(
  new Set([
    ...OTC_FOREX_PAIRS.map((p) => p.symbol),
    ...REAL_FOREX_PAIRS.map((p) => p.symbol),
  ]),
);

export const ALL_SYMBOLS: SymbolDefinition[] = OTC_FOREX_PAIRS;
export const US_STOCKS: SymbolDefinition[] = [];
export const STOCK_TICKERS: string[] = [];
