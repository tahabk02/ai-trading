/**
 * githubData.provider.ts — GITHUB DATA PROVIDER
 *
 * Periodically fetches price/tick data from a GitHub repository instead of
 * relying on Alpaca WebSocket connections or API keys. Uses raw file URLs
 * or the GitHub API to retrieve market data stored as JSON.
 *
 * Expected repository structure (configurable via env vars):
 *
 *   prices/                      (live tick snapshots, refreshed every push)
 *     ├── BTC-USD.json
 *     ├── ETH-USD.json
 *     ├── EUR-USD.json
 *     └── ...
 *
 *   candles/                     (daily OHLCV bars, historical series)
 *     ├── BTC-USD-1d.json
 *     ├── ETH-USD-1d.json
 *     └── ...
 *
 * Each live-tick JSON file:
 *   {
 *     "symbol": "BTC/USD",
 *     "price": 68421.50,
 *     "bid": 68420.00,
 *     "ask": 68423.00,
 *     "volume": 1234.5,
 *     "timestamp": "2026-09-01T12:34:56.000Z"
 *   }
 *
 * Each candle JSON file (array):
 *   [
 *     { "timestamp": 1693526400000, "open": 68000, "high": 68500,
 *       "low": 67800, "close": 68400, "volume": 54321 },
 *     ...
 *   ]
 *
 * Fallback: can also fetch a single consolidated prices.json with all symbols.
 */

import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";

// ── Types ──

export interface GitHubPriceTick {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  timestamp: string;
}

export interface GitHubCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ProviderStatus = "connected" | "disconnected" | "error";

export interface GitHubDataConfig {
  /** GitHub repo in "owner/repo" format */
  repoOwner: string;
  repoName: string;
  /** Branch to fetch from */
  branch: string;
  /** Base path within the repo for live tick files */
  tickPath: string;
  /** Base path within the repo for candle files */
  candlePath: string;
  /** Polling interval in milliseconds */
  pollingIntervalMs: number;
  /** GitHub personal access token (optional — raises rate limit) */
  token: string;
  /** GitHub API base URL (for Enterprise) */
  apiBase: string;
}

// ── Defaults ──

const DEFAULT_POLLING_MS = 5_000;
const DEFAULT_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;

/** Quiet-tape liveness heartbeat gap: when a symbol's price has NOT changed,
 *  the identical real print is re-emitted once per window so downstream stall
 *  watchdogs can tell "market is quiet" from "transport is dead". */
const HEARTBEAT_GAP_MS = 30_000;

// ── Service ──

export class GitHubDataProviderService {
  private static instance: GitHubDataProviderService;

  private config: GitHubDataConfig;
  private client: AxiosInstance;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  /** Per-symbol last-seen price deduplication (avoid re-broadcasting stale). */
  private lastSeenPrices: Map<string, number> = new Map();

  /** Per-symbol wall-clock (ms) of the last emitted tick — drives the ~30s
   *  liveness heartbeat on quiet tapes. */
  private lastEmittedAt: Map<string, number> = new Map();

  /** Callback invoked when new tick data is available. */
  private onTickCallback: ((
    symbol: string,
    price: number,
    bid: number | undefined,
    ask: number | undefined,
    volume: number,
    timestamp: string,
  ) => void) | null = null;

  /** Callback invoked on status changes. */
  private onStatusCallback: ((
    status: ProviderStatus,
    message?: string,
  ) => void) | null = null;

  /** In-memory cache of latest candles per symbol/key. */
  private candleCache: Map<string, GitHubCandle[]> = new Map();

  private constructor(config?: Partial<GitHubDataConfig>) {
    this.config = {
      repoOwner: process.env.GITHUB_DATA_REPO_OWNER || "trading-platform",
      repoName: process.env.GITHUB_DATA_REPO_NAME || "market-data",
      branch: process.env.GITHUB_DATA_BRANCH || "main",
      tickPath: process.env.GITHUB_DATA_TICK_PATH || "prices",
      candlePath: process.env.GITHUB_DATA_CANDLE_PATH || "candles",
      pollingIntervalMs: Number(process.env.GITHUB_DATA_POLL_MS) || DEFAULT_POLLING_MS,
      token: process.env.GITHUB_DATA_TOKEN || "",
      apiBase: process.env.GITHUB_DATA_API_BASE || DEFAULT_API_BASE,
      ...config,
    };

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "trading-ai-platform/1.0",
    };

    if (this.config.token) {
      headers.Authorization = `Bearer ${this.config.token}`;
    }

