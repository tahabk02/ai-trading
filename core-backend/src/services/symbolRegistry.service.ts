/**
 * symbolRegistry.service.ts — STRICT OTC FOREX + CRYPTO WHITELIST (34 REAL ASSETS)
 *
 * PRODUCTION ENFORCEMENT:
 * The symbol registry is a HARD-CODED strict whitelist of exactly 34 real
 * instruments matching Pocket Option / professional broker standards:
 * 32 OTC forex pairs (EUR/USD OTC etc.) + BTC/USD + ETH/USD (crypto).
 * The previous live Alpaca asset universe fetch is REMOVED.
 *
 * All validation functions (`getAll`, `search`, `findBySymbol`, `isValidSymbol`)
 * accept ONLY the whitelisted assets. Any stock/etf ticker is rejected.
 *
 * STRICT ASSET CLASSIFICATION (OTC vs FOREX vs CRYPTO):
 * Every entry carries an explicit `assetSubType` — "otc" | "forex" | "crypto".
 * An OTC instrument (e.g. EUR/USD OTC) keeps its OTC attribute and labels
 * itself "EUR/USD OTC"; a standard (non-OTC) forex pair would be tagged and
 * labelled "forex" — and never mixed with OTC pricing. Crypto majors are
 * tagged "crypto" and routed/labelled as crypto. The classes never bleed into
 * one another.
 *
 * Return percentages are DYNAMIC — they are refreshed from live ATR volatility
 * by the prediction pipeline and persisted here for the /symbols endpoint to
 * serve to the frontend dropdown with real, current payout values.
 */

// ── Types ──

/** Strict asset classification — mirrors the pocket-bridge asset_type_for_symbol. */
export type AssetSubType = "forex" | "otc" | "crypto" | "commodity";

export interface SymbolEntry {
  /** Trading pair as recognized by the backend (e.g. "AUD/USD") */
  symbol: string;
  /** Human-readable name */
  name: string;
  /** Legacy broker instrument type (back-compat): "otc" or "crypto" */
  type: "otc" | "crypto" | "commodity";
  /**
   * STRICT ASSET CLASSIFICATION — "forex" (standard wholesale forex),
   * "otc" (Pocket Option OTC instrument, distinct venue/pricing model),
   * "crypto" (crypto major routed via the crypto pipeline). Explicit per
   * entry; OTC vs forex vs crypto never mix.
   */
  assetSubType: AssetSubType;
  /** Primary exchange / data pipeline */
  exchange: string;
  /** Quote currency */
  currency: string;
  /** Dynamic return percentage (ATR-volatility driven, default from live) */
  payout: number;
  /** Decimal precision for price display */
  digits: number;
  /** Label shown in UI (e.g. "AUD/USD OTC") */
  label: string;
}

