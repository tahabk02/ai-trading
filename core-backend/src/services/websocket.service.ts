import { Server, Socket } from "socket.io";
import { logger } from "../utils/logger";
import { realtimeTickBuffer } from "./realtimeTickBuffer.service";

/** Payload contract for the high-confidence (>90%) priority notification. */
export interface HighConfidenceSignalPayload {
  symbol: string;
  signalType: "BUY" | "SELL";
  confidence: number;
  price: number;
  targetPrice: number;
  timeframe: string;
  timestamp: string;
}

export class WebSocketService {
  private static instance: WebSocketService;
  private io: Server | null = null;
  /** Guard: prevent duplicate initialize() from accumulating connection listeners */
  private initialized = false;

  private constructor() {}

  public static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService();
    }
    return WebSocketService.instance;
  }

  public initialize(io: Server) {
    // ── Guard: if already initialized, just update the io reference ──
    // This prevents duplicate `io.on('connection')` listeners that cause
    // MaxListenersExceededWarning when the method is called multiple times.
    if (this.initialized) {
      this.io = io;
      logger.debug(
        "[WebSocketService] Re-initialized (listeners already attached)",
      );
      return;
    }

    this.io = io;
    this.initialized = true;

    this.io.on("connection", (socket) => {
      logger.info("New WebSocket connection", { id: socket.id });

      socket.on("subscribe", (symbol: string) => {
        socket.join(symbol);
        logger.info("Client subscribed to symbol", { id: socket.id, symbol });
      });

      socket.on("disconnect", () => {
        logger.info("Client disconnected", { id: socket.id });
      });
    });

    logger.info("[WebSocketService] Initialized");
  }

  public broadcastSignal(signal: any) {
    if (!this.io) return;

    // Broadcast to global feed
    this.io.emit("new_signal", signal);

    // Broadcast to specific symbol room
    this.io.to(signal.symbol).emit("symbol_update", signal);

    logger.info("Signal broadcasted via WS", { symbol: signal.symbol });
  }

  /**
   * REPLAY-ON-JOIN — seed a freshly joined (or re-joined) socket with the
   * backend's REAL 2000-tick ring for the symbol BEFORE the live feed
   * continues.
   *
   * This closes the chart's continuity gap between "last tick before the
   * disconnect" and "first live tick after": without it a reconnecting client
   * waits for the feed to move again and its series silently blanks. Zero
   * synthetic data — the ring only ever holds genuine observed prices. A
   * symbol with no real ticks yet emits NOTHING (the client stays honest
   * rather than painting fake history).
   */
  public replayHistory(socket: Socket, symbol: string): void {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm) return;

    const window = realtimeTickBuffer.getRecentWindow(norm, 2000);
    if (window.length === 0) return;

    socket.emit("history", {
      symbol: norm,
      count: window.length,
      ticks: window.map((t) => ({
        symbol: norm,
        price: t.price,
        timestamp: t.tsMs,
        ...(t.bid !== undefined ? { bid: t.bid } : {}),
        ...(t.ask !== undefined ? { ask: t.ask } : {}),
      })),
    });

    logger.info("[WebSocketService] Replayed real tick ring to subscriber", {
      symbol: norm,
      count: window.length,
    });
  }

  /**
   * Broadcast a strict 100% real live market tick to subscribed clients.
   * Zero synthetic data. Strictly real-time price feeds.
   *
   * SINGLE-CHANNEL CONTRACT: ticks are emitted ONLY on the dedicated
   * `live_tick` event. The previous implementation ALSO re-emitted the
   * identical payload on `symbol_update`, causing clients to ingest every
   * tick TWICE into their candle aggregator (duplicated volume folding,
   * doubled repaint work under high-frequency streams).
   * `symbol_update` remains reserved for prediction/signal payloads.
   */
  public broadcastLiveTick(tick: {
    symbol: string;
    price: number;
    timestamp: string;
    bid?: number;
    ask?: number;
    volume?: number;
  }) {
    if (!this.io) return;

    // Dedicated real-time tick channel — exactly once per tick
    this.io.to(tick.symbol).emit("live_tick", tick);

    logger.debug("[WebSocketService] Live tick broadcasted", {
      symbol: tick.symbol,
      price: tick.price,
    });
  }

  /**
   * Broadcast engine status (ONLINE / DEGRADED / OFFLINE) to all connected clients.
   * The frontend switches its "Engine Status" indicator based on this event.
   */
  public broadcastEngineStatus(
    status: "ONLINE" | "DEGRADED" | "OFFLINE",
    message?: string,
  ) {
    if (!this.io) return;

    this.io.emit("engine_status", {
      status,
      message: message ?? `Engine is ${status}`,
      timestamp: new Date().toISOString(),
    });

    logger.info("[WebSocketService] Engine status broadcast", {
      status,
      message,
    });
  }

  /**
   * Broadcast a live aggregated candle (1s / 1m / PO M20) to subscribed symbol
   * rooms. Carries the exact OHLC of the forming/closed bar so the frontend
   * chart renders the SAME structure the live tape produces — no local drift.
   */
  public broadcastCandle(candle: {
    symbol: string;
    timeframe: string;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    closed: boolean;
  }) {
    if (!this.io) return;

    this.io.to(candle.symbol).emit("candle", {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      closed: candle.closed,
    });
  }

  /**
   * HIGH-CONFIDENCE SIGNAL EVENT — background WS broadcast fired whenever a
   * dispatched signal's confidence exceeds the production threshold (90%).
   * The frontend renders a high-priority professional toast with an alert
   * sound on receipt of `high_confidence_signal`.
   */
  public broadcastHighConfidenceSignal(payload: HighConfidenceSignalPayload) {
    if (!this.io) return;

    // Global priority channel + symbol room for subscribed clients
    this.io.emit("high_confidence_signal", payload);
    this.io.to(payload.symbol).emit("high_confidence_signal", payload);

    logger.info("[WebSocketService] High-confidence signal broadcast", {
      symbol: payload.symbol,
      signalType: payload.signalType,
      confidence: payload.confidence,
    });
  }

  /**
   * LIVE QUANT SIGNAL EVENT — high-frequency confluence verdicts streamed by
   * the /tick-signal forwarder (liveTickSignal.dispatch). Emitted on the
   * dedicated `live_quant_signal` room event so the 1Hz live scorer never
   * spams the global feed / priority toast channel (both stay reserved for
   * full /predict signals and REAL >=96.5% DEFINITIVE broadcasts).
   */
  public broadcastLiveQuantSignal(payload: {
    symbol: string;
    signalType: "BUY" | "SELL" | null;
    signal: "BUY" | "SELL" | null;
    confidence: number;
    current_price?: number;
    target_price?: number;
    timeframe: string;
    market_waiting?: boolean;
    waiting_reason?: string | null;
    waiting_detail?: string | null;
    book_confluence?: number | null;
    dataSource?: string;
    aiEngine?: unknown;
    timestamp?: string;
  }) {
    if (!this.io) return;
    this.io.to(payload.symbol).emit("live_quant_signal", payload);
  }
}

// ── Singleton export ──
export const websocketService = WebSocketService.getInstance();
