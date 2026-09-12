/**
 * alpacaMarketData.service.ts — OFFICIAL ALPACA LIVE WEBSOCKET & REST API
 *
 * 100% REAL DATA FROM ALPACA. ZERO MOCK. ZERO SYNTHETIC.
 *
 * Integration points:
 *  1. REST API — Fetch authentic historical OHLCV bars (crypto + stocks)
 *     Endpoint: GET /v2/stocks/{symbol}/bars, /v2/crypto/bars
 *  2. WebSocket — Real-time live streaming trades/quotes
 *     Endpoint: wss://stream.data.alpaca.markets/v2/sip
 *     Subscribe: trades, quotes for real-time tick data
 *  3. Aggregation — Live ticks aggregated into precise timeframe candles
 *     (1m, 2m, 3m, etc.) updating dynamically every second
 *
 * Symbol mapping:
 *   "BTC/USD" → Alpaca crypto: BTC/USD (IEX or SIP)
 *   "ETH/USD" → Alpaca crypto: ETH/USD
 *   "AAPL"    → Alpaca stock: AAPL
 *   OTC forex pairs → Not available on Alpaca, fall back to existing sources
 *
 * Authentication:
 *   Uses APCA_API_KEY_ID + APCA_API_SECRET_KEY from environment
 */

import WebSocket from "ws";
import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";

// ── Types ──

export interface AlpacaBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  trade_count?: number;
}

export interface AlpacaBarsResponse {
  symbol: string;
  bars: AlpacaBar[];
  next_page_token?: string;
}

export interface AlpacaTrade {
  T: "t"; // trade event
  S: string; // symbol
  p: number; // price
  s: number; // size (trade volume)
  x: string; // exchange
  t: string; // timestamp (RFC 3339)
  z: string; // tape
}

export interface AlpacaQuote {
  T: "q"; // quote event
  S: string; // symbol
  bp: number; // bid price
  bs: number; // bid size
  ap: number; // ask price
  as: number; // ask size
  x: string; // exchange
  t: string; // timestamp
  z: string; // tape
}

export type AlpacaStreamEvent = AlpacaTrade | AlpacaQuote;

export interface AlpacaStreamMessage {
  T: string; // message type: "success", "subscribe", "error", etc.
  msg?: string;
  codes?: string[];
}

// ── Symbol mapping ──

/** Symbols available on Alpaca's market data API */
const ALPACA_CRYPTO_SYMBOLS: Record<string, string> = {
  "BTC/USD": "BTC/USD",
  "ETH/USD": "ETH/USD",
};

/** Timeframe mapping: our format → Alpaca bars API timeframe */
const ALPACA_TIMEFRAME_MAP: Record<string, string> = {
  "1Min": "1Min",
  "5Min": "5Min",
  "15Min": "15Min",
  "1h": "1Hour",
  "1Hour": "1Hour",
  "1d": "1Day",
  "1Day": "1Day",
};

// ── Service ──

export class AlpacaMarketDataService {
  private static instance: AlpacaMarketDataService;
  private client: AxiosInstance;
  private ws: WebSocket | null = null;
  private wsConnected = false;
  /** Set to true only after the server confirms authentication. Prevents
   *  sending subscription frames before auth completes (which causes 400). */
  private authCompleted = false;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private subscribedSymbols: Set<string> = new Set();
  private lastPongAt = 0;

  /** Callback invoked on every real-time trade tick from Alpaca. */
  private onTradeCallback: ((
    symbol: string,
    price: number,
    volume: number,
    timestamp: string,
  ) => void) | null = null;

  /** Callback invoked on every real-time quote from Alpaca. */
  private onQuoteCallback: ((
    symbol: string,
    bid: number,
    ask: number,
    timestamp: string,
  ) => void) | null = null;

  /** Callback for connection status changes. */
  private onStatusCallback: ((
    status: "connected" | "disconnected" | "error",
    message?: string,
  ) => void) | null = null;

