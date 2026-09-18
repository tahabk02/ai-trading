import type { ServerOptions } from "socket.io";
import { corsOptions } from "./cors";

/**
 * Socket.IO engine options (single source of truth for the server + tests).
 *
 * MASTER MISSION part 2 — stability contract:
 *  • pingInterval 25s / pingTimeout 20s: a ~10s UI event-loop stall (long tasks
 *    from the tick flood / chart work) must NOT trip the heartbeat and force a
 *    disconnect↔reconnect cycle. 25s/20s tolerates transient main-thread
 *    stalls while still pruning genuinely wedged pipes in ~45s worst case.
 *  • CORS reuses the shared `corsOptions` resolver so the Socket.IO engine
 *    and the Express middleware can never drift — both allow the frontend
 *    origin and every *.devtunnels.ms origin with credentials.
 */
export const SOCKET_SERVER_OPTIONS: Partial<ServerOptions> = {
  cors: {
    origin: corsOptions.origin,
    methods: ["GET", "POST"],
    credentials: corsOptions.credentials,
    allowedHeaders: corsOptions.allowedHeaders,
  },
  transports: ["polling", "websocket"],
  pingInterval: 25_000,
  pingTimeout: 20_000,
  connectTimeout: 10_000,
  upgradeTimeout: 10_000,
};

/** The single frontend origin the platform's own Next.js client connects from. */
export const FRONTEND_ORIGIN = "http://localhost:3000";