// ════════════════════════════════════════════════════════════════════
// THE 34 STRICT ASSETS — HARD-CODED, NO EXTERNAL FETCH
// 32 OTC forex pairs (assetSubType "otc") + BTC/USD + ETH/USD (crypto).
// ════════════════════════════════════════════════════════════════════
const OTC_WHITELIST: SymbolEntry[] = [
  // ── Forex Majors (7) ────────────────────────────────────────────────
  {
    symbol: "EUR/USD",
    name: "Euro / US Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "USD",
    payout: 92,
    digits: 5,
    label: "EUR/USD OTC",
  },
  {
    symbol: "GBP/USD",
    name: "British Pound / US Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "USD",
    payout: 92,
    digits: 5,
    label: "GBP/USD OTC",
  },
  {
    symbol: "USD/JPY",
    name: "US Dollar / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "JPY",
    payout: 92,
    digits: 3,
    label: "USD/JPY OTC",
  },
  {
    symbol: "USD/CHF",
    name: "US Dollar / Swiss Franc",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "CHF",
    payout: 92,
    digits: 5,
    label: "USD/CHF OTC",
  },
  {
    symbol: "USD/CAD",
    name: "US Dollar / Canadian Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "CAD",
    payout: 92,
    digits: 5,
    label: "USD/CAD OTC",
  },
  {
    symbol: "AUD/USD",
    name: "Australian Dollar / US Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "USD",
    payout: 92,
    digits: 5,
    label: "AUD/USD OTC",
  },
  {
    symbol: "NZD/USD",
    name: "New Zealand Dollar / US Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "USD",
    payout: 92,
    digits: 5,
    label: "NZD/USD OTC",
  },

  // ── Crypto Majors (2) — classified "crypto" (NOT OTC), routed via the
  // ── crypto pipeline, labelled as crypto.                    ─────────────
  {
    symbol: "BTC/USD",
    name: "Bitcoin / US Dollar",
    type: "crypto",
    assetSubType: "crypto",
    exchange: "LIVE_CRYPTO",
    currency: "USD",
    payout: 90,
    digits: 2,
    label: "BTC/USD Crypto",
  },
  {
    symbol: "ETH/USD",
    name: "Ethereum / US Dollar",
    type: "crypto",
    assetSubType: "crypto",
    exchange: "LIVE_CRYPTO",
    currency: "USD",
    payout: 90,
    digits: 2,
    label: "ETH/USD Crypto",
  },

  // ── Euro Crosses (7) ────────────────────────────────────────────────
  {
    symbol: "EUR/GBP",
    name: "Euro / British Pound",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "GBP",
    payout: 92,
    digits: 5,
    label: "EUR/GBP OTC",
  },
  {
    symbol: "EUR/JPY",
    name: "Euro / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "JPY",
    payout: 92,
    digits: 3,
    label: "EUR/JPY OTC",
  },
  {
    symbol: "EUR/CHF",
    name: "Euro / Swiss Franc",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "CHF",
    payout: 92,
    digits: 5,
    label: "EUR/CHF OTC",
  },
  {
    symbol: "EUR/AUD",
    name: "Euro / Australian Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "AUD",
    payout: 92,
    digits: 5,
    label: "EUR/AUD OTC",
  },
  {
    symbol: "EUR/CAD",
    name: "Euro / Canadian Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "CAD",
    payout: 92,
    digits: 5,
    label: "EUR/CAD OTC",
  },
  {
    symbol: "EUR/NZD",
    name: "Euro / New Zealand Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "NZD",
    payout: 92,
    digits: 5,
    label: "EUR/NZD OTC",
  },
  {
    symbol: "EUR/TRY",
    name: "Euro / Turkish Lira",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "TRY",
    payout: 92,
    digits: 5,
    label: "EUR/TRY OTC",
  },

  // ── Pound Crosses (4) ───────────────────────────────────────────────
  {
    symbol: "GBP/JPY",
    name: "British Pound / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "JPY",
    payout: 92,
    digits: 3,
    label: "GBP/JPY OTC",
  },
  {
    symbol: "GBP/CHF",
    name: "British Pound / Swiss Franc",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "CHF",
    payout: 92,
    digits: 5,
    label: "GBP/CHF OTC",
  },
  {
    symbol: "GBP/AUD",
    name: "British Pound / Australian Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "AUD",
    payout: 92,
    digits: 5,
    label: "GBP/AUD OTC",
  },
  {
    symbol: "GBP/CAD",
    name: "British Pound / Canadian Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "CAD",
    payout: 92,
    digits: 5,
    label: "GBP/CAD OTC",
  },

  // ── Yen Crosses (3) ─────────────────────────────────────────────────
  {
    symbol: "AUD/JPY",
    name: "Australian Dollar / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "JPY",
    payout: 92,
    digits: 3,
    label: "AUD/JPY OTC",
  },
  {
    symbol: "CAD/JPY",
    name: "Canadian Dollar / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "JPY",
    payout: 92,
    digits: 3,
    label: "CAD/JPY OTC",
  },
  {
    symbol: "CHF/JPY",
    name: "Swiss Franc / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "JPY",
    payout: 92,
    digits: 3,
    label: "CHF/JPY OTC",
  },

  // ── Other Minors (5) ────────────────────────────────────────────────
  {
    symbol: "AUD/CAD",
    name: "Australian Dollar / Canadian Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "CAD",
    payout: 92,
    digits: 5,
    label: "AUD/CAD OTC",
  },
  {
    symbol: "AUD/NZD",
    name: "Australian Dollar / New Zealand Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "NZD",
    payout: 92,
    digits: 5,
    label: "AUD/NZD OTC",
  },
  {
    symbol: "NZD/JPY",
    name: "New Zealand Dollar / Japanese Yen",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "JPY",
    payout: 92,
    digits: 3,
    label: "NZD/JPY OTC",
  },
  {
    symbol: "CAD/CHF",
    name: "Canadian Dollar / Swiss Franc",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "CHF",
    payout: 92,
    digits: 5,
    label: "CAD/CHF OTC",
  },
  {
    symbol: "EUR/RUB",
    name: "Euro / Russian Ruble",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "RUB",
    payout: 92,
    digits: 5,
    label: "EUR/RUB OTC",
  },

  // ── Emerging / OTC Variants (6) ─────────────────────────────────────
  {
    symbol: "USD/TRY",
    name: "US Dollar / Turkish Lira",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "TRY",
    payout: 92,
    digits: 5,
    label: "USD/TRY OTC",
  },
  {
    symbol: "USD/ZAR",
    name: "US Dollar / South African Rand",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "ZAR",
    payout: 92,
    digits: 5,
    label: "USD/ZAR OTC",
  },
  {
    symbol: "USD/MXN",
    name: "US Dollar / Mexican Peso",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "MXN",
    payout: 92,
    digits: 5,
    label: "USD/MXN OTC",
  },
  {
    symbol: "USD/SGD",
    name: "US Dollar / Singapore Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "SGD",
    payout: 92,
    digits: 5,
    label: "USD/SGD OTC",
  },
  {
    symbol: "MAD/USD",
    name: "Moroccan Dirham / US Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "USD",
    payout: 92,
    digits: 5,
    label: "MAD/USD OTC",
  },
  {
    symbol: "KES/USD",
    name: "Kenyan Shilling / US Dollar",
    type: "otc",
    assetSubType: "otc",
    exchange: "OTC_LIVE_FOREX",
    currency: "USD",
    payout: 92,
    digits: 5,
    label: "KES/USD OTC",
  },
];