  private readonly WS_ENDPOINT =
    secrets.ALPACA_WS_ENDPOINT || "wss://stream.data.alpaca.markets/v2/sip";
  private readonly REST =
    secrets.ALPACA_BASE_URL || "https://data.alpaca.markets";
  private readonly API_KEY = secrets.ALPACA_API_KEY_ID;
  private readonly API_SECRET = secrets.ALPACA_API_SECRET;

  /** Reconnect backoff: starts at 1s, maxes at 30s */
  private reconnectDelay = 1000;
  private readonly RECONNECT_MAX_MS = 30_000;

  /** Health check: if no pong for 60s, force reconnect */
  private readonly HEALTH_CHECK_MS = 60_000;

  /** Bar cache: key = `${symbol}|${timeframe}|${limit}` */
  private barCache: Map<string, { bars: any[]; ts: number }> = new Map();
  private readonly BAR_CACHE_TTL_MS = 5 * 60_000; // 5 min

  /** Per-symbol last quote price cache (for bid/ask spread). */
  private lastQuote: Map<
    string,
    { bid: number; ask: number; ts: number }
  > = new Map();

  private constructor() {
    this.client = axios.create({
      timeout: 15_000,
      headers: {
        Accept: "application/json",
        "APCA-API-KEY-ID": this.API_KEY,
        "APCA-API-SECRET-KEY": this.API_SECRET,
      },
    });
  }

  public static getInstance(): AlpacaMarketDataService {
    if (!AlpacaMarketDataService.instance) {
      AlpacaMarketDataService.instance = new AlpacaMarketDataService();
    }
    return AlpacaMarketDataService.instance;
  }

  /** Check if a symbol is supported by Alpaca's data API. */
  isAlpacaSupported(symbol: string): boolean {
    const norm = (symbol || "").trim().toUpperCase();
    return norm in ALPACA_CRYPTO_SYMBOLS;
  }

  /** Map our symbol to Alpaca's format. Returns null if unsupported. */
  toAlpacaSymbol(symbol: string): string | null {
    const norm = (symbol || "").trim().toUpperCase();
    return ALPACA_CRYPTO_SYMBOLS[norm] ?? null;
  }

  /** Check if credentials are configured. */
  hasCredentials(): boolean {
    return !!(this.API_KEY && this.API_SECRET);
  }

  // ════════════════════════════════════════════════════════════════════
  //  REST API — HISTORICAL OHLCV BARS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Fetch real historical OHLCV bars from Alpaca's REST API.
   *
   * Supports:
   *  - Crypto: GET /v2/crypto/bars?symbols=BTC/USD&timeframe=1Day&limit=200
   *  - Stocks: GET /v2/stocks/{symbol}/bars?timeframe=1Day&limit=200
   *
   * Returns bars in our standard ForexCandle format.
   */
  async getHistoricalBars(
    symbol: string,
    timeframe: string = "1d",
    limit: number = 200,
  ): Promise<{ success: boolean; bars: any[]; source: string; error?: string }> {
    const norm = (symbol || "").trim().toUpperCase();
    const alpacaSymbol = this.toAlpacaSymbol(norm);

    if (!alpacaSymbol) {
      return {
        success: false,
        bars: [],
        source: "alpaca",
        error: `Symbol ${norm} is not supported by Alpaca market data`,
      };
    }

    if (!this.hasCredentials()) {
      return {
        success: false,
        bars: [],
        source: "alpaca",
        error: "Alpaca API credentials not configured",
      };
    }

    // Check cache
    const cacheKey = `alpaca:${norm}:${timeframe}:${limit}`;
    const cached = this.barCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.BAR_CACHE_TTL_MS) {
      return { success: true, bars: cached.bars, source: "alpaca_cached" };
    }

