import { Server as SocketServer } from "socket.io";
import { PrismaClient } from "@prisma/client";
import { EventTypes } from "./eventTypes";
import { WebSocketService } from "../services/websocket.service";
import { NotificationService } from "../services/notification.service";
import { LocalEventBus } from "./local-event-bus";
import { realtimeTickBuffer } from "../services/realtimeTickBuffer.service";
import { secrets } from "../config/secrets";
import { logger } from "../utils/logger";

// ── LIVE-SIGNAL FRESHNESS GATE ──
// A distributed signal is only broadcast to clients as a "live" verdict when
// the underlying pair has a genuinely FRESH real tick (≤ LIVE_SIGNAL_MAX_AGE_MS).
// This preserves the zero-demo contract: the UI must never receive a BUY/SELL
// that is derived from a price tape we can no longer confirm is live. Signals
// from an unknown/stale pair are persisted for history but never pushed live.
const LIVE_SIGNAL_MAX_AGE_MS = 3_000;
import type { SignalPayload } from "../models/signal.types";
import type { Signal } from "@prisma/client";

// =============================================================================
//  RedisSubscriber
//
//  Listens for trading signals — either via Redis Pub/Sub (when available)
//  or via the LocalEventBus in-memory fallback.  The fallback is triggered
//  automatically when Redis fails to connect and emits a single warning.
// =============================================================================

export class RedisSubscriber {
  private io: SocketServer;
  private prisma: PrismaClient;
  private wsService: WebSocketService;
  private notifier: NotificationService;
  private bus: LocalEventBus;
  private fallbackActive = false;
  private fallbackWarningLogged = false;

  constructor(io: SocketServer) {
    this.io = io;
    this.prisma = new PrismaClient();
    this.wsService = WebSocketService.getInstance();
    this.notifier = NotificationService.getInstance();
    this.bus = LocalEventBus.getInstance();
  }

  // ----------------------------------------------------------
  //  Public API
  // ----------------------------------------------------------

  /**
   * Initialise the subscriber.  Tries Redis first — if it fails
   * after 3 attempts, falls back to the in-memory LocalEventBus
   * with a single log warning (no spam).
   */
  public async subscribe(): Promise<void> {
    try {
      await this.tryRedis(3);
      // If we get here, Redis succeeded
    } catch {
      // Redis is unavailable — use the in-memory fallback, log once
      this.fallbackActive = true;
      this.bus.warnOnce();
      this.attachLocalBusListeners();
    }
  }

  /** Graceful shutdown */
  public async shutdown(): Promise<void> {
    if (this.fallbackActive) {
      await this.bus.shutdown();
    }
    await this.prisma.$disconnect();
    logger.info("[RedisSubscriber] Shutdown complete");
  }

  // ----------------------------------------------------------
  //  Redis path (tried first, max 3 attempts)
  // ----------------------------------------------------------

  private async tryRedis(maxAttempts: number): Promise<void> {
    const { Redis } = await import("ioredis");

    const options = {
      maxRetriesPerRequest: 1, // each command only retries once
      retryStrategy: (times: number) => {
        if (times >= maxAttempts) {
          logger.warn(
            "[RedisSubscriber] All %d reconnection attempts exhausted — switching to local fallback",
            maxAttempts,
          );
          return null; // stops reconnection permanently
        }
        return 200; // 200 ms between attempts
      },
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 5_000, // fail fast if host is unreachable
    };

    const redis = secrets.REDIS_URL
      ? new Redis(secrets.REDIS_URL, options)
      : new Redis({
          host: secrets.REDIS_HOST,
          port: secrets.REDIS_PORT,
          password: secrets.REDIS_PASSWORD || undefined,
          ...options,
        });

    // Silence individual Redis error events to prevent log spam
    redis.on("error", () => {
      /* intentionally silent */
    });

    redis.on("end", () => {
      /* silent — the retry strategy logs once when max attempts are exhausted */
    });

    // Attach message handler
    redis.on("message", (channel: string, message: string) => {
      this.onMessage(channel, message).catch((err) => {
        logger.error("[RedisSubscriber] Error in onMessage", {
          channel,
          error: (err as Error).message,
        });
      });
    });

    // Attempt connection with limited retries
    await redis.connect();

    // Subscribe to all configured channels
    const channels = [EventTypes.SIGNAL_GENERATED];
    await redis.subscribe(...channels);

    logger.info("[RedisSubscriber] Connected & subscribed", { channels });
  }

  // ----------------------------------------------------------
  //  Local in-memory fallback path
  // ----------------------------------------------------------

  private attachLocalBusListeners(): void {
    this.bus.subscribe(EventTypes.SIGNAL_GENERATED, (message: string) => {
      this.onMessage(EventTypes.SIGNAL_GENERATED, message).catch((err) => {
        logger.error("[RedisSubscriber] Error in local onMessage", {
          error: (err as Error).message,
        });
      });
    });
  }

  // ----------------------------------------------------------
  //  Message dispatch
  // ----------------------------------------------------------