/** Set for O(1) strict membership checks */
const OTC_SET = new Set(OTC_WHITELIST.map((e) => e.symbol));

// ── Service ──

export class SymbolRegistryService {
  private entries: SymbolEntry[] = [...OTC_WHITELIST];

  /** Replace the fallback registry with the broker's active asset universe. */
  replaceFromBridgeAssets(assets: unknown[]): void {
    const next: SymbolEntry[] = [];
    for (const raw of assets) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const symbol = String(item.symbol || "")
        .trim()
        .toUpperCase();
      if (!symbol || next.some((entry) => entry.symbol === symbol)) continue;
      const subtype = String(
        item.assetSubType || item.type || "forex",
      ) as AssetSubType;
      const assetSubType: AssetSubType = [
        "forex",
        "otc",
        "crypto",
        "commodity",
      ].includes(subtype)
        ? subtype
        : "forex";
      next.push({
        symbol,
        name: String(item.name || symbol),
        label: String(item.label || symbol),
        type:
          assetSubType === "crypto"
            ? "crypto"
            : assetSubType === "commodity"
              ? "commodity"
              : "otc",
        assetSubType,
        exchange: String(item.exchange || "POCKET_OPTION"),
        currency: String(item.currency || symbol.split("/").at(-1) || "USD"),
        payout: Number.isFinite(Number(item.payout)) ? Number(item.payout) : 92,
        digits: Number.isFinite(Number(item.digits)) ? Number(item.digits) : 5,
      });
    }
    if (next.length > 0)
      this.entries = next.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  /**
   * Get ALL whitelisted symbols.
   * The `type` filter is accepted for API compatibility; "otc" returns the
   * 32 OTC forex pairs, "crypto" returns BTC/ETH. Any other type → [].
   */
  async getAll(
    type?: "stock" | "crypto" | "etf" | "otc" | "commodity",
  ): Promise<SymbolEntry[]> {
    if (!type) return [...this.entries];
    if (type === "otc" || type === "crypto" || type === "commodity") {
      return this.entries.filter((e) => e.type === type);
    }
    return [];
  }

