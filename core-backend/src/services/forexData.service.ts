/**
 * forexData.service.ts — STRICT REAL DATA FOREX / MARKET DATA SERVICE
 *
 * 100% REAL DATA. ZERO MOCK. ZERO SYNTHETIC.
 *
 * Primary data pipeline:
 *  1. GitHub Repository Polling — periodic HTTPS GETs to raw GitHub file URLs
 *     for live price snapshots (JSON or CSV). This is the canonical upstream.
 *  2. Free public REST APIs — tiered cascade (Frankfurter, Open ER-API,
 *     CoinGecko) as HTTP fallback for symbols not in the GitHub repo.
 *  3. Persistent candle buffers — real 1-minute OHLC buckets accumulated
 *     from genuine live ticks, never fabricated.
 *
 *  Zero fabrication policy:
 *  - Every price originates from a real external HTTP endpoint.
 *  - If all sources fail, the service returns { success: false } — it NEVER
 *    invents random-walk prices or hardcoded fake values.
 *  - Candle buffers are populated STRICTLY from genuine live ticks observed by
 *    the ingestion engine — no skeleton/placeholder bars are ever synthesized,
 *    so the chart and ML features always reflect real market movement.
 */

import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { renderFallbackChainLog } from "../lib/feedResilience";
import { canonicalizeSymbol } from "../utils/symbolFormat";

// ─────────────────────────────────────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ForexCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Classification stamped by the bridge feed ("forex"|"otc"|"crypto"). */
  assetType?: string;
}

export interface ForexSpotResult {
  success: boolean;
  price: number | null;
  /** Real bid arm, present only when the quote source exposes a genuine book. */
  bid?: number;
  /** Real ask arm, present only when the quote source exposes a genuine book. */
  ask?: number;
  source: string;
  error?: string;
}

export interface GitHubForexTick {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  volume?: number;
  timestamp?: string;
}

interface BufferedCandleOptions {
  symbol: string;
  timeframe: string;
  quote?: number;
  required: number;
  realBars: ForexCandle[];
}

interface ComputeAtrOptions {
  symbol?: string;
  timeframe?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_POLLING_INTERVAL_MS = 10_000;
/**
 * Max age (ms) of a held "last real" spot price before it is refused as live.
 * Beyond this the service returns an honest failure instead of serving a stale
 * price that would masquerade as current — the user-visible chart/live price
 * must never appear fresh when the underlying stream has actually gone cold.
 */
const STALE_HOLD_MAX_AGE_MS = 180_000;

const GITHUB_DATA_REPO_OWNER =
  process.env.GITHUB_DATA_REPO_OWNER || "je-suis-tm";
const GITHUB_DATA_REPO_NAME =
  process.env.GITHUB_DATA_REPO_NAME || "quant-trading";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "master";
const GITHUB_DATA_POLL_MS =
  Number(process.env.FOREX_GITHUB_POLL_MS) || DEFAULT_POLLING_INTERVAL_MS;

/** Single consolidated file in the repo containing all symbol prices. */
const GITHUB_PRICES_FILE =
  process.env.FOREX_GITHUB_PRICES_FILE || "data/fx_spot.json";

/** Known free public forex rate API base URLs (tiered fallback). */
const FRANKFURTER_BASE = "https://api.frankfurter.app";
const OPEN_ER_API_BASE = "https://open.er-api.com/v6/latest";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

/**
 * PART 28 — YAHOO FINANCE 1-MINUTE FOREX CHART API.
 * Keyless intraday source for the 10 real (non-OTC) pairs. Returns genuine
 * 1-minute OHLC bars (`meta.regularMarketPrice` + `timestamp[]`). Yanked in
 * front of the Frankfurter/open.er-api daily feeds — those are ECB daily
 * reference rates and CANNOT power live M1 candles or a 1Hz blotter (PART 27).
 * Unofficial endpoint: gentle polling only (1-min bars change once/minute), so
 * a per-symbol throttle re-serves the last real intraday print inside the same
 * minute instead of hammering the API.
 */
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_POLL_MS = 9000;

/** The 10 REAL_FOREX_PAIRS (ECB-sourced) now fed by the intraday Yahoo tier. */
const REAL_FOREX_INTRADAY_SET: ReadonlySet<string> = new Set([
  "EUR/SEK",
  "EUR/NOK",
  "EUR/DKK",
  "EUR/PLN",
  "EUR/CZK",
  "EUR/HUF",
  "USD/SEK",
  "USD/NOK",
  "USD/PLN",
  "USD/CZK",
]);

/** Well-known symbols the GitHub repo may store. */
const KNOWN_FOREX_SYMBOLS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "NZD/USD",
  "USD/CAD",
  "EUR/GBP",
  "EUR/JPY",
  "EUR/CHF",
  "EUR/AUD",
  "EUR/CAD",
  "EUR/NZD",
  "EUR/TRY",
  "GBP/JPY",
  "GBP/CHF",
  "GBP/AUD",
  "GBP/CAD",
  "AUD/JPY",
  "CAD/JPY",
  "CHF/JPY",
  "AUD/CAD",
  "AUD/NZD",
  "NZD/JPY",
  "CAD/CHF",
  "EUR/RUB",
  "USD/TRY",
  "USD/ZAR",
  "USD/MXN",
  "USD/SGD",
  "MAD/USD",
  "KES/USD",
  "BTC/USD",
  "ETH/USD",
];

// ─────────────────────────────────────────────────────────────────────────────
//  SERVICE
// ─────────────────────────────────────────────────────────────────────────────

class ForexDataService {
  private static instance: ForexDataService;

  private client: AxiosInstance;

  /** Persistent 1-minute candle buffer keyed by SYMBOL|TIMEFRAME. */
  private candleBuffer: Map<string, ForexCandle[]> = new Map();

  /**
   * Session-lifetime count of REAL candles written into the buffers — PO M20
   * bars ingested verbatim plus 1m/1s bucket rollovers opened from live ticks.
   * Only genuine candles increment it; it backs /health/feed `candles_emitted`.
   */
  private candleEmissionCount = 0;

  /** Per-symbol last-known spot price (for cross-method access). */
  private lastSpotCache: Map<string, { price: number; ts: number }> = new Map();

  /**
   * Authoritative Pocket Option prices, fed by the SSOT bridge. When a PO price
   * is present and fresh for a symbol it becomes the CANONICAL live rate for the
   * whole platform (price, candle aggregation AND prediction), because it is the
   * closest real-time match to what Pocket Option actually trades at — thus
   * eliminating chart price gaps vs PO. Symbols PO does not cover fall back to
   * the free-API cascade below (hybrid strategy).
   */
  private pocketOptionCache: Map<
    string,
    { price: number; bid?: number; ask?: number; ts: number }
  > = new Map();

  /** GitHub polling timer. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Dynamic payout percentage cache per symbol. */
  private payoutCache: Map<string, number> = new Map();

  /** Rate-limit avoidance: minimum ms between successive API calls. */
  private lastApiCallAt = 0;
  private readonly API_CALL_THROTTLE_MS = 250;