  private async onMessage(channel: string, rawMessage: string): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      logger.warn(
        "[RedisSubscriber] Non-JSON message on channel '%s'",
        channel,
        { preview: rawMessage.slice(0, 200) },
      );
      return;
    }

    if (channel === EventTypes.SIGNAL_GENERATED) {
      await this.handleSignalGenerated(parsed);
    }
  }

  // ----------------------------------------------------------
  //  Signal processing pipeline
  // ----------------------------------------------------------

  private async handleSignalGenerated(
    raw: Record<string, unknown>,
  ): Promise<void> {
    const payload = this.extractSignalPayload(raw);
    if (!payload) {
      logger.warn("[RedisSubscriber] Dropped invalid signal", { raw });
      return;
    }

    logger.info("[RedisSubscriber] Processing signal", {
      symbol: payload.symbol,
      signalType: payload.signal_type,
      confidence: payload.confidence,
    });

    try {
      const saved = await this.prisma.signal.create({
        data: {
          symbol: payload.symbol,
          signalType: payload.signal_type,
          price: payload.price,
          confidence: payload.confidence,
          indicators: JSON.stringify(payload.indicators ?? {}),
          status: payload.status ?? "ACTIVE",
        },
      });

      const wsSignal = this.toWebSocketSignal(payload, saved);

      // ── ZERO-DEMO LIVE-FEED GUARD ──
      // Only broadcast a "live" signal when the pair's real tick tape is
      // genuinely fresh. A stale tape must never present a BUY/SELL as live —
      // the user is shown "Connecting / Waiting for Real-time Tick" instead.
      const norm = payload.symbol.trim().toUpperCase();
      const ageMs = realtimeTickBuffer.getLatestAgeMs(norm);
      const tapeFresh = ageMs != null && ageMs <= LIVE_SIGNAL_MAX_AGE_MS;
      if (!tapeFresh) {
        logger.warn(
          "[RedisSubscriber] Dropping LIVE broadcast for stale tape (persisting only)",
          {
            symbol: norm,
            signal: payload.signal_type,
            tickAgeMs: ageMs,
            liveToleranceMs: LIVE_SIGNAL_MAX_AGE_MS,
          },
        );
        return;
      }

      // Broadcast globally
      this.io.emit("new_signal", wsSignal);
      // Broadcast to symbol-specific room
      this.io.to(payload.symbol).emit("symbol_update", wsSignal);

      // Notification
      await this.notifier.sendSignalAlert({
        userId: "system",
        symbol: payload.symbol,
        signalType: payload.signal_type,
        price: payload.price,
        confidence: payload.confidence,
      });

      logger.info("[RedisSubscriber] Signal broadcast", {
        id: saved.id,
        symbol: saved.symbol,
      });
    } catch (error) {
      logger.error("[RedisSubscriber] Signal processing error", {
        symbol: payload.symbol,
        error: (error as Error).message,
      });
    }
  }

  // ----------------------------------------------------------
  //  Helpers
  // ----------------------------------------------------------

  private toNumber(value: unknown): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const n = Number(value);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  private extractSignalPayload(
    raw: Record<string, unknown>,
  ): SignalPayload | null {
    const symbol = String(raw?.symbol ?? raw?.ticker ?? raw?.pair ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) return null;

    const signal_type = String(
      raw?.signal_type ??
        raw?.signalType ??
        raw?.direction ??
        raw?.signal ??
        "",
    ).toUpperCase() as "BUY" | "SELL";
    if (signal_type !== "BUY" && signal_type !== "SELL") return null;

    const price = this.toNumber(
      raw?.price ?? raw?.entry_price ?? raw?.current_price,
    );
    // Confidence accepted in EITHER scale and normalized to [0,1] for storage
    // (a 0-100 value like 65.90 becomes 0.659). No 70% floor gate — genuinely
    // low-confidence signals are persisted and broadcast like any other.
    const confidence = this.toNumber(raw?.confidence ?? raw?.confidence_score);
    const normalizedConfidence =
      confidence > 1 ? confidence / 100 : confidence;
    if (!Number.isFinite(price) || price <= 0) return null;
    if (!Number.isFinite(normalizedConfidence) || normalizedConfidence < 0)
      return null;

    return {
      symbol,
      signal_type,
      price,
      confidence: normalizedConfidence,
      stop_loss: this.toNumber(raw?.stop_loss ?? raw?.stopLoss) || undefined,
      take_profit:
        this.toNumber(raw?.take_profit ?? raw?.takeProfit) || undefined,
      indicators: (raw?.indicators ?? raw?.reasoning ?? {}) as
        | Record<string, number>
        | undefined,
      status: String(raw?.status ?? "ACTIVE"),
      timestamp: String(
        raw?.timestamp ?? raw?.createdAt ?? new Date().toISOString(),
      ),
    };
  }

  private toWebSocketSignal(
    payload: SignalPayload,
    saved: Signal,
  ): Record<string, unknown> {
    const indicators =
      typeof saved.indicators === "string"
        ? JSON.parse(saved.indicators)
        : (saved.indicators as Record<string, number | undefined>);
    const adxValue = Number(indicators?.adx ?? 0);

    return {
      id: saved.id,
      symbol: saved.symbol,
      direction: saved.signalType as "BUY" | "SELL",
      entry_price: saved.price,
      take_profit: payload.take_profit ?? 0,
      stop_loss: payload.stop_loss ?? 0,
      confidence_score: saved.confidence,
      timestamp: saved.createdAt.toISOString(),
      reasoning: {
        adx_value: adxValue,
        market_regime: adxValue >= 20 ? "TRENDING" : "SIDEWAYS/CHOP",
        ml_probability: saved.confidence,
        logic_audit:
          "3-Layer Gendarmerie V1: ADX(14) regime → ATR freeze → confidence threshold",
      },
    };
  }
}