    this.client = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      headers,
    });
  }

  public static getInstance(config?: Partial<GitHubDataConfig>): GitHubDataProviderService {
    if (!GitHubDataProviderService.instance) {
      GitHubDataProviderService.instance = new GitHubDataProviderService(config);
    }
    return GitHubDataProviderService.instance;
  }

  // ════════════════════════════════════════════════════════════════════
  //  CALLBACKS
  // ════════════════════════════════════════════════════════════════════

  setCallbacks(callbacks: {
    onTick?: (
      symbol: string,
      price: number,
      bid: number | undefined,
      ask: number | undefined,
      volume: number,
      timestamp: string,
    ) => void;
    onStatus?: (status: ProviderStatus, message?: string) => void;
  }): void {
    if (callbacks.onTick) this.onTickCallback = callbacks.onTick;
    if (callbacks.onStatus) this.onStatusCallback = callbacks.onStatus;
  }

  // ════════════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ════════════════════════════════════════════════════════════════════

  /**
   * Start periodic polling of the GitHub repository for price data.
   */
  startPolling(): void {
    if (this.pollingTimer) {
      logger.debug("[GitHubData] Already polling");
      return;
    }

    const { repoOwner, repoName, branch, pollingIntervalMs } = this.config;
    logger.info("[GitHubData] Starting GitHub data polling", {
      repo: `${repoOwner}/${repoName}`,
      branch,
      intervalMs: pollingIntervalMs,
    });

    this.onStatusCallback?.("connected", `Polling ${repoOwner}/${repoName}@${branch}`);

    // Initial fetch
    void this.fetchAllTicks();

    this.pollingTimer = setInterval(() => {
      void this.fetchAllTicks();
    }, pollingIntervalMs);

    this.initialized = true;
  }

  /**
   * Stop polling.
   */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.lastSeenPrices.clear();
    this.lastEmittedAt.clear();
    logger.info("[GitHubData] Polling stopped");
  }

  /**
   * Whether the provider has been started.
   */
  isRunning(): boolean {
    return this.pollingTimer !== null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  TICK FETCHING
  // ════════════════════════════════════════════════════════════════════

  /**
   * Fetch all available tick files from the GitHub repo and broadcast new
   * prices to the tick pipeline. Supports two strategies:
   *
   * 1. Consolidated:  GET prices/prices.json — single file with all symbols
   * 2. Per-symbol:    GET prices/{SYMBOL}.json — one file per symbol
   *
   * Strategy 1 is preferred (fewer API calls). Strategy 2 is a fallback
   * for repos that store per-symbol files.
   */
  private async fetchAllTicks(): Promise<void> {
    try {
      const consolidatedUrl = this.buildRawUrl(
        `${this.config.tickPath}/prices.json`,
      );

      // Try consolidated first
      const consolidated = await this.tryFetchJson<GitHubPriceTick[] | Record<string, GitHubPriceTick>>(
        consolidatedUrl,
      );

      if (consolidated !== null) {
        this.processTickData(consolidated);
        return;
      }

      // Fall back to GitHub Trees API to discover available tick files
      await this.fetchPerSymbolTicks();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[GitHubData] Tick fetch failed", { error: message });
      this.onStatusCallback?.("error", `Tick fetch failed: ${message}`);
    }
  }

  /**
   * Use the GitHub Trees API to discover per-symbol JSON files in the tick
   * directory, then fetch each one.
   */
  private async fetchPerSymbolTicks(): Promise<void> {
    const { repoOwner, repoName, branch, tickPath, apiBase, token } = this.config;
    const treeUrl = `${apiBase}/repos/${repoOwner}/${repoName}/git/trees/${branch}?recursive=1`;

    try {
      const response = await this.client.get(treeUrl);
      const tree: Array<{ path: string; type: string }> = response.data?.tree ?? [];

      const tickFiles = tree.filter(
        (item) =>
          item.type === "blob" &&
          item.path.startsWith(`${tickPath}/`) &&
          item.path.endsWith(".json") &&
          !item.path.endsWith("prices.json"),
      );

      const fetchPromises = tickFiles.map(async (file) => {
        const symbolFileName = file.path.split("/").pop()?.replace(".json", "") ?? "";
        const symbol = symbolFileName.replace(/-/g, "/");
        const rawUrl = this.buildRawUrl(file.path);

        const tick = await this.tryFetchJson<GitHubPriceTick>(rawUrl);
        if (tick && tick.price > 0) {
          // Normalize symbol if the file used a dash format
          const normalizedTick: GitHubPriceTick = {
            ...tick,
            symbol: tick.symbol || symbol,
          };
          this.emitTickIfNew(normalizedTick);
        }
      });

      await Promise.allSettled(fetchPromises);

      if (tickFiles.length > 0) {
        this.onStatusCallback?.("connected", `Fetched ${tickFiles.length} tick files`);
      }
    } catch (error: unknown) {
      // Trees API may be rate-limited without auth — fall back to known symbols
      logger.debug("[GitHubData] Trees API failed, trying known symbols", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.fetchKnownSymbolTicks();
    }
  }

  /**
   * Fallback: try fetching well-known symbol tick files directly without
   * listing the repo tree. Useful when the Trees API is rate-limited.
   */
  private async fetchKnownSymbolTicks(): Promise<void> {
    const knownSymbols = [
      "BTC-USD", "ETH-USD", "EUR-USD", "GBP-USD", "USD-JPY",
      "USD-CHF", "USD-CAD", "AUD-USD", "NZD-USD", "EUR-GBP",
      "EUR-JPY", "EUR-CHF", "EUR-AUD", "EUR-CAD", "EUR-NZD",
      "EUR-TRY", "GBP-JPY", "GBP-CHF", "GBP-AUD", "GBP-CAD",
      "AUD-JPY", "CAD-JPY", "CHF-JPY", "AUD-CAD", "AUD-NZD",
      "NZD-JPY", "CAD-CHF", "EUR-RUB", "USD-TRY", "USD-ZAR",
      "USD-MXN", "USD-SGD", "MAD-USD", "KES-USD",
    ];

    const fetchPromises = knownSymbols.map(async (sym) => {
      const rawUrl = this.buildRawUrl(`${this.config.tickPath}/${sym}.json`);
      const tick = await this.tryFetchJson<GitHubPriceTick>(rawUrl);
      if (tick && tick.price > 0) {
        const symbol = sym.replace(/-/g, "/");
        this.emitTickIfNew({
          ...tick,
          symbol: tick.symbol || symbol,
        });
      }
    });

    await Promise.allSettled(fetchPromises);
  }

  /**
   * Process tick data from a consolidated prices.json response.
   * Accepts either an array or a record keyed by symbol.
   */
  private processTickData(
    data: GitHubPriceTick[] | Record<string, GitHubPriceTick>,
  ): void {
    if (Array.isArray(data)) {
      for (const tick of data) {
        if (tick && tick.price > 0) {
          this.emitTickIfNew(tick);
        }
      }
    } else if (data && typeof data === "object") {
      for (const [key, tick] of Object.entries(data)) {
        if (tick && tick.price > 0) {
          const symbol = tick.symbol || key.replace(/-/g, "/");
          this.emitTickIfNew({ ...tick, symbol });
        }
      }
    }
  }

  /**
   * Only emit a tick if the price has actually changed (deduplication),
   * EXCEPT that a persistent unchanged price is re-emitted once per quiet
   * window (~30s) as a LIVENESS HEARTBEAT.
   *
   * The dedup exists to avoid re-broadcasting the same stale price on every
   * poll cycle — but a side effect was that a genuinely quiet tape (market
   * parked for minutes) transmitted NOTHING, so the client's stall watchdog
   * could not tell "market is quiet" from "transport is dead" and force-
   * reconnected into churn. The heartbeat re-emits the identical real price
   * on a sparsely-quiet symbol so downstream liveness stays honest while the
   * dedup still silences mid-cycle repeats. Zero fabrication — it is the same
   * genuine observed print, merely repeated as a keep-alive.
   */
  private emitTickIfNew(tick: GitHubPriceTick): void {
    const symbol = (tick.symbol || "").trim().toUpperCase();
    if (!symbol || !Number.isFinite(tick.price) || tick.price <= 0) return;

    const lastPrice = this.lastSeenPrices.get(symbol);
    const now = Date.now();
    const lastEmittedAt = this.lastEmittedAt.get(symbol);

    if (lastPrice !== undefined && lastPrice === tick.price) {
      // Same price — skip UNLESS a full quiet window has elapsed since the
      // last emit. Then re-broadcast the real print as a liveness heartbeat.
      if (lastEmittedAt != null && now - lastEmittedAt < HEARTBEAT_GAP_MS) {
        return; // No change and not yet due for a heartbeat — skip
      }
    }

    this.lastSeenPrices.set(symbol, tick.price);
    this.lastEmittedAt.set(symbol, now);

    const timestamp = tick.timestamp || new Date().toISOString();
    // Only forward REAL bid/ask arms when the feed actually provides them.
    // Refuse to fabricate a zero-spread quote on the observed mid.
    const bid = Number.isFinite(tick.bid) && tick.bid > 0 ? tick.bid : undefined;
    const ask = Number.isFinite(tick.ask) && tick.ask > 0 ? tick.ask : undefined;
    const volume = Number.isFinite(tick.volume) ? tick.volume : 0;

    this.onTickCallback?.(symbol, tick.price, bid, ask, volume, timestamp);
  }

  // ════════════════════════════════════════════════════════════════════
  //  CANDLE FETCHING (historical OHLCV bars)
  // ════════════════════════════════════════════════════════════════════

  /**
   * Fetch historical candle data for a symbol from the GitHub repo.
   *
   * Tries:
   *  1. candles/{SYMBOL}-1d.json (e.g. candles/BTC-USD-1d.json)
   *  2. candles/{SYMBOL}.json (generic, no timeframe suffix)
   *  3. Returns empty array on failure (zero fabrication).
   */
  async getHistoricalCandles(
    symbol: string,
    timeframe: string = "1d",
    limit: number = 200,
  ): Promise<{ success: boolean; bars: GitHubCandle[]; source: string; error?: string }> {
    const norm = (symbol || "").trim().toUpperCase();
    const fileSymbol = norm.replace(/\//g, "-");

    // Check cache first
    const cacheKey = `${fileSymbol}:${timeframe}:${limit}`;
    const cached = this.candleCache.get(cacheKey);
    if (cached && cached.length > 0) {
      return { success: true, bars: cached.slice(-limit), source: "github_cached" };
    }

    const urls = [
      this.buildRawUrl(`${this.config.candlePath}/${fileSymbol}-${timeframe}.json`),
      this.buildRawUrl(`${this.config.candlePath}/${fileSymbol}.json`),
    ];

    for (const url of urls) {
      const bars = await this.tryFetchJson<GitHubCandle[]>(url);
      if (Array.isArray(bars) && bars.length > 0) {
        const valid = bars.filter(
          (b) =>
            b &&
            Number.isFinite(b.close) &&
            b.close > 0 &&
            Number.isFinite(b.timestamp) &&
            b.timestamp > 0,
        );
        if (valid.length > 0) {
          this.candleCache.set(cacheKey, valid.slice(-limit));
          logger.info("[GitHubData] Historical candles fetched", {
            symbol: norm,
            count: valid.length,
            source: "github_repo",
          });
          return { success: true, bars: valid.slice(-limit), source: "github_repo" };
        }
      }
    }

    return {
      success: false,
      bars: [],
      source: "github_repo",
      error: `No candle data found for ${norm} in repository`,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  HTTP HELPERS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Build a raw file URL for the configured repo/branch.
   * Uses GitHub raw content URL for direct file access.
   */
  private buildRawUrl(path: string): string {
    const { repoOwner, repoName, branch } = this.config;
    return `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${branch}/${path}`;
  }

  /**
   * Attempt to fetch and parse JSON from a URL. Returns null on failure
   * (network error, 404, parse error) — never throws.
   */
  private async tryFetchJson<T>(url: string): Promise<T | null> {
    try {
      const response = await this.client.get(url);
      if (response.status === 200 && response.data) {
        return response.data as T;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  UTILITY
  // ════════════════════════════════════════════════════════════════════

  /**
   * Get the current polling interval.
   */
  getPollingIntervalMs(): number {
    return this.config.pollingIntervalMs;
  }

  /**
   * Get the configured repo info.
   */
  getRepoInfo(): { owner: string; repo: string; branch: string } {
    return {
      owner: this.config.repoOwner,
      repo: this.config.repoName,
      branch: this.config.branch,
    };
  }

  /**
   * Get the last-seen price for a symbol (if any).
   */
  getLastPrice(symbol: string): number | null {
    return this.lastSeenPrices.get(symbol.trim().toUpperCase()) ?? null;
  }

  /**
   * Get cached candles for a symbol.
   */
  getCachedCandles(symbol: string, timeframe: string = "1d", limit: number = 200): GitHubCandle[] {
    const fileSymbol = symbol.trim().toUpperCase().replace(/\//g, "-");
    const cacheKey = `${fileSymbol}:${timeframe}:${limit}`;
    return this.candleCache.get(cacheKey) ?? [];
  }
}

// ── Singleton export ──

export const githubDataProvider = GitHubDataProviderService.getInstance();

export default githubDataProvider;