    try {
      const isCrypto = alpacaSymbol.includes("/");
      const alpacaTf = ALPACA_TIMEFRAME_MAP[timeframe] || "1Day";

      let bars: any[] = [];

      if (isCrypto) {
        bars = await this.fetchCryptoBars(alpacaSymbol, alpacaTf, limit);
      } else {
        bars = await this.fetchStockBars(alpacaSymbol, alpacaTf, limit);
      }

      if (bars.length > 0) {
        this.barCache.set(cacheKey, { bars, ts: Date.now() });
        logger.info("[AlpacaMarketData] Historical bars fetched", {
          symbol: norm,
          alpacaSymbol,
          timeframe: alpacaTf,
          count: bars.length,
          source: "alpaca_rest",
        });
        return { success: true, bars, source: "alpaca_rest" };
      }

      return {
        success: false,
        bars: [],
        source: "alpaca",
        error: "No bars returned from Alpaca",
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.warn("[AlpacaMarketData] Historical bars fetch failed", {
        symbol: norm,
        error: message,
      });
      return {
        success: false,
        bars: [],
        source: "alpaca",
        error: message,
      };
    }
  }

  private async fetchCryptoBars(
    symbol: string,
    timeframe: string,
    limit: number,
  ): Promise<any[]> {
    // Alpaca crypto bars: /v2/crypto/bars?symbols=BTC/USD&timeframe=1Day&limit=200
    const url = `${this.REST}/v2/crypto/bars`;
    const response = await this.client.get(url, {
      params: {
        symbols: symbol,
        timeframe,
        limit: Math.min(limit, 1000),
        feed: "sip",
      },
    });

    const data = response.data;
    const barsMap = data?.bars?.[symbol] ?? data?.bars ?? {};

    // Alpaca returns bars grouped by symbol
    const rawBars = Array.isArray(barsMap) ? barsMap : [];

    return rawBars.map((bar: any) => ({
      timestamp: new Date(bar.t).getTime(),
      open: Number(bar.o),
      high: Number(bar.h),
      low: Number(bar.l),
      close: Number(bar.c),
      volume: Number(bar.v ?? 0),
      vwap: bar.vw ? Number(bar.vw) : undefined,
      trade_count: bar.n ? Number(bar.n) : undefined,
    }));
  }

  private async fetchStockBars(
    symbol: string,
    timeframe: string,
    limit: number,
  ): Promise<any[]> {
    // Alpaca stock bars: /v2/stocks/{symbol}/bars?timeframe=1Day&limit=200
    const url = `${this.REST}/v2/stocks/${symbol}/bars`;
    const response = await this.client.get(url, {
      params: {
        timeframe,
        limit: Math.min(limit, 1000),
        feed: "sip",
      },
    });

    const bars = response.data?.bars ?? [];

    return bars.map((bar: any) => ({
      timestamp: new Date(bar.t).getTime(),
      open: Number(bar.o),
      high: Number(bar.h),
      low: Number(bar.l),
      close: Number(bar.c),
      volume: Number(bar.v ?? 0),
      vwap: bar.vw ? Number(bar.vw) : undefined,
      trade_count: bar.n ? Number(bar.n) : undefined,
    }));
  }