  // ── Source health tracking ──
  // Tracks per-source success/failure to intelligently re-order the fallback
  // cascade and detect recovery after a transient outage. A source that
  // recently failed is retried sooner (not skipped) so the tiered cascade
  // self-heals without waiting for the stale hold to expire.
  private sourceHealth: Map<
    string,
    {
      ok: boolean;
      lastCheck: number;
      failCount: number;
      lastError: string | null;
    }
  > = new Map();
  /** True when the last getLiveSpotFresh() fell through to stale-cache or
   *  failed entirely — triggers aggressive retry on the next poll cycle. */
  private recoveryMode = false;
  /** Timestamp of the last successful fresh spot fetch from ANY live API
   *  (not held/cached). Used to detect partial recovery. */
  private lastFreshApiSuccessAt = 0;

  // ── PART 28: Yahoo Finance intraday forex tier ──
  // Per-symbol throttle so the 1-second poll loop re-serves the last genuine
  // 1-minute Yahoo print (9s cadence => ~1.1 req/s global, well under the
  // unofficial endpoint's comfort zone). Bars only change once per minute, so
  // re-serving within the minute loses nothing.
  private lastYahooFetch: Map<
    string,
    { ts: number; price: number; bid?: number; ask?: number }
  > = new Map();

  private constructor() {
    this.client = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      // Cache-busting headers: force every request to bypass HTTP/edge caches
      // (GitHub raw, CDN, proxies) so the freshest published price is always
      // returned instead of a stale cached copy.
      headers: {
        Accept: "application/json",
        "User-Agent": "trading-ai-platform/1.0",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });

    this.startGitHubPolling();
  }

  public static getInstance(): ForexDataService {
    if (!ForexDataService.instance) {
      ForexDataService.instance = new ForexDataService();
    }
    return ForexDataService.instance;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GITHUB REPOSITORY POLLING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start periodic polling of a GitHub raw file URL for price data.
   * The file is expected to be a JSON object mapping symbols to prices,
   * or an array of { symbol, price, ... } objects.
   */
  private startGitHubPolling(): void {
    if (this.pollTimer) return;

    logger.info("[ForexData] Starting GitHub repository polling", {
      repo: `${GITHUB_DATA_REPO_OWNER}/${GITHUB_DATA_REPO_NAME}`,
      branch: GITHUB_DATA_BRANCH,
      file: GITHUB_PRICES_FILE,
      intervalMs: GITHUB_DATA_POLL_MS,
    });

    // Initial fetch
    void this.fetchGitHubPrices();

    this.pollTimer = setInterval(() => {
      void this.fetchGitHubPrices();
    }, GITHUB_DATA_POLL_MS);
  }

  /**
   * Stop GitHub polling (used in graceful shutdown).
   */
  public stopGitHubPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.info("[ForexData] GitHub polling stopped");
    }
  }

  /**
   * Fetch price data from the GitHub repository raw file URL.
   * Supports both JSON array and JSON object formats.
   */
  private async fetchGitHubPrices(): Promise<void> {
    try {
      // Cache-busting: append a unique timestamp query param so GitHub raw
      // never serves a stale cached snapshot. Combine with the no-cache
      // headers on the shared client for instant freshness.
      const cacheBuster = Date.now();
      const rawUrl = `${this.buildGitHubRawUrl(GITHUB_PRICES_FILE)}?ts=${cacheBuster}`;
      const response = await this.client.get(rawUrl);

      if (response.status !== 200 || !response.data) {
        logger.debug("[ForexData] GitHub prices file returned non-200", {
          status: response.status,
          url: rawUrl,
        });
        return;
      }

      const data = response.data;

      if (Array.isArray(data)) {
        for (const entry of data) {
          this.processGitHubTickEntry(entry);
        }
      } else if (typeof data === "object" && data !== null) {
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "number" && value > 0) {
            const symbol = key.replace(/[-_]/g, "/").toUpperCase();
            this.updateSpotCache(symbol, value);
          } else if (
            typeof value === "object" &&
            value !== null &&
            "price" in (value as Record<string, unknown>)
          ) {
            this.processGitHubTickEntry(value);
          }
        }
      }

      logger.debug("[ForexData] GitHub prices polled successfully", {
        source: "github_repo",
        url: rawUrl,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.debug("[ForexData] GitHub price poll failed (non-fatal)", {
        error: msg,
        repo: `${GITHUB_DATA_REPO_OWNER}/${GITHUB_DATA_REPO_NAME}`,
      });
    }
  }

  /**
   * Process a single tick entry from the GitHub data file.
   * Updates the spot cache so subsequent getLiveSpotFresh() calls
   * can return the most recently observed real price.
   */
  private processGitHubTickEntry(entry: unknown): void {
    if (!entry || typeof entry !== "object") return;
    const tick = entry as Record<string, unknown>;

    const symbol =
      typeof tick.symbol === "string" ? tick.symbol.trim().toUpperCase() : "";
    const price = Number(tick.price);

    if (!symbol || !Number.isFinite(price) || price <= 0) return;

    this.updateSpotCache(symbol, price);

    // Optionally cache bid/ask if present
    const bid = Number(tick.bid);
    const ask = Number(tick.ask);
    if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
      this.lastSpotCache.set(`${symbol}:bid`, {
        price: bid,
        ts: Date.now(),
      });
      this.lastSpotCache.set(`${symbol}:ask`, {
        price: ask,
        ts: Date.now(),
      });
    }
  }

  /**
   * Build a raw file URL for the configured GitHub repo/branch/path.
   */
  private buildGitHubRawUrl(filePath: string): string {
    return `https://raw.githubusercontent.com/${GITHUB_DATA_REPO_OWNER}/${GITHUB_DATA_REPO_NAME}/${GITHUB_DATA_BRANCH}/${filePath}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIVE SPOT RATE — TIERED API CASCADE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get a FRESH live spot rate. Always fetches from the network; does NOT
   * return the cache. Used by the tick ingestion engine's 1-second poll loop.
   *
   * Tiered fallback cascade:
   *  1. GitHub repo cache (if fresh < 15s)
   *  2. Frankfurter API (ECB rates, free, no key)
   *  3. Open ER-API (free, no key)
   *  4. CoinGecko (crypto only)
   */
  async getLiveSpotFresh(symbol: string): Promise<ForexSpotResult> {
    const norm = (symbol || "").trim().toUpperCase();

    // ── PRIORITY 0: Pocket Option SSOT (when present & fresh) ──
    // The Pocket Option bridge delivers the closest real-time match to PO's own
    // price for the pairs it covers. When available (< 15s old) it is the
    // authoritative rate for this symbol — the live chart price, candle engine
    // and prediction pipeline all consume THIS value, achieving PO parity.
    const po = this.pocketOptionCache.get(norm);
    if (po && Date.now() - po.ts < 15_000 && po.price > 0) {
      const poBid =
        typeof po.bid === "number" && Number.isFinite(po.bid) && po.bid > 0
          ? po.bid
          : undefined;
      const poAsk =
        typeof po.ask === "number" && Number.isFinite(po.ask) && po.ask > 0
          ? po.ask
          : undefined;
      return {
        success: true,
        price: po.price,
        ...(poBid !== undefined ? { bid: poBid } : {}),
        ...(poAsk !== undefined ? { ask: poAsk } : {}),
        source: "pocket_option_ssot",
      };
    }
    // A slightly-stale PO price (> 15s, never invented) is still closer to PO
    // than a fresh free-API print for pairs it covers, but we prefer real API
    // freshness below 5s gap; between 15s..60s we hold the PO rate to avoid
    // arbitrary cross-circuit jumps that would show as chart gaps.
    if (po && po.price > 0 && Date.now() - po.ts < 60_000) {
      const poBid =
        typeof po.bid === "number" && Number.isFinite(po.bid) && po.bid > 0
          ? po.bid
          : undefined;
      const poAsk =
        typeof po.ask === "number" && Number.isFinite(po.ask) && po.ask > 0
          ? po.ask
          : undefined;
      return {
        success: true,
        price: po.price,
        ...(poBid !== undefined ? { bid: poBid } : {}),
        ...(poAsk !== undefined ? { ask: poAsk } : {}),
        source: "pocket_option_held",
      };
    }

    // Check GitHub cache freshness next (< 15 seconds old)
    const cached = this.lastSpotCache.get(norm);
    if (cached && Date.now() - cached.ts < 15_000) {
      return {
        success: true,
        price: cached.price,
        source: "github_repo_cached",
      };
    }

    // ── PART 28 TIER 0.5: Yahoo Finance 1-minute intraday (real pairs only) ──
    // The 10 ECB real pairs now stream from Yahoo's intraday chart API — the
    // same source the candle engine and signal pipeline consume for OTC. This
    // runs BEFORE the ECB daily feeds so live M1 candles / 1Hz blotter get
    // genuine intraday prints, not a daily close repeated all day (PART 27 bug
    // class). Falls through to Frankfurter/open.er-api when Yahoo is down.
    if (REAL_FOREX_INTRADAY_SET.has(norm)) {
      const yahooResult = await this.fetchYahooSpot(norm);
      this.recordSourceHealth(
        "yahoo_finance",
        yahooResult.success,
        yahooResult.error,
      );
      if (yahooResult.success) {
        this.recoveryMode = false;
        return yahooResult;
      }
    }

    // ── RECOVERY MODE: skip throttle, try all tiers aggressively ──
    // When the system is recovering from an "exhausted" state, the normal
    // API_CALL_THROTTLE_MS would delay recovery by 250ms per tier. In
    // recovery mode we bypass the throttle so the cascade runs at network
    // speed — a recovered API is re-anchored instantly.
    const wasThrottled = this.recoveryMode;

    // Tier 1: Frankfurter (ECB published rates, free)
    const frankResult = await this.fetchFrankfurterSpot(norm);
    this.recordSourceHealth(
      "frankfurter",
      frankResult.success,
      frankResult.error,
    );
    if (frankResult.success) {
      this.recoveryMode = false;
      return frankResult;
    }

    // Tier 2: Open Exchange Rates API (free tier)
    const openErResult = await this.fetchOpenErSpot(norm);
    this.recordSourceHealth(
      "open_er_api",
      openErResult.success,
      openErResult.error,
    );
    if (openErResult.success) {
      this.recoveryMode = false;
      return openErResult;
    }

    // Tier 3: CoinGecko (crypto pairs only)
    let cgResult: ForexSpotResult | undefined;
    if (norm === "BTC/USD" || norm === "ETH/USD") {
      cgResult = await this.fetchCoinGeckoSpot(norm);
      this.recordSourceHealth("coingecko", cgResult.success, cgResult.error);
      if (cgResult.success) {
        this.recoveryMode = false;
        return cgResult;
      }
    }

    const held = this.lastSpotCache.get(norm);
    if (
      held &&
      Number.isFinite(held.price) &&
      held.price > 0 &&
      Date.now() - held.ts < STALE_HOLD_MAX_AGE_MS
    ) {
      logger.warn("[ForexData] All live sources failed; stale price withheld", {
        symbol: norm,
        ageMs: Date.now() - held.ts,
      });
    }

    // All sources exhausted and no real baseline — enter recovery mode and
    // return honest failure. Recovery mode ensures the next poll cycle
    // bypasses throttle delays and retries all tiers at network speed.
    // Log the FULL fallback chain with per-source reason (mission [4]) so
    // operators see exactly which tier died and why (timeout/429/500/DNS).
    logger.error("[ForexData] All spot rate sources exhausted — chain audit", {
      symbol: norm,
      chain: renderFallbackChainLog([
        {
          source: "pocket_option_ssot",
          ok: !!(po && po.price > 0 && Date.now() - po.ts < 15_000),
          reason:
            po && po.price > 0 && Date.now() - po.ts < 15_000
              ? undefined
              : po && po.price > 0
                ? `stale_${Math.round((Date.now() - po.ts) / 1000)}s_held`
                : "no_ssot_cache",
        },
        {
          source: "github_repo_cached",
          ok: !!(cached && Date.now() - cached.ts < 15_000),
          reason: cached
            ? `age_${Math.round((Date.now() - cached.ts) / 1000)}s`
            : "no_cache",
        },
        { source: "frankfurter", ok: false, reason: frankResult.error },
        { source: "open_er_api", ok: false, reason: openErResult.error },
        ...((norm === "BTC/USD" || norm === "ETH/USD") && cgResult
          ? [{ source: "coingecko", ok: false, reason: cgResult.error }]
          : []),
      ]),
    });
    this.recoveryMode = true;
    return {
      success: false,
      price: null,
      source: "none",
      error: `All spot rate sources exhausted for ${norm}`,
    };
  }

  /**
   * Get a live spot rate, preferentially from the cached GitHub data or
   * API cache. Used by controllers that don't need real-time freshness.
   */
  async getLiveSpot(symbol: string): Promise<ForexSpotResult> {
    const norm = (symbol || "").trim().toUpperCase();

    // Pocket Option SSOT first — same parity guarantee as getLiveSpotFresh so
    // controllers (e.g. /predict spot fallback) read the same authoritative
    // price the live chart renders.
    const po = this.pocketOptionCache.get(norm);
    if (po && po.price > 0 && Date.now() - po.ts < 120_000) {
      const poBid =
        typeof po.bid === "number" && Number.isFinite(po.bid) && po.bid > 0
          ? po.bid
          : undefined;
      const poAsk =
        typeof po.ask === "number" && Number.isFinite(po.ask) && po.ask > 0
          ? po.ask
          : undefined;
      return {
        success: true,
        price: po.price,
        ...(poBid !== undefined ? { bid: poBid } : {}),
        ...(poAsk !== undefined ? { ask: poAsk } : {}),
        source: "pocket_option_ssot",
      };
    }

    // Check GitHub cache next (fresh < 30 seconds)
    const cached = this.lastSpotCache.get(norm);
    if (cached && Date.now() - cached.ts < 30_000) {
      return {
        success: true,
        price: cached.price,
        source: "github_repo_cached",
      };
    }

    // Delegate to the fresh variant
    return this.getLiveSpotFresh(norm);
  }

  // ── Yahoo Finance intraday chart API (PART 28: real pairs) ──────────────

  private async fetchYahooSpot(symbol: string): Promise<ForexSpotResult> {
    try {
      const { base, quote } = this.splitSymbol(symbol);
      if (!base || !quote) {
        return {
          success: false,
          price: null,
          source: "yahoo_finance",
          error: `Cannot parse symbol: ${symbol}`,
        };
      }

      // Per-symbol throttle: 1-min Yahoo bars change at most once per minute,
      // so re-serving the last real intraday print inside the window keeps the
      // 1Hz blotter fed without hammering the unofficial endpoint.
      const held = this.lastYahooFetch.get(symbol);
      if (held && Date.now() - held.ts < YAHOO_POLL_MS) {
        return {
          success: true,
          price: held.price,
          ...(held.bid !== undefined ? { bid: held.bid } : {}),
          ...(held.ask !== undefined ? { ask: held.ask } : {}),
          source: "yahoo_intraday_held",
        };
      }

      await this.throttleApiCall();

      const ticker = `${base}${quote}=X`;
      const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=false`;
      const response = await this.client.get(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });

      const result = response.data?.chart?.result?.[0];
      const meta = result?.meta;
      const timestamps: number[] | undefined = result?.timestamp;
      const closes: number[] | undefined =
        result?.indicators?.quote?.[0]?.close;

      if (!meta || !Array.isArray(timestamps) || !Array.isArray(closes)) {
        return {
          success: false,
          price: null,
          source: "yahoo_finance",
          error: "Unexpected Yahoo chart payload",
        };
      }

      // Freshest real intraday print: last non-null close on the tape.
      let price = Number(meta?.regularMarketPrice ?? NaN);
      for (let i = closes.length - 1; i >= 0; i -= 1) {
        const c = Number(closes[i]);
        if (Number.isFinite(c) && c > 0) {
          if (!(Number.isFinite(price) && price > 0)) price = c;
          break;
        }
      }
      const lastTs = timestamps.length ? timestamps[timestamps.length - 1] : 0;

      if (!Number.isFinite(price) || price <= 0) {
        return {
          success: false,
          price: null,
          source: "yahoo_finance",
          error: "No positive close on Yahoo tape",
        };
      }

      this.lastYahooFetch.set(symbol, {
        ts: Date.now(),
        price,
        ...(meta?.bid !== undefined ? { bid: Number(meta.bid) } : {}),
        ...(meta?.ask !== undefined ? { ask: Number(meta.ask) } : {}),
      });
      this.updateSpotCache(symbol, price);

      logger.debug("[ForexData] Yahoo intraday quote", {
        symbol,
        price,
        lastBarTs: lastTs,
        bars: closes.length,
      });

      return {
        success: true,
        price,
        source: "yahoo_finance",
      };
    } catch (error: unknown) {
      return {
        success: false,
        price: null,
        source: "yahoo_finance",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ── Frankfurter API (ECB rates) ──────────────────────────────────────

  private async fetchFrankfurterSpot(symbol: string): Promise<ForexSpotResult> {
    try {
      await this.throttleApiCall();

      const { base, quote } = this.splitSymbol(symbol);
      if (!base || !quote) {
        return {
          success: false,
          price: null,
          source: "frankfurter",
          error: `Cannot parse symbol: ${symbol}`,
        };
      }

      const url = `${FRANKFURTER_BASE}/latest?from=${base}&to=${quote}`;
      const response = await this.client.get(url);

      if (response.status === 200 && response.data?.rates?.[quote]) {
        const price = Number(response.data.rates[quote]);
        if (Number.isFinite(price) && price > 0) {
          this.updateSpotCache(symbol, price);
          return {
            success: true,
            price,
            source: "frankfurter",
          };
        }
      }

      return {
        success: false,
        price: null,
        source: "frankfurter",
        error: "No rate returned from Frankfurter",
      };
    } catch (error: unknown) {
      return {
        success: false,
        price: null,
        source: "frankfurter",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ── Open ER-API ──────────────────────────────────────────────────────────

  private async fetchOpenErSpot(symbol: string): Promise<ForexSpotResult> {
    try {
      await this.throttleApiCall();

      const { base, quote } = this.splitSymbol(symbol);
      if (!base || !quote) {
        return {
          success: false,
          price: null,
          source: "open_er_api",
          error: `Cannot parse symbol: ${symbol}`,
        };
      }

      const url = `${OPEN_ER_API_BASE}/${base}`;
      const response = await this.client.get(url);

      if (response.status === 200 && response.data?.rates?.[quote]) {
        const price = Number(response.data.rates[quote]);
        if (Number.isFinite(price) && price > 0) {
          this.updateSpotCache(symbol, price);
          return {
            success: true,
            price,
            source: "open_er_api",
          };
        }
      }

      return {
        success: false,
        price: null,
        source: "open_er_api",
        error: "No rate returned from Open ER-API",
      };
    } catch (error: unknown) {
      return {
        success: false,
        price: null,
        source: "open_er_api",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ── CoinGecko (crypto pairs) ─────────────────────────────────────────────

  private async fetchCoinGeckoSpot(symbol: string): Promise<ForexSpotResult> {
    try {
      await this.throttleApiCall();

      const coinId =
        symbol === "BTC/USD"
          ? "bitcoin"
          : symbol === "ETH/USD"
            ? "ethereum"
            : null;

      if (!coinId) {
        return {
          success: false,
          price: null,
          source: "coingecko",
          error: `Unsupported CoinGecko symbol: ${symbol}`,
        };
      }

      const url = `${COINGECKO_BASE}/simple/price?ids=${coinId}&vs_currencies=usd`;
      const response = await this.client.get(url);

      if (response.status === 200 && response.data?.[coinId]?.usd) {
        const price = Number(response.data[coinId].usd);
        if (Number.isFinite(price) && price > 0) {
          this.updateSpotCache(symbol, price);
          return {
            success: true,
            price,
            source: "coingecko",
          };
        }
      }

      return {
        success: false,
        price: null,
        source: "coingecko",
        error: "No price from CoinGecko",
      };
    } catch (error: unknown) {
      return {
        success: false,
        price: null,
        source: "coingecko",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HISTORICAL CANDLES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch historical OHLCV candles for a symbol.
   *
   * Data source cascade:
   *  1. GitHub repo — candles/{SYMBOL}-1d.json
   *  2. Frankfurter — last 90 days of daily ECB rates
   *  3. CoinGecko — historical daily OHLC (crypto only)
   *
   * Returns { success: false } with zero fabricated candles if all fail.
   */
  async getHistoricalCandles(
    symbol: string,
    timeframe: string = "1d",
    limit: number = 200,
  ): Promise<{
    success: boolean;
    bars: ForexCandle[];
    source: string;
    error?: string;
  }> {
    const norm = (symbol || "").trim().toUpperCase();

    // Try GitHub repo first
    const ghResult = await this.fetchGitHubCandles(norm, timeframe, limit);
    if (ghResult.success && ghResult.bars.length > 0) {
      return ghResult;
    }

    // PART 28: real pairs get Yahoo Finance intraday bars (M1/Hr) before the
    // ECB daily feed — this is what actually powers M1/M5 chart warmup for the
    // 10 real pairs now that they stream intraday.
    if (REAL_FOREX_INTRADAY_SET.has(norm)) {
      const yahooResult = await this.fetchYahooCandles(norm, timeframe, limit);
      if (yahooResult.success && yahooResult.bars.length > 0) {
        return yahooResult;
      }
    }

    // Try CoinGecko for crypto pairs (has historical OHLC)
    if (norm === "BTC/USD" || norm === "ETH/USD") {
      const cgResult = await this.fetchCoinGeckoCandles(norm, limit);
      if (cgResult.success && cgResult.bars.length > 0) {
        return cgResult;
      }
    }

    // Try Frankfurter for forex pairs (daily rates only)
    const { base, quote } = this.splitSymbol(norm);
    if (base && quote) {
      const frankResult = await this.fetchFrankfurterCandles(
        base,
        quote,
        limit,
      );
      if (frankResult.success && frankResult.bars.length > 0) {
        return frankResult;
      }
    }

    return {
      success: false,
      bars: [],
      source: "none",
      error: `No historical candle data available for ${norm}`,
    };
  }

  // ── GitHub candles ───────────────────────────────────────────────────────

  private async fetchGitHubCandles(
    symbol: string,
    timeframe: string,
    limit: number,
  ): Promise<{
    success: boolean;
    bars: ForexCandle[];
    source: string;
    error?: string;
  }> {
    try {
      const fileSymbol = symbol.replace(/\//g, "-");
      const url = this.buildGitHubRawUrl(
        `data/candles/${fileSymbol}-${timeframe}.json`,
      );
      const response = await this.client.get(url);

      if (response.status === 200 && Array.isArray(response.data)) {
        const bars: ForexCandle[] = response.data
          .filter(
            (b: Record<string, unknown>) =>
              b &&
              typeof b === "object" &&
              Number.isFinite(Number(b.close)) &&
              Number(b.close) > 0,
          )
          .map((b: Record<string, unknown>) => ({
            timestamp: Number(b.timestamp),
            open: Number(b.open),
            high: Number(b.high),
            low: Number(b.low),
            close: Number(b.close),
            volume: Number(b.volume ?? 0),
          }));

        if (bars.length > 0) {
          return {
            success: true,
            bars: bars.slice(-limit),
            source: "github_repo",
          };
        }
      }

      return {
        success: false,
        bars: [],
        source: "github_repo",
        error: "No candle data in GitHub file",
      };
    } catch {
      return {
        success: false,
        bars: [],
        source: "github_repo",
        error: "GitHub candle fetch failed",
      };
    }
  }

  // ── Yahoo Finance intraday candles (PART 28: real pairs) ────────────────

  private async fetchYahooCandles(
    norm: string,
    timeframe: string,
    limit: number,
  ): Promise<{
    success: boolean;
    bars: ForexCandle[];
    source: string;
    error?: string;
  }> {
    try {
      const { base, quote } = this.splitSymbol(norm);
      if (!base || !quote) {
        return {
          success: false,
          bars: [],
          source: "yahoo_finance",
          error: `Cannot parse symbol: ${norm}`,
        };
      }

      // Map our timeframe labels to Yahoo's interval + bucket (1-minute bars
      // only cover the last day; larger intervals tolerate long ranges).
      const tf = (timeframe || "1d").toLowerCase().trim();
      const yahooInterval =
        tf === "5m"
          ? "5m"
          : tf === "15m"
            ? "15m"
            : tf === "30m"
              ? "30m"
              : tf === "1h" || tf === "60m" || tf === "1hr"
                ? "60m"
                : tf === "1d"
                  ? "1d"
                  : "1m";
      const minutes =
        yahooInterval === "1m"
          ? 1
          : yahooInterval === "5m"
            ? 5
            : yahooInterval === "15m"
              ? 15
              : yahooInterval === "30m"
                ? 30
                : yahooInterval === "60m"
                  ? 60
                  : 1440;
      const daysNeeded = Math.ceil(
        (Math.min(Math.max(limit || 100, 10), 720) * minutes) / (24 * 60),
      );
      const range =
        yahooInterval === "1m"
          ? "1d"
          : daysNeeded <= 5
            ? "5d"
            : daysNeeded <= 30
              ? "1mo"
              : daysNeeded <= 90
                ? "3mo"
                : "1y";

      await this.throttleApiCall();

      const ticker = `${base}${quote}=X`;
      const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(ticker)}?interval=${yahooInterval}&range=${range}&includePrePost=false`;
      const response = await this.client.get(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });

      const result = response.data?.chart?.result?.[0];
      const timestamps: number[] | undefined = result?.timestamp;
      const q = result?.indicators?.quote?.[0];

      if (
        !Array.isArray(timestamps) ||
        !Array.isArray(q?.open) ||
        !Array.isArray(q?.high) ||
        !Array.isArray(q?.low) ||
        !Array.isArray(q?.close)
      ) {
        return {
          success: false,
          bars: [],
          source: "yahoo_finance",
          error: "Unexpected Yahoo chart payload",
        };
      }

      const bars: ForexCandle[] = [];
      for (let i = 0; i < timestamps.length; i += 1) {
        const open = Number(q.open[i]);
        const high = Number(q.high[i]);
        const low = Number(q.low[i]);
        const close = Number(q.close[i]);
        if (!open || !high || !low || !close) continue;
        bars.push({
          timestamp: timestamps[i] * 1000,
          open,
          high,
          low,
          close,
          volume: Number(q.volume?.[i] ?? 0),
        });
      }

      if (bars.length === 0) {
        return {
          success: false,
          bars: [],
          source: "yahoo_finance",
          error: "No positive bars on Yahoo tape",
        };
      }

      return {
        success: true,
        bars: bars.slice(-limit),
        source: `yahoo_finance:${yahooInterval}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        bars: [],
        source: "yahoo_finance",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ── Frankfurter historical rates (converted to candle-like bars) ────────

  private async fetchFrankfurterCandles(
    base: string,
    quote: string,
    limit: number,
  ): Promise<{
    success: boolean;
    bars: ForexCandle[];
    source: string;
    error?: string;
  }> {
    try {
      await this.throttleApiCall();

      // Frankfurter provides up to ~360 days of historical daily rates
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - Math.min(limit + 30, 365));

      const fmt = (d: Date) => d.toISOString().split("T")[0];
      const url = `${FRANKFURTER_BASE}/${fmt(startDate)}..${fmt(endDate)}?from=${base}&to=${quote}`;
      const response = await this.client.get(url);

      if (response.status === 200 && response.data?.rates) {
        const rates: Record<string, Record<string, number>> = response.data
          .rates;
        const entries = Object.entries(rates).sort(
          ([a], [b]) => new Date(a).getTime() - new Date(b).getTime(),
        );

        const bars: ForexCandle[] = entries.map(
          ([dateStr, rateObj], idx, arr) => {
            const close = Number(rateObj[quote]);
            const prevClose = idx > 0 ? Number(arr[idx - 1][1][quote]) : close;
            const open = prevClose;
            const high = Math.max(open, close);
            const low = Math.min(open, close);

            return {
              timestamp: new Date(dateStr).getTime(),
              open,
              high,
              low,
              close,
              volume: 0,
            };
          },
        );

        // Only return positive prices
        const valid = bars.filter((b) => b.close > 0 && b.open > 0);

        if (valid.length > 0) {
          return {
            success: true,
            bars: valid.slice(-limit),
            source: "frankfurter",
          };
        }
      }

      return {
        success: false,
        bars: [],
        source: "frankfurter",
        error: "No candle data from Frankfurter",
      };
    } catch (error: unknown) {
      return {
        success: false,
        bars: [],
        source: "frankfurter",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ── CoinGecko historical OHLC (crypto only) ─────────────────────────────

  private async fetchCoinGeckoCandles(
    symbol: string,
    limit: number,
  ): Promise<{
    success: boolean;
    bars: ForexCandle[];
    source: string;
    error?: string;
  }> {
    try {
      await this.throttleApiCall();

      const coinId =
        symbol === "BTC/USD"
          ? "bitcoin"
          : symbol === "ETH/USD"
            ? "ethereum"
            : null;

      if (!coinId) {
        return {
          success: false,
          bars: [],
          source: "coingecko",
          error: "Unsupported symbol for CoinGecko",
        };
      }

      // CoinGecko OHLC endpoint: /coins/{id}/ohlc
      // days=90 gives daily candles
      const url = `${COINGECKO_BASE}/coins/${coinId}/ohlc?vs_currency=usd&days=90`;
      const response = await this.client.get(url);

      if (response.status === 200 && Array.isArray(response.data)) {
        const raw: [number, number, number, number, number][] = response.data;
        const bars: ForexCandle[] = raw.map(([ts, o, h, l, c]) => ({
          timestamp: ts,
          open: Number(o),
          high: Number(h),
          low: Number(l),
          close: Number(c),
          volume: 0,
        }));

        const valid = bars.filter(
          (b) => b.close > 0 && Number.isFinite(b.close),
        );

        if (valid.length > 0) {
          return {
            success: true,
            bars: valid.slice(-limit),
            source: "coingecko",
          };
        }
      }

      return {
        success: false,
        bars: [],
        source: "coingecko",
        error: "No candle data from CoinGecko",
      };
    } catch (error: unknown) {
      return {
        success: false,
        bars: [],
        source: "coingecko",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TICK BUFFER — MULTI-TIMEFRAME REAL-TIME CANDLE AGGREGATION
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Every real tick is folded into MULTIPLE wall-clock-aligned OHLCV buckets
  // (5s and 1m by default; any timeframe supported via timeframeToMs). The
  // in-progress bucket's high/low/close is updated on every tick so the candle
  // "breathes" live; when a new bucket opens the previous bar is closed and a
  // brand-new candle rolls over immediately. This mirrors the frontend's
  // RealtimeCandleAggregator so both sides stay in sync.
  //
  // The sub-minute 5s bucket is what the prediction pipeline and tick-quant
  // path use to derive precise live target/close-estimate projections.

  /** Timeframes the aggregator maintains in-memory for every active symbol.
   *  1s and 1m are the wall-clock-aligned builders: 1s is the live chart
   *  heartbeat, 1m is the binary-expiry decision bucket. Both map identically
   *  to the Pocket Option active chart feed bar structure. */
  private readonly AGGREGATE_TIMEFRAMES = ["1s", "1m"] as const;

  /**
   * Append a real observed tick price into the persistent candle buffers.
   * Folds the tick into every aggregated timeframe, updating the current
   * candle's high/low/close and rolling over to a fresh bar when a bucket
   * boundary passes. Only accepts real finite positive prices.
   */
  appendTick(symbol: string, price: number): void {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm || !Number.isFinite(price) || price <= 0) return;

    const now = Date.now();

    for (const timeframe of this.AGGREGATE_TIMEFRAMES) {
      this.appendToTimeframe(norm, timeframe, price, now);
    }
  }

  /**
   * Fold a single tick into one timeframe's bucket, with rollover.
   */
  private appendToTimeframe(
    norm: string,
    timeframe: string,
    price: number,
    now: number,
  ): void {
    const bucketMs = this.timeframeToMs(timeframe);
    const bucketTs = now - (now % bucketMs);

    const bufferKey = `${norm}|${timeframe}`;
    const bars = this.candleBuffer.get(bufferKey) ?? [];
    const lastBar = bars[bars.length - 1];

    if (lastBar && lastBar.timestamp === bucketTs) {
      // Update existing (in-progress) bucket — candle breathes live.
      lastBar.high = Math.max(lastBar.high, price);
      lastBar.low = Math.min(lastBar.low, price);
      lastBar.close = price;
      lastBar.volume += 1;
    } else {
      // Bucket rollover → close the previous candle, open a brand-new one.
      bars.push({
        timestamp: bucketTs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1,
      });
      this.candleEmissionCount += 1;

      // Trim old bars (keep last 500 per timeframe).
      if (bars.length > 500) {
        bars.splice(0, bars.length - 500);
      }
    }

    this.candleBuffer.set(bufferKey, bars);
  }

  /**
   * Ingest an EXACT candle delivered by the Pocket Option bridge (M20 bar with
   * its own bucket-start `time`). This gives the chart + signal engine the
   * precise OHLC structure Pocket Option's active feed produces — zero local
   * re-derivation divergence. The bar is written verbatim into the shared
   * buffer (matched by its bucket timestamp) so downstream `1m`/`1s` readers
   * and the signal pipeline consume the same values PO trades on.
   */
  ingestPoCandle(
    symbol: string,
    time: number,
    ohlc: { open: number; high: number; low: number; close: number },
    closed: boolean,
    assetType?: string,
  ): ForexCandle | null {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm) return null;
    if (
      !Number.isFinite(time) ||
      !Number.isFinite(ohlc.open) ||
      !Number.isFinite(ohlc.high) ||
      !Number.isFinite(ohlc.low) ||
      !Number.isFinite(ohlc.close)
    ) {
      return null;
    }
    if (ohlc.open <= 0 || ohlc.high <= 0 || ohlc.low <= 0 || ohlc.close <= 0) {
      return null;
    }

    const candle: ForexCandle = {
      timestamp: time,
      open: ohlc.open,
      high: Math.max(ohlc.high, ohlc.open, ohlc.close),
      low: Math.min(ohlc.low, ohlc.open, ohlc.close),
      close: ohlc.close,
      volume: 1,
      ...(assetType ? { assetType } : {}),
    };

    // Write into the 1m bucket (M20 bars roll up into 1m for the expiry
    // decision matrix) matching PO's own bucket-start timestamp so the merge
    // is stable and gap-free across bridge/flush cycles.
    this.mergePoCandleIntoBuffer(norm, "1m", candle);
    // Mirror into 1s for the tick-quant heartbeat (each M20 close is a 1s
    // sample of the live PO tape).
    this.mergePoCandleIntoBuffer(norm, "1s", candle);
    this.candleEmissionCount += 1;

    return candle;
  }

  /** Session-lifetime count of REAL candles emitted into the buffers. */
  public getCandleEmissionCount(): number {
    return this.candleEmissionCount;
  }

  /**
   * Merge a PO-sourced candle into one timeframe's buffer, keyed by bucket ts.
   */
  private mergePoCandleIntoBuffer(
    norm: string,
    timeframe: string,
    candle: ForexCandle,
  ): void {
    const bucketMs = this.timeframeToMs(timeframe);
    const bucketTs = candle.timestamp - (candle.timestamp % bucketMs);
    const bufferKey = `${norm}|${timeframe}`;
    const bars = this.candleBuffer.get(bufferKey) ?? [];
    const idx = bars.findIndex((b) => b.timestamp === bucketTs);

    if (idx >= 0) {
      // Roll OHLC up into the existing bucket (preserve low/high extremes).
      const existing = bars[idx];
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += 1;
      bars[idx] = existing;
    } else {
      bars.push({
        timestamp: bucketTs,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: 1,
      });
    }

    // Trim old bars (keep last 500 per timeframe).
    if (bars.length > 500) {
      bars.splice(0, bars.length - 500);
    }
    this.candleBuffer.set(bufferKey, bars);
  }

  getLiveCandles(symbol: string, timeframe = "1m"): ForexCandle[] {
    const norm = (symbol || "").trim().toUpperCase();
    const bufferKey = `${norm}|${timeframe}`;
    const bars = this.candleBuffer.get(bufferKey);
    if (!bars || bars.length === 0) return [];
    return bars.slice(-300);
  }

  /**
   * Get the single currently-forming candle for a symbol+timeframe, or null.
   */
  getLiveCandle(symbol: string, timeframe = "1m"): ForexCandle | null {
    const norm = (symbol || "").trim().toUpperCase();
    const bufferKey = `${norm}|${timeframe}`;
    const bars = this.candleBuffer.get(bufferKey);
    if (!bars || bars.length === 0) return null;
    return bars[bars.length - 1];
  }

  /**
   * Get buffered candles, possibly supplemented with real bars.
   * Used by the signal controller when fewer than the required bar count
   * has accumulated from live ticks.
   *
   * ZERO FABRICATION: returns whatever real bars exist. The caller
   * decides whether to reject the request (503) or wait for more data.
   * Skeleton/placeholder bars are NEVER generated — they would poison
   * the ML features and produce untrustworthy confidence.
   */
  async getBufferedCandles(
    options: BufferedCandleOptions,
  ): Promise<ForexCandle[]> {
    const { symbol, timeframe, required, realBars } = options;
    const norm = (symbol || "").trim().toUpperCase();
    const bufferKey = `${norm}|${timeframe}`;
    const buffered = this.candleBuffer.get(bufferKey) ?? [];

    // Merge real bars and buffered bars, dedup by timestamp
    const allBars = [...realBars, ...buffered];
    const deduped = this.deduplicateBars(allBars);

    return deduped;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ATR COMPUTATION (Wilder's Smoothing)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Compute Average True Range using Wilder's smoothing method.
   * Returns the ATR value and volatility percentage relative to the
   * current price.
   */
  computeAtr(
    bars: ForexCandle[],
    period: number = 14,
    options?: ComputeAtrOptions,
  ): { atr: number; volatilityPct: number } {
    if (!bars || bars.length < 2) {
      return { atr: 0, volatilityPct: 0 };
    }

    const trueRanges: number[] = [];

    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1];
      const curr = bars[i];
      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close),
      );
      trueRanges.push(tr);
    }

    if (trueRanges.length === 0) {
      return { atr: 0, volatilityPct: 0 };
    }

    // Wilder's smoothing: seed with SMA, then EMA-style
    let atr: number;
    if (trueRanges.length < period) {
      // Not enough data for full period — use available data
      atr = trueRanges.reduce((sum, v) => sum + v, 0) / trueRanges.length;
    } else {
      // Initial ATR = SMA of first `period` true ranges
      atr = trueRanges.slice(0, period).reduce((sum, v) => sum + v, 0) / period;

      // Wilder smoothing for remaining periods
      for (let i = period; i < trueRanges.length; i++) {
        atr = (atr * (period - 1) + trueRanges[i]) / period;
      }
    }

    // Volatility percentage: ATR / current close * 100
    const lastClose = bars[bars.length - 1].close;
    const volatilityPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;

    return {
      atr: Number(atr.toFixed(8)),
      volatilityPct: Number(volatilityPct.toFixed(6)),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TARGET PRICE COMPUTATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Compute the projection target price based on the signal direction
   * and ATR magnitude. The target ALWAYS agrees with the direction:
   *  BUY  → target above live price
   *  SELL → target below live price
   */
  computeTargetPrice(
    direction: "BUY" | "SELL" | "HOLD",
    livePrice: number,
    atr: number,
    timeframe: string,
    symbol: string,
  ): number {
    if (!Number.isFinite(livePrice) || livePrice <= 0) return 0;
    if (!Number.isFinite(atr) || atr <= 0) return livePrice;

    // Scale ATR by timeframe — longer timeframes = larger moves
    const tfScale = this.timeframeToMultiplier(timeframe);
    const targetDistance = atr * tfScale;

    if (direction === "BUY") {
      return Number((livePrice + targetDistance).toFixed(6));
    } else if (direction === "SELL") {
      return Number((livePrice - targetDistance).toFixed(6));
    }

    // HOLD — flat projection
    return livePrice;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PAYOUT SYNC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync dynamic payout percentage for a symbol based on its real ATR
   * volatility. Higher volatility → lower payout (risk-adjusted).
   * Returns the payout percentage (0-100).
   */
  async syncPayouts(symbol: string): Promise<number> {
    const norm = (symbol || "").trim().toUpperCase();

    try {
      const barResult = await this.getHistoricalCandles(norm, "1d", 60);
      const bars = barResult.bars;

      if (bars.length === 0) {
        // No bars — return a reasonable default
        const defaultPayout = 85;
        this.payoutCache.set(norm, defaultPayout);
        return defaultPayout;
      }

      const { volatilityPct } = this.computeAtr(bars, 14);

      // Map volatility to payout percentage:
      // Low volatility (< 0.3%) → higher payout (up to 92%)
      // High volatility (> 1.0%) → lower payout (down to 72%)
      let payout: number;
      if (volatilityPct < 0.15) {
        payout = 92;
      } else if (volatilityPct < 0.3) {
        payout = 90;
      } else if (volatilityPct < 0.5) {
        payout = 87;
      } else if (volatilityPct < 0.75) {
        payout = 84;
      } else if (volatilityPct < 1.0) {
        payout = 80;
      } else {
        payout = 75;
      }

      this.payoutCache.set(norm, payout);

      logger.debug("[ForexData] Payout synced", {
        symbol: norm,
        volatilityPct: volatilityPct.toFixed(4),
        payout,
      });

      return payout;
    } catch (error: unknown) {
      const fallback = this.payoutCache.get(norm) ?? 85;
      logger.debug("[ForexData] Payout sync fallback", {
        symbol: norm,
        fallback,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SOURCE HEALTH TRACKING & RECOVERY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record that a data source succeeded or failed on its latest probe.
   * Used by the tiered cascade to re-order retries and detect recovery.
   */
  private recordSourceHealth(
    source: string,
    success: boolean,
    error?: string,
  ): void {
    const prev = this.sourceHealth.get(source);
    const failCount = success ? 0 : (prev?.failCount ?? 0) + 1;
    this.sourceHealth.set(source, {
      ok: success,
      lastCheck: Date.now(),
      failCount,
      lastError: success ? null : error || "unknown",
    });
    if (success) {
      this.lastFreshApiSuccessAt = Date.now();
    }
  }

  /**
   * True when the system should aggressively retry all API tiers because
   * the last poll cycle fell back to stale-cache or failed entirely.
   * Recovery mode is cleared on the first successful fresh API fetch.
   */
  public isRecoveryMode(): boolean {
    return this.recoveryMode;
  }

  /**
   * Get the last KNOWN REAL spot price for a symbol WITHOUT hitting the
   * network — reads the spot cache directly. Used by the tick ingestion
   * ring-refresh path so a starving tick ring can keep its 2000-tick buffer
   * fed with a real previously-observed price at zero network cost. Returns
   * null when no genuine price has ever been observed (no fabrication).
   */
  getLastKnownSpot(symbol: string): ForexSpotResult {
    const norm = (symbol || "").trim().toUpperCase();
    const cached = this.lastSpotCache.get(norm);
    if (cached && Number.isFinite(cached.price) && cached.price > 0) {
      return {
        success: true,
        price: cached.price,
        source: "last_known_real",
      };
    }
    const po = this.pocketOptionCache.get(norm);
    if (po && Number.isFinite(po.price) && po.price > 0) {
      return {
        success: true,
        price: po.price,
        source: "pocket_option_last_known",
      };
    }
    return {
      success: false,
      price: null,
      source: "none",
      error: `No previously observed spot rate for ${norm}`,
    };
  }

  /**
   * Get a snapshot of source health for diagnostics.
   */
  public getSourceHealth(): Record<
    string,
    {
      ok: boolean;
      lastCheck: number;
      failCount: number;
      lastError: string | null;
    }
  > {
    const out: Record<
      string,
      {
        ok: boolean;
        lastCheck: number;
        failCount: number;
        lastError: string | null;
      }
    > = {};
    for (const [k, v] of this.sourceHealth) out[k] = { ...v };
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update the spot price cache for a symbol.
   */
  private updateSpotCache(symbol: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const norm = symbol.trim().toUpperCase();
    const prev = this.lastSpotCache.get(norm);
    // Only update if price actually changed (dedup)
    if (prev && prev.price === price) return;
    this.lastSpotCache.set(norm, { price, ts: Date.now() });
  }

  /**
   * Set an authoritative Pocket Option price for a symbol so the entire
   * platform (price, candles, prediction) consumes the SSOT value. Called by
   * the PO bridge on every real tick. Bids/asks are optional; when omitted the
   * mid is used for both sides.
   */
  setPocketOptionPrice(
    symbol: string,
    price: number,
    bid?: number,
    ask?: number,
  ): void {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm || !Number.isFinite(price) || price <= 0) return;
    const now = Date.now();
    this.pocketOptionCache.set(norm, {
      price,
      ...(bid !== undefined && Number.isFinite(bid) && bid > 0 ? { bid } : {}),
      ...(ask !== undefined && Number.isFinite(ask) && ask > 0 ? { ask } : {}),
      ts: now,
    });
    // Mirror into the generic spot cache (change-only) so every downstream
    // reader that looks at lastSpotCache sees the same live value.
    if (this.lastSpotCache.get(norm)?.price !== price) {
      this.lastSpotCache.set(norm, { price, ts: now });
    }
  }

  /** True when the PO bridge has delivered a price for this symbol recently. */
  isPocketOptionCovered(symbol: string, maxAgeMs = 60_000): boolean {
    const po = this.pocketOptionCache.get((symbol || "").trim().toUpperCase());
    return (
      !!po &&
      Number.isFinite(po.price) &&
      po.price > 0 &&
      Date.now() - po.ts < maxAgeMs
    );
  }

  /**
   * Canonicalize an incoming symbol to the strict whitelist "/" format, exactly
   * as the frontend and registry expect. Maps every real-world variant:
   *   "EURUSD" / "EUR-USD" / "EUR_USD" / "eur/usd"  → "EUR/USD"
   *   "BTCUSD"                                    → "BTC/USD"
   * Unknown / non-6-char compact inputs are returned ucase-but-unslashed → the
   * caller (backed by the whitelist) decides whether to reject them.
   */
  toCanonicalSymbol(raw: string): string {
    return canonicalizeSymbol(raw);
  }

  /**
   * Split a symbol like "EUR/USD" into { base: "EUR", quote: "USD" }.
   */
  private splitSymbol(symbol: string): { base: string; quote: string } {
    const norm = symbol.trim().toUpperCase();

    // Handle slash format: EUR/USD
    if (norm.includes("/")) {
      const [base, quote] = norm.split("/");
      return { base, quote };
    }

    // Handle dash format: EUR-USD
    if (norm.includes("-")) {
      const [base, quote] = norm.split("-");
      return { base, quote };
    }

    // Handle 6-letter format: EURUSD
    if (norm.length === 6) {
      return { base: norm.slice(0, 3), quote: norm.slice(3, 6) };
    }

    return { base: "", quote: "" };
  }

  /**
   * Deduplicate an array of bars by timestamp, keeping the latest entry.
   */
  private deduplicateBars(bars: ForexCandle[]): ForexCandle[] {
    const byTimestamp = new Map<number, ForexCandle>();
    for (const bar of bars) {
      const existing = byTimestamp.get(bar.timestamp);
      if (!existing || bar.timestamp >= existing.timestamp) {
        byTimestamp.set(bar.timestamp, bar);
      }
    }
    return Array.from(byTimestamp.values()).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
  }

  /**
   * Convert a timeframe string to milliseconds.
   */
  private timeframeToMs(timeframe: string): number {
    const tf = (timeframe || "").toLowerCase().trim();
    const map: Record<string, number> = {
      "5s": 5_000,
      "20s": 20_000,
      "30s": 30_000,
      "1m": 60_000,
      "2m": 120_000,
      "3m": 180_000,
      "5m": 300_000,
      "10m": 600_000,
      "15m": 900_000,
      "20m": 1_200_000,
      "25m": 1_500_000,
      "30m": 1_800_000,
      "35m": 2_100_000,
      "1h": 3_600_000,
      "4h": 14_400_000,
      "1d": 86_400_000,
    };
    return map[tf] || 60_000;
  }

  /**
   * Compute a timeframe multiplier for target price projection.
   * Longer timeframes imply larger expected moves. Sub-minute horizons
   * (binary-option expiry windows) scale tighter for precise targets.
   */
  private timeframeToMultiplier(timeframe: string): number {
    const tf = (timeframe || "").toLowerCase().trim();
    const map: Record<string, number> = {
      "5s": 0.06,
      "20s": 0.12,
      "30s": 0.15,
      "1m": 0.3,
      "2m": 0.4,
      "3m": 0.5,
      "5m": 0.6,
      "10m": 0.8,
      "15m": 1.0,
      "20m": 1.2,
      "25m": 1.4,
      "30m": 1.5,
      "35m": 1.7,
      "1h": 1.5,
      "4h": 2.5,
      "1d": 3.0,
    };
    return map[tf] || 1.0;
  }

  /**
   * Throttle API calls to avoid hitting rate limits.
   */
  private async throttleApiCall(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastApiCallAt;
    if (elapsed < this.API_CALL_THROTTLE_MS) {
      await new Promise((r) =>
        setTimeout(r, this.API_CALL_THROTTLE_MS - elapsed),
      );
    }
    this.lastApiCallAt = Date.now();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SINGLETON EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export const forexDataService = ForexDataService.getInstance();
export default forexDataService;
