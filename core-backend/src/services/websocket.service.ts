import { Server, Socket } from "socket.io";
import { logger } from "../utils/logger";
import { canonicalizeSymbol } from "../utils/symbolFormat";
import { realtimeTickBuffer } from "./realtimeTickBuffer.service";
import { realtimeCandleAggregatorService } from "./realtimeCandleAggregator.service";

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

/**
 * feed_status event payload (MASTER MISSION part 2 contract):
 * `status`: mission feed state, `symbols`: the platform instrument universe,
 * `last_tick_ts`: newest REAL tick timestamp across all symbols (ISO), plus
 * the bridge heartbeat fields {lastHeartbeatTs, heartbeatAgeMs, timestamp}.
 */
export interface FeedStatusPayload {
  status:
    | "live"
    | "stalled"
    | "disconnected"
    | "awaiting_ssid"
    | "auth_failed"
    | "degraded";
  symbols: { symbol: string; name: string; type: string }[];
  last_tick_ts?: string;
  lastHeartbeatTs?: number;
  heartbeatAgeMs: number;
  timestamp: string;
}

/**
 * Pure builder for the feed_status payload — kept exported so the
 * on-connect emission contract is unit-testable without a live socket.
 */
export function buildFeedStatusPayload(
  status: FeedStatusPayload["status"],
  opts: {
    symbols: { symbol: string; name: string; type: string }[];
    lastTickTs?: string;
    lastHeartbeatTs?: number;
    heartbeatAgeMs?: number;
  },
): FeedStatusPayload {
  return {
    status,
    symbols: opts.symbols,
    last_tick_ts: opts.lastTickTs,
    lastHeartbeatTs: opts.lastHeartbeatTs,
    heartbeatAgeMs: opts.heartbeatAgeMs ?? 0,
    timestamp: new Date().toISOString(),
  };
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

      socket.on("subscribe", (payload: unknown) => {
        // Modern clients send { symbol, timeframe }; legacy clients send a bare
        // symbol string. This minimal listener only maintains the raw symbol
        // room (the canonical join + timeframe room live in index.ts) — and it
        // must never throw on the object shape.
        const symbol =
          typeof payload === "string"
            ? payload
            : (payload as { symbol?: string } | null)?.symbol;
        if (typeof symbol === "string" && symbol.trim()) {
          socket.join(symbol.trim());
          logger.info("Client subscribed to symbol", {
            id: socket.id,
            symbol: symbol.trim(),
          });
        }
      });

      socket.on("disconnect", () => {
        logger.info("Client disconnected", { id: socket.id });
      });
    });

    logger.info("[WebSocketService] Initialized");
  }

  /**
   * True when at least ONE live client is currently joined to the symbol's room
   * (e.g. a subscribed chart). Used to throttle expensive per-symbol compute
   * (the AI Engine's live-quant scorer) to symbols the user is actually
   * watching — instead of every auto-started pair on boot.
   */
  public hasActiveSubscribers(symbol: string): boolean {
    const server = this.io;
    if (!server) return false;
    try {
      const room = server.sockets.adapter.rooms.get(symbol);
      return !!room && room.size > 0;
    } catch {
      return false;
    }
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
   *
   * AGGREGATOR FEED: every tick is also fed to the server-side realtime
   * candle aggregator (single choke point). The aggregator MUST accumulate
   * before the io guard so closed bars are always available for replay on
   * subscribe, even when no clients are currently attached.
   */
  public broadcastLiveTick(tick: {
    symbol: string;
    price: number;
    timestamp: string;
    bid?: number;
    ask?: number;
    volume?: number;
  }) {
    // ── SINGLE CANONICAL KEY PER SYMBOL ──
    // Canonicalize the tick symbol ONCE at the broadcast boundary, then drive
    // BOTH the candle aggregator and the Socket.IO room from the SAME key. A
    // single provider emitting a bare compact form ("EURUSD") while clients
    // join the "/"-form room would otherwise fork every pair into two keys —
    // ticks broadcast into a "EURUSD" room no client joined, and buckets
    // accumulated under a symbol the chart never reads. The canonical "/" form
    // is exactly the room + bucket key every other layer already agrees on.
    const canonical = canonicalizeSymbol(tick?.symbol);
    if (!canonical) return;

    // ── Feed the server candle aggregator (single choke point) ──
    // PO ticks carry a broker-clock timestamp (~7200s ahead of real UTC).
    // Bucketing anchors on this clock for grid parity; the aggregator
    // tracks its own clockOffsetMs for wall-clock close sweeps.
    const tsMs = Date.parse(tick.timestamp);
    if (Number.isFinite(tsMs) && tsMs > 0) {
      realtimeCandleAggregatorService.addTick(
        canonical,
        tick.price,
        tsMs,
        tick.volume,
      );
    }

    if (!this.io) return;

    // Dedicated real-time tick channel — exactly once per tick, room keyed to
    // the canonical symbol so the joined client always receives it.
    this.io.to(canonical).emit("live_tick", { ...tick, symbol: canonical });

    logger.debug("[WebSocketService] Live tick broadcasted", {
      symbol: canonical,
      price: tick.price,
    });
  }

  /**
   * CANDLE PARITY ALERT — emitted when a symbol keeps receiving real ticks but
   * the aggregator's bucket rings are NOT advancing for it (a raw tick with no
   * active bucket increment: clock-anchor discontinuity, symbol fork, or a
   * wedge in the aggregation state machine). Mirrors the honest tick/bucket
   * parity counters the aggregator maintains, so a flat-line chart announces
   * itself instead of silently rendering a dead axis.
   */
  public broadcastCandleParity(alert: {
    symbol: string;
    timeframe: string | null;
    ticks: number;
    writes: number;
    tickDelta: number;
    writeDelta: number;
  }) {
    if (!this.io) return;
    this.io.to(alert.symbol).emit("candle_parity", alert);
    logger.error("[CandleParity] Parity breach — raw ticks without bucket advance", {
      symbol: alert.symbol,
      timeframe: alert.timeframe ?? "(all)",
      ticks: alert.ticks,
      writes: alert.writes,
      tickDelta: alert.tickDelta,
      writeDelta: alert.writeDelta,
    });
  }

  /**
   * Broadcast feed status (the SINGLE source of truth for the client's badge).
   * Emitted on the dedicated `feed_status` event. `status` is one of the
   * mission contract states: live | stalled | disconnected | awaiting_ssid |
   * auth_failed | degraded. `heartbeatAgeMs` lets the client apply its own
   * heartbeat-age rule if the socket stalls between frames.
   */
  public broadcastFeedStatus(
    status:
      | "live"
      | "stalled"
      | "disconnected"
      | "awaiting_ssid"
      | "auth_failed"
      | "degraded",
    detail?: { lastHeartbeatTs?: number; heartbeatAgeMs?: number },
  ) {
    if (!this.io) return;
    this.io.emit("feed_status", {
      status,
      lastHeartbeatTs: detail?.lastHeartbeatTs ?? Date.now(),
      heartbeatAgeMs: detail?.heartbeatAgeMs ?? 0,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Emit feed_status to a single freshly-connected socket (MASTER MISSION
   * part 2). Same contract as broadcastFeedStatus but targeted, and enriched
   * with the instrument universe (`symbols`) + the newest real tick timestamp
   * (`last_tick_ts`) so a client can paint its feed badge immediately without
   * waiting for the first broadcast.
   */
  public emitFeedStatusTo(
    socket: Socket,
    payload: FeedStatusPayload,
  ): void {
    socket.emit("feed_status", payload);
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
   * Broadcast a live aggregated candle to the EXACT (symbol, timeframe) room.
   * Each client subscribes on `{ symbol, timeframe }` and joins
   * `${symbol}:${timeframe}`, so a 10s (M10) panel receives only its own
   * resolution's closed bars — zero cross-contamination between chart buckets
   * sharing the same symbol room.
   */
  public broadcastCandle(candle: {
    symbol: string;
    timeframe: string;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    closed: boolean;
  }) {
    if (!this.io) return;

    const room = `${candle.symbol}:${candle.timeframe}`;
    this.io.to(room).emit("candle", {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume:
        Number.isFinite(candle.volume) && (candle.volume as number) > 0
          ? candle.volume
          : undefined,
      closed: candle.closed,
    });
  }

  /**
   * REPLAY-ON-JOIN (candles) — seed a freshly joined (or re-joined) socket with
   * the server aggregator's authoritative CLOSED candles for the EXACT
   * (symbol, activeChartTimeframe) resolution the client requested on
   * subscribe. Pairs with `replayHistory` (2000-tick ring): the tick ring keeps
   * the client's intra-frame builder painting the CURRENT bar, while this burst
   * supplies the already-closed candle bars so the chart axis never waits for
   * the next close. A symbol with no closed candles yet emits NOTHING (honest
   * empty history — the client falls back to its prediction-history path).
   */
  public replayCandleHistory(
    socket: Socket,
    symbol: string,
    timeframe: string,
  ): void {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm) return;

    const tf = realtimeCandleAggregatorService.canonicalTimeframe(timeframe);
    if (!tf) return;

    const candles = realtimeCandleAggregatorService.getClosedHistory(norm, tf);
    if (!candles) return;

    socket.emit("history_candles", {
      symbol: norm,
      timeframe: tf,
      candles,
      count: candles.length,
    });

    logger.info(
      "[WebSocketService] Replayed closed candle history to subscriber",
      {
        symbol: norm,
        timeframe: tf,
        count: candles.length,
      },
    );
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