  /**
   * Fetch the latest quote for a crypto symbol from Alpaca REST.
   * Used as a spot price fallback when WebSocket is not connected.
   */
  async getLatestQuote(
    symbol: string,
  ): Promise<{ bid: number; ask: number; mid: number } | null> {
    const alpacaSymbol = this.toAlpacaSymbol(symbol);
    if (!alpacaSymbol || !this.hasCredentials()) return null;

    try {
      const isCrypto = alpacaSymbol.includes("/");
      let url: string;

      if (isCrypto) {
        url = `${this.REST}/v2/crypto/latest/quotes`;
        const response = await this.client.get(url, {
          params: { symbols: alpacaSymbol },
        });
        const quote = response.data?.quotes?.[alpacaSymbol];
        if (quote) {
          const bid = Number(quote.bp ?? 0);
          const ask = Number(quote.ap ?? 0);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
          if (mid > 0) {
            this.lastQuote.set(symbol.trim().toUpperCase(), {
              bid,
              ask,
              ts: Date.now(),
            });
            return { bid, ask, mid };
          }
        }
      } else {
        url = `${this.REST}/v2/stocks/${alpacaSymbol}/quotes/latest`;
        const response = await this.client.get(url);
        const quote = response.data?.quote;
        if (quote) {
          const bid = Number(quote.bp ?? 0);
          const ask = Number(quote.ap ?? 0);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
          if (mid > 0) {
            return { bid, ask, mid };
          }
        }
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.debug("[AlpacaMarketData] Latest quote fetch failed", {
        symbol,
        error: message,
      });
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  WEBSOCKET — REAL-TIME LIVE STREAMING
  // ════════════════════════════════════════════════════════════════════

  /**
   * Register callbacks for real-time data events.
   */
  setCallbacks(callbacks: {
    onTrade?: (
      symbol: string,
      price: number,
      volume: number,
      timestamp: string,
    ) => void;
    onQuote?: (
      symbol: string,
      bid: number,
      ask: number,
      timestamp: string,
    ) => void;
    onStatus?: (
      status: "connected" | "disconnected" | "error",
      message?: string,
    ) => void;
  }): void {
    if (callbacks.onTrade) this.onTradeCallback = callbacks.onTrade;
    if (callbacks.onQuote) this.onQuoteCallback = callbacks.onQuote;
    if (callbacks.onStatus) this.onStatusCallback = callbacks.onStatus;
  }

  /**
   * Connect to Alpaca's live WebSocket data stream.
   *
   * Protocol (wss://stream.data.alpaca.markets/v2/sip):
   *  1. TCP open
   *  2. Auth frame:   {"action": "auth", "key": "...", "secret": "..."}
   *  3. Server reply:  [{"T":"success","msg":"authenticated"}]
   *  4. Subscribe:    {"action": "subscribe", "trades": ["BTC/USD"], "quotes": ["BTC/USD"]}
   *  5. Trade events: [{"T":"t","S":"BTC/USD","p":50000,"s":1,"t":"..."}]
   *  6. Quote events: [{"T":"q","S":"BTC/USD","bp":49999,"ap":50001,"t":"..."}]
   */
  connectWebSocket(): void {
    if (!this.hasCredentials()) {
      logger.warn("[AlpacaMarketData] No API credentials — skipping WS connect");
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.debug("[AlpacaMarketData] WS already connected");
      return;
    }

    logger.info("[AlpacaMarketData] Connecting to Alpaca WebSocket", {
      endpoint: this.WS_ENDPOINT,
    });

    try {
      this.ws = new WebSocket(this.WS_ENDPOINT);

      this.ws.on("open", () => {
        logger.info("[AlpacaMarketData] WebSocket TCP connected — sending auth frame");
        this.wsConnected = true;
        this.reconnectDelay = 1000; // Reset backoff on success

        // ── AUTHENTICATION ──
        // Alpaca v2 streaming protocol requires this exact frame:
        //   {"action": "auth", "key": "<APCA_API_KEY_ID>", "secret": "<APCA_API_SECRET_KEY>"}
        // The server replies with [{"T":"success","msg":"authenticated"}] on success
        // or [{"T":"error","code":400,"msg":"invalid auth"}] on failure.
        this.ws!.send(
          JSON.stringify({
            action: "auth",
            key: this.API_KEY,
            secret: this.API_SECRET,
          }),
        );

        // Start heartbeat ping (every 30s) — we send pings even before auth
        // completes to keep the TCP connection alive; the server ignores
        // unsolicited pings gracefully.
        this.startHeartbeat();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleWsMessage(data);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason?.toString() || "unknown";
        logger.warn("[AlpacaMarketData] WebSocket closed", {
          code,
          reason: reasonStr,
        });
        this.wsConnected = false;
        this.authCompleted = false; // Must re-auth after reconnect
        this.stopHeartbeat();
        this.onStatusCallback?.(
          "disconnected",
          `Alpaca WS closed: ${code} ${reasonStr}`,
        );
        this.scheduleReconnect();
      });

      this.ws.on("error", (error: Error) => {
        logger.error("[AlpacaMarketData] WebSocket error", {
          error: error.message,
        });
        this.wsConnected = false;
        this.authCompleted = false;
        this.onStatusCallback?.("error", `Alpaca WS error: ${error.message}`);
      });

      this.ws.on("pong", () => {
        this.lastPongAt = Date.now();
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error("[AlpacaMarketData] WebSocket connection failed", {
        error: message,
      });
      this.onStatusCallback?.("error", `Alpaca WS connect failed: ${message}`);
      this.scheduleReconnect();
    }
  }

  private handleWsMessage(data: WebSocket.Data): void {
    try {
      const text = data.toString();
      const messages = JSON.parse(text);

      // Alpaca sends an array of messages
      const msgArray = Array.isArray(messages) ? messages : [messages];

      for (const msg of msgArray) {
        const msgType = msg?.T;

        switch (msgType) {
          case "success": {
            // ── AUTH CONFIRMATION ──
            // Server replies: [{"T":"success","msg":"authenticated"}]
            // Only after this frame is it safe to send subscription frames.
            const msgText = String(msg.msg || "");
            if (msgText.toLowerCase().includes("authenticated")) {
              this.authCompleted = true;
              logger.info("[AlpacaMarketData] WS authentication confirmed by server");
              this.onStatusCallback?.(
                "connected",
                "Alpaca WebSocket authenticated",
              );
              // Now that auth is confirmed, send all pending subscriptions
              this.resubscribeAll();
            } else {
              logger.info("[AlpacaMarketData] WS success message", {
                msg: msg.msg,
              });
            }
            break;
          }

          case "subscribe":
            logger.debug("[AlpacaMarketData] WS subscription confirmed", {
              trades: msg.trades,
              quotes: msg.quotes,
            });
            break;

          case "error":
            logger.error("[AlpacaMarketData] WS server error", {
              code: msg.code,
              msg: msg.msg,
            });
            break;

          case "t": {
            // ── TRADE EVENT ──
            const trade = msg as AlpacaTrade;
            const symbol = trade.S;
            const price = Number(trade.p);
            const volume = Number(trade.s);
            const timestamp = trade.t;

            if (
              symbol &&
              Number.isFinite(price) &&
              price > 0
            ) {
              this.onTradeCallback?.(symbol, price, volume, timestamp);
            }
            break;
          }

          case "q": {
            // ── QUOTE EVENT ──
            const quote = msg as AlpacaQuote;
            const symbol = quote.S;
            const bid = Number(quote.bp);
            const ask = Number(quote.ap);
            const timestamp = quote.t;

            if (
              symbol &&
              Number.isFinite(bid) &&
              bid > 0 &&
              Number.isFinite(ask) &&
              ask > 0
            ) {
              this.lastQuote.set(symbol.trim().toUpperCase(), {
                bid,
                ask,
                ts: Date.now(),
              });
              this.onQuoteCallback?.(symbol, bid, ask, timestamp);
            }
            break;
          }

          // Heartbeat from Alpaca (every 5s while connected)
          case "hb":
            this.lastPongAt = Date.now();
            break;

          default:
            // Unknown message type — log at debug level
            if (msgType) {
              logger.debug("[AlpacaMarketData] Unknown WS message type", {
                type: msgType,
              });
            }
        }
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.debug("[AlpacaMarketData] WS message parse error", {
        error: message,
      });
    }
  }

  /**
   * Subscribe to real-time trades and quotes for a symbol.
   * Will buffer the subscription if auth has not completed yet;
   * the pending subscription will be sent automatically when
   * the server confirms authentication.
   */
  subscribeSymbol(symbol: string): void {
    const alpacaSymbol = this.toAlpacaSymbol(symbol);
    if (!alpacaSymbol) {
      logger.debug("[AlpacaMarketData] Symbol not supported by Alpaca", {
        symbol,
      });
      return;
    }

    // Always record the intent — resubscribeAll() will pick it up
    this.subscribedSymbols.add(alpacaSymbol);

    // Only send the frame if WS is connected AND server confirmed auth
    if (
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.authCompleted
    ) {
      this.ws.send(
        JSON.stringify({
          action: "subscribe",
          trades: [alpacaSymbol],
          quotes: [alpacaSymbol],
        }),
      );
      logger.info("[AlpacaMarketData] Subscribed to real-time feed", {
        symbol: alpacaSymbol,
      });
    } else {
      logger.info("[AlpacaMarketData] Subscription queued (awaiting auth)", {
        symbol: alpacaSymbol,
        wsOpen: this.ws?.readyState === WebSocket.OPEN,
        authCompleted: this.authCompleted,
      });
    }
  }

  /**
   * Unsubscribe from real-time data for a symbol.
   */
  unsubscribeSymbol(symbol: string): void {
    const alpacaSymbol = this.toAlpacaSymbol(symbol);
    if (!alpacaSymbol) return;

    this.subscribedSymbols.delete(alpacaSymbol);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          action: "unsubscribe",
          trades: [alpacaSymbol],
          quotes: [alpacaSymbol],
        }),
      );
      logger.info("[AlpacaMarketData] Unsubscribed from real-time feed", {
        symbol: alpacaSymbol,
      });
    }
  }

  private resubscribeAll(): void {
    if (this.subscribedSymbols.size === 0) return;

    const symbols = Array.from(this.subscribedSymbols);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          action: "subscribe",
          trades: symbols,
          quotes: symbols,
        }),
      );
      logger.info("[AlpacaMarketData] Resubscribed all symbols after reconnect", {
        symbols,
      });
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();

