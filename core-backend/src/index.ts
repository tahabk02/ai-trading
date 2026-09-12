import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer, type Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import { EventEmitter } from "events";
import { PrismaClient } from "@prisma/client";

import { secrets } from "./config/secrets";
import { logger } from "./utils/logger";
import { RedisSubscriber } from "./messaging/subscriber";
import { CacheService } from "./services/cache.service";
import { WebSocketService } from "./services/websocket.service";
import { tickIngestionService } from "./services/tickIngestion.service";
import { symbolRegistry } from "./services/symbolRegistry.service";
import { forexDataService } from "./services/forexData.service";
import { pocketOptionBridgeService } from "./services/pocketOptionBridge.service";
import { feedMetrics } from "./lib/feedMetrics";
import { rateLimit } from "./middlewares/rateLimit.middleware";
import { errorMiddleware } from "./middlewares/error.middleware";
import apiRouter from "./routes/index";

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  GLOBAL EVENT EMITTER CONFIGURATION
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Increase the default max listeners for Node.js global emitters to suppress
// MaxListenersExceededWarning across streams, socket connections, and process
// event bus. This is safe because we properly remove listeners in cleanup.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

EventEmitter.defaultMaxListeners = 30;
process.setMaxListeners(50);

// =============================================================================
//  DATABASE  (Prisma)
// =============================================================================

const prisma = new PrismaClient({
  log:
    secrets.NODE_ENV === "development"
      ? ["query", "info", "warn", "error"]
      : ["error"],
});

async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info("Database connected", {
      provider: secrets.DATABASE_URL?.startsWith("file:")
        ? "sqlite"
        : "postgresql",
    });
  } catch (error) {
    logger.error("Database connection failed â€” retrying in 5 seconds", {
      error: (error as Error).message,
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      await prisma.$connect();
      logger.info("Database connected on retry");
    } catch (retryError) {
      logger.error("Database unreachable after retry â€” shutting down", {
        error: (retryError as Error).message,
      });
      process.exit(1);
    }
  }
}

async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    logger.info("Database disconnected");
  } catch (error) {
    logger.error("Error disconnecting database", {
      error: (error as Error).message,
    });
  }
}

// =============================================================================
//  EXPRESS APPLICATION  (with HTTP & WebSocket servers)
// =============================================================================

const app: Express = express();
// Explicit HTTP socket timings: Node's default keepAliveTimeout (5s) lets
// proxies/reverse-terminators see keep-alive sockets go stale and respond 503
// to the next request; a longer keep-alive keeps long-lived Node clients
// (dashboard polling, API probes) on a stable connection. headersTimeout must
// exceed keepAliveTimeout so a slow client can never trip a stray 503.
const httpServer: HttpServer = createServer({
  keepAliveTimeout: 30_000,
  headersTimeout: 65_000,
});
// Express must not be used as the (options)-overload listener — attach it
// explicitly as the HTTP request handler.
httpServer.on("request", app);
httpServer.setMaxListeners(30); // suppress MaxListenersExceededWarning on HTTP events

// â”€â”€ 1. CORS Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Requirement 1: Initialize Express and configure CORS explicitly allowing origin "http://localhost:3000" with credentials support.
// We also support additional configured origins to maintain production flexibility.
const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];
const configuredOrigin = (secrets.CORS_ORIGIN || "").trim();
if (configuredOrigin) {
  configuredOrigin.split(",").forEach((o) => {
    const trimmed = o.trim();
    if (trimmed && !allowedOrigins.includes(trimmed)) {
      allowedOrigins.push(trimmed);
    }
  });
}

function corsOriginResolver(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) {
    return callback(null, true);
  }
  
  const isAllowed = allowedOrigins.includes(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) ||
    origin.includes(".devtunnels.ms");
    
  if (isAllowed) {
    callback(null, true);
  } else {
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  }
}

// Express CORS â€” must be first to handle preflight
app.use(
  cors({
    origin: corsOriginResolver,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Access-Control-Allow-Origin",
    ],
  }),
);

// Add Private Network Access header (required by Chrome when a public/HTTPS
// origin â€” e.g. Dev Tunnel â€” tries to reach a private/localhost server).
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});

// Body parsing
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// HTTP request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl}`, {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
    });
  });
  next();
});

// â”€â”€ 2. Rate Limiting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const rateLimitMiddleware = rateLimit({
  maxRequests: secrets.RATE_LIMIT_MAX,
  windowMs: secrets.RATE_LIMIT_WINDOW_MS,
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/health") || req.path.startsWith("/api/v1/health")) {
    return next();
  }
  rateLimitMiddleware(req, res, next);
});

// â”€â”€ 3. API Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use("/api/v1", apiRouter);

// Root health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "core-backend",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Prometheus text-format scrape endpoint for the live-feed resilience metrics
// (feed_retry_total, feed_error_total, feed_recovery_total, feed_backoff_ms,
// feed_lingering_max_errors). Counter semantics are monotonic so Grafana
// allow-alerts work out of the box.
app.get("/metrics", (_req: Request, res: Response) => {
  res.type("text/plain").send(feedMetrics.scrape());
});