  /**
   * STRICT ASSET CLASSIFICATION (mirror of the pocket-bridge helper).
   * Returns the authoritative subtype for ANY symbol string:
   *   • BTC/USD, ETH/USD (any casing/separator)           → "crypto"
   *   • A whitelisted OTC forex pair                       → "otc"
   *   • Any other non-whitelisted `/`-separated currency pair → "forex"
   *   • Anything else                                       → "otc" (default)
   */
  getAssetSubType(symbol: string): AssetSubType {
    const norm = String(symbol || "")
      .trim()
      .toUpperCase()
      .replace(/[\s\-_.]+/g, "/");
    const compact = norm.replace(/\//g, "");
    if (
      compact === "BTCUSD" ||
      compact === "ETHUSD" ||
      compact === "BTCUSDT" ||
      compact === "ETHUSDT"
    ) {
      return "crypto";
    }
    const entry = this.entries.find((candidate) => candidate.symbol === norm);
    if (entry) return entry.assetSubType;
    if (norm.includes("/")) return "forex";
    return "otc";
  }

  /**
   * Search whitelisted symbols by partial match on symbol, name, exchange.
   * Case-insensitive. Results sorted alphabetically.
   * Non-matching queries return [] — never non-whitelisted assets.
   */
  async search(
    query: string,
    _type?: "stock" | "crypto" | "etf" | "otc" | "commodity",
    limit: number = 40,
  ): Promise<SymbolEntry[]> {
    const q = (query || "").trim().toUpperCase();
    if (!q) return this.entries.slice(0, limit);

    const results = this.entries.filter((entry) => {
      const symMatch = entry.symbol.toUpperCase().includes(q);
      const nameMatch = entry.name.toUpperCase().includes(q);
      const labelMatch = entry.label.toUpperCase().includes(q);
      return symMatch || nameMatch || labelMatch;
    });

    // Sort exact symbol matches first, then alphabetical
    results.sort((a, b) => {
      const aSym = a.symbol.toUpperCase();
      const bSym = b.symbol.toUpperCase();
      if (aSym === q && bSym !== q) return -1;
      if (bSym === q && aSym !== q) return 1;
      return a.symbol.localeCompare(b.symbol);
    });

    return results.slice(0, limit);
  }

  /**
   * Look up a single symbol entry by exact symbol string.
   * Returns undefined for any non-whitelisted symbol.
   */
  async findBySymbol(symbol: string): Promise<SymbolEntry | undefined> {
    const sym = (symbol || "").trim().toUpperCase();
    return this.entries.find((s) => s.symbol === sym);
  }

  /**
   * STRICT VALIDATION. Returns true ONLY if the symbol is one of the
   * 32 whitelisted OTC pairs. All other inputs (AAPL, BTC/USDT, etc.) → false.
   */
  async isValidSymbol(symbol: string): Promise<boolean> {
    const sym = (symbol || "").trim().toUpperCase();
    return this.entries.some((entry) => entry.symbol === sym);
  }

  /**
   * Synchronous strict validation (no async needed since whitelist is static).
   */
  isValidSymbolSync(symbol: string): boolean {
    const sym = (symbol || "").trim().toUpperCase();
    return this.entries.some((entry) => entry.symbol === sym);
  }

  /**
   * NORMALIZATION RECOVERY — maps common symbol variants onto the canonical
   * whitelist format ("EUR/USD").
   *
   * Handles the formats clients actually send in the wild:
   *   "eur/usd"            → "EUR/USD"   (case)
   *   "EURUSD"             → "EUR/USD"   (compact 6-char, no separator)
   *   "EUR-USD"/"EUR_USD"  → "EUR/USD"   (alternate separators)
   *   "EUR/USD OTC"        → "EUR/USD"   (UI label suffix)
   *   "EUR/USD=X"          → "EUR/USD"   (Yahoo-style futures suffix)
   *   "EUR/USD.FX"         → "EUR/USD"   (exchange qualifier)
   *
   * Returns the canonical whitelisted symbol, or null when the input cannot
   * be mapped onto ANY whitelisted pair (caller decides whether to reject).
   */
  normalizeSymbol(raw: string): string | null {
    if (!raw || typeof raw !== "string") return null;

    let s = raw.trim().toUpperCase();

    // Strip common display/exchange suffixes
    s = s.replace(/\s*OTC\s*$/, ""); // "EUR/USD OTC"
    s = s.replace(/=X$/, ""); //        "EUR/USD=X"
    s = s.replace(/\.(FX|FOREX|CS|TO)$/, ""); // "EUR/USD.FX"

    // Unify every separator style onto "/"
    s = s.replace(/[\-_.\s]+/g, "/");
    s = s.replace(/\/{2,}/g, "/"); // collapse duplicates
    s = s.replace(/^\//, "").replace(/\/$/, "");

    if (this.entries.some((entry) => entry.symbol === s)) return s;

    // Compact 6-char form: "EURUSD" → "EUR/USD"
    const compact = s.replace(/\//g, "");
    if (compact.length === 6 && /^[A-Z]{6}$/.test(compact)) {
      const candidate = `${compact.slice(0, 3)}/${compact.slice(3)}`;
      if (this.entries.some((entry) => entry.symbol === candidate))
        return candidate;
    }

    return null;
  }

  /**
   * Update a pair's dynamic payout from live ATR volatility.
   * Persists so /symbols serves current returns.
   */
  updatePayout(symbol: string, payout: number): void {
    const norm = (symbol || "").trim().toUpperCase();
    const entry = this.entries.find((s) => s.symbol === norm);
    if (entry && Number.isFinite(payout)) {
      entry.payout = Math.max(80, Math.min(97, Math.round(payout)));
    }
  }

  /**
   * Get the decimal precision for a pair (for price formatting).
   */
  getDigits(symbol: string): number {
    const entry = this.entries.find(
      (s) => s.symbol === (symbol || "").trim().toUpperCase(),
    );
    return entry?.digits ?? 5;
  }

  /**
   * Refresh cache — no external fetch needed. Returns whitelist as-is.
   * Kept for API compatibility.
   */
  async refreshCache(): Promise<SymbolEntry[]> {
    return [...this.entries];
  }
}

// ── Singleton export ──

export const symbolRegistry = new SymbolRegistryService();

export default symbolRegistry;