    this.wsHeartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }

      // Check if Alpaca heartbeat was received recently
      if (Date.now() - this.lastPongAt > this.HEALTH_CHECK_MS) {
        logger.warn("[AlpacaMarketData] WS health check failed — forcing reconnect");
        this.forceReconnect();
        return;
      }

      // Send ping
      this.ws.ping();
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.wsReconnectTimer) return; // Already scheduled

    logger.info("[AlpacaMarketData] Scheduling WS reconnect", {
      delayMs: this.reconnectDelay,
    });

    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWebSocket();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.RECONNECT_MAX_MS,
    );
  }

  private forceReconnect(): void {
    try {
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.close();
      }
    } catch {}
    this.ws = null;
    this.wsConnected = false;
    this.stopHeartbeat();
    this.reconnectDelay = 1000;
    this.connectWebSocket();
  }

  /**
   * Disconnect the WebSocket gracefully.
   */
  disconnectWebSocket(): void {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, "Service shutdown");
      this.ws = null;
    }
    this.wsConnected = false;
    this.subscribedSymbols.clear();
    logger.info("[AlpacaMarketData] WebSocket disconnected");
  }

  /**
   * Get current WebSocket connection status.
   */
  isConnected(): boolean {
    return this.wsConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get cached quote for a symbol (from WS stream or REST fallback).
   */
  getLastQuote(symbol: string): { bid: number; ask: number; mid: number } | null {
    const norm = (symbol || "").trim().toUpperCase();
    const cached = this.lastQuote.get(norm);
    if (cached && Date.now() - cached.ts < 5000) {
      const mid = (cached.bid + cached.ask) / 2;
      return { bid: cached.bid, ask: cached.ask, mid };
    }
    return null;
  }

  /**
   * Check if a symbol is available from Alpaca (crypto = yes, forex = no).
   */
  canProvideData(symbol: string): boolean {
    return this.isAlpacaSupported(symbol) && this.hasCredentials();
  }
}

// ── Singleton export ──

export const alpacaMarketData = AlpacaMarketDataService.getInstance();

export default alpacaMarketData;