// 404 catch-all for unknown API routes
app.use("/api/*", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found" });
});

// â”€â”€ 4. Global Error Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  errorMiddleware(err, req, res, next);
});

// =============================================================================
//  SOCKET.IO SETUP
// =============================================================================
// Requirement 2: Attach Socket.io configured with explicit transports ["websocket", "polling"]
// and proper CORS matching the frontend URL "http://localhost:3000" to prevent handshake and connection failures.
const io: SocketIOServer = new SocketIOServer(httpServer, {
  cors: {
    origin: corsOriginResolver, // Matches the frontend URL "http://localhost:3000" dynamically and explicitly
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  },
  transports: ["websocket", "polling"], // Explicit transports as requested
  pingInterval: 12_000, // fast dead-pipe detection (was 25s â€” a 25s gap before a
  // timeout means up to 45s of "silence" before the transport recovers; at a
  // 100Hz+ tick cadence that is catastrophic). 12s keeps the heartbeat cheap
  // while pruning wedged pipes in under ~20s worst case.
  pingTimeout: 10_000,
  connectTimeout: 10_000,
  upgradeTimeout: 10_000,
  maxHttpBufferSize: 5e6, // 5MB per packet â€” large candle/signal payloads are
  // never dropped at the server buffer door under burst conditions.
  // â”€â”€ CONNECTION STATE RECOVERY â”€â”€
  // Restores rooms + replays packets buffered during a brief disconnect
  // (up to 2 minutes) so a flaky network loses zero live ticks, joining
  // seamlessly with the `history` replay served on fresh subscriptions.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60_000,
    skipMiddlewares: true,
  },
  // â”€â”€ ZERO-DROP ULTRA-LOW-LATENCY â”€â”€
  // Websocket frame compression is disabled end-to-end: at 100Hz+ tick cadence
  // perMessageDeflate/httpCompression add measurable per-frame latency + CPU
  // with no capacity benefit (each tick payload is a few hundred bytes and is
  // already below the MTU where deflate gains vanish). Raw frames = sub-ms
  // press-to-canvas. Reconnect/backoff is handled by the client provider.
  perMessageDeflate: false,
  httpCompression: false,
});

// Initialize the WebSocket service singleton with the Socket.IO instance
const wsService = WebSocketService.getInstance();
wsService.initialize(io);

// Connection lifecycle
// Requirement 3: Implement core connection lifecycle handlers, including client connection logging,
// a "subscribe" event listener for dynamic symbol room management, and a clean "disconnect" handler.
io.on("connection", (socket) => {
  logger.info("WebSocket client connected", {
    socketId: socket.id,
    ip: socket.handshake.address,
    transport: socket.conn.transport.name,
  });

  // Dynamic symbol room management via "subscribe" event
  socket.on("subscribe", (symbol: string) => {
    if (symbol?.trim()) {
      const normalized = symbol.trim().toUpperCase();
      socket.join(normalized);
      tickIngestionService.startSymbolStream(normalized);
      // FORCE INITIAL TICK HANDSHAKE — push the ACTIVE symbol to the PO bridge
      // so its tick reader arms immediately and confirms back (subscribed →
      // held price seeded → "WAITING FOR REAL-TIME TICK" lock clears).
      pocketOptionBridgeService.requestSymbolSubscription(normalized);
      // REPLAY-ON-JOIN â€” seed this socket with the real 2000-tick ring so a
      // fresh/reconnecting client rebuilds chart continuity instantly instead
      // of waiting for the live feed to move again.
      wsService.replayHistory(socket, normalized);
      logger.info("Client subscribed to symbol room", {
        socketId: socket.id,
        symbol: normalized,
      });
    }
  });

  // Dynamic symbol room management via "subscribe_symbol" event (for backward compatibility)
  socket.on("subscribe_symbol", (symbol: string) => {
    if (symbol?.trim()) {
      const normalized = symbol.trim().toUpperCase();
      socket.join(normalized);
      tickIngestionService.startSymbolStream(normalized);
      pocketOptionBridgeService.requestSymbolSubscription(normalized);
      wsService.replayHistory(socket, normalized);
      logger.info("Client subscribed to symbol room (legacy)", {
        socketId: socket.id,
        symbol: normalized,
      });
    }
  });

  socket.on("unsubscribe_symbol", (symbol: string) => {
    if (symbol?.trim()) {
      const normalized = symbol.trim().toUpperCase();
      socket.leave(normalized);
      logger.info("Client unsubscribed from symbol room", {
        socketId: socket.id,
        symbol: normalized,
      });
    }
  });

  // Clean "disconnect" handler
  socket.on("disconnect", (reason) => {
    logger.info("WebSocket client disconnected", {
      socketId: socket.id,
      reason,
    });
  });
});

// â”€â”€ Redis Subscriber (Pub/Sub â†’ WebSocket bridge) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const subscriber = new RedisSubscriber(io);
subscriber.subscribe().catch((error) => {
  logger.error(
    "Redis subscriber initialisation failed, signals will not be relayed",
    {
      error: (error as Error).message,
    },
  );
});

// â”€â”€ Cache Service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const cacheService = CacheService.getInstance();
cacheService
  .connect()
  .then(async () => {
    try {
      await cacheService.flushAll();
      await cacheService.flushByPrefix("otc_forex_");
    } catch (flushError: any) {
      logger.warn(
        "[Startup] Cache flush failed â€” continuing without flush. Stale prices may persist temporarily.",
        { error: flushError?.message },
      );
    }

    wsService.broadcastEngineStatus(
      "ONLINE",
      "All data services initialized â€” cache purged, market data streaming",
    );
  })
  .catch((error) => {
    logger.warn("Cache service connection failed â€” continuing without cache", {
      error: (error as Error).message,
    });
    wsService.broadcastEngineStatus(
      "DEGRADED",
      "Cache unavailable, market data operating in direct-fetch mode",
    );
  });

// â”€â”€ Initialize Database â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
connectDatabase().catch((error) => {
  logger.error("Failed to connect database at startup", {
    error: (error as Error).message,
  });
});

// =============================================================================
//  OTC PAYOUT SYNC JOB â€” every 5 minutes refresh dynamic ATR-derived payouts
// =============================================================================
const OTC_PAYOUT_SYNC_INTERVAL_MS = 5 * 60_000; // 5 minutes

function startPayoutSyncJob(): NodeJS.Timeout {
  logger.info("[PayoutSync] Starting OTC payout sync job (every 5 minutes)");
  void syncAllPayouts();

  return setInterval(() => {
    void syncAllPayouts();
  }, OTC_PAYOUT_SYNC_INTERVAL_MS);
}

async function syncAllPayouts(): Promise<void> {
  const all = await symbolRegistry.getAll("otc");
  for (const entry of all) {
    try {
      const payout = await forexDataService.syncPayouts(entry.symbol);
      logger.info("[PayoutSync] Payout refreshed", {
        symbol: entry.symbol,
        payout,
      });
    } catch (error) {
      logger.warn("[PayoutSync] Payout sync failed for pair", {
        symbol: entry.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const payoutSyncTimer: NodeJS.Timeout = startPayoutSyncJob();

// =============================================================================
//  SERVER START
// =============================================================================
// Requirement 4: Bind the HTTP server explicitly to PORT 4000 (or process.env.PORT falling back to 4000)
// and output a clean startup confirmation log.
const PORT = Number(process.env.PORT) || 4000;

httpServer.listen(PORT, () => {
  logger.info("Core Backend started", {
    port: PORT,
    environment: secrets.NODE_ENV,
    corsOrigin: secrets.CORS_ORIGIN,
    nodeVersion: process.version,
    pid: process.pid,
  });
  console.log(`\nðŸš€ SERVER RUNNING ON PORT ${PORT} ðŸš€\n`);

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //  STRICT LIVE TICK AUTO-START â€” 100% REAL DATA, 0% DEMO
  // Auto-start live tick streams for all whitelisted OTC pairs on boot.
  // Candle buffers are populated ONLY by real observed data (PO bridge
  // snapshot/ticks and genuine HTTP live ticks) â€” NO skeleton-bar fabrication.
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      symbolRegistry
    .getAll("otc")
    .then(async (pairs) => {
      pairs.forEach((entry) => {
        tickIngestionService.startSymbolStream(entry.symbol);
      });
      logger.info("[Startup] Strict live tick streams ready", {
        count: pairs.length,
        symbols: pairs.map((p) => p.symbol),
      });
    })
    .catch((err) => {
      logger.error("[Startup] Failed to auto-start live tick streams", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // â”€â”€ POCKET OPTION LIVE BRIDGE (SSOT for real prices) â”€â”€
  // Connect the backend client to the Python relay. If no SSID is configured
  // the bridge reports a clean awaiting_ssid state (no fabricated data).
  pocketOptionBridgeService.start();
});

// =============================================================================
//  GRACEFUL SHUTDOWN
// =============================================================================
const SHUTDOWN_TIMEOUT_MS = 10_000; // 10 seconds max for cleanup

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal} â€” starting graceful shutdown`);

  httpServer.close(() => {
    logger.info("HTTP server closed");
  });

  const forceExit = setTimeout(() => {
    logger.error("Forced shutdown after timeout", {
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    tickIngestionService.stopAllStreams();
    pocketOptionBridgeService.stop();
    io.close();
    logger.info("WebSocket server closed");

    await subscriber.shutdown().catch(() => {});
    await cacheService.disconnect().catch(() => {});
    logger.info("Redis connections closed");

    await disconnectDatabase();

    clearTimeout(forceExit);
    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Error during graceful shutdown", {
      error: (error as Error).message,
    });
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason: unknown) => {
  logger.error("Unhandled Promise Rejection â€” server continues running", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on("uncaughtException", (error: Error) => {
  logger.error("Uncaught Exception â€” server continues running", {
    error: error.message,
    stack: error.stack,
  });
});

// =============================================================================
//  EXPORTS for testing / integration
// =============================================================================
export { app, httpServer, io, prisma };

