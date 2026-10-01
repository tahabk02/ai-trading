"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from "react";
import { io, Socket, ManagerOptions, SocketOptions } from "socket.io-client";
import { logDebounced503 } from "@/lib/logDebouncer";
import { getWsUrl } from "@/utils/getBaseUrl";

export type SocketConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

interface SocketContextType {
  socket: Socket | null;
  /** Back-compat boolean — true exactly when `status === "connected"`. */
  connected: boolean;
  /**
   * Granular connection state machine:
   *   connecting   → first attempt (or post-rebind) handshake in progress
   *   connected    → live transport, receiving ticks
   *   reconnecting → transport dropped / refused; exponential backoff active
   *   disconnected → clean manual close (e.g. intentional local disconnect)
   */
  status: SocketConnectionStatus;
  /** Monotonic failed-attempt counter (reset to 0 after a successful connect). */
  reconnectAttempt: number;
  /** Last transport error message (e.g. "websocket error / ERR_CONNECTION_REFUSED"). */
  lastError: string | null;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

// ── BACKEND URL RESOLUTION (single source of truth) ──
// The socket MUST connect to the backend (port 4000), never to the Next.js
// origin (a different port/tunnel would 404 the handshake). Resolution is
// delegated to `getWsUrl()` — the SAME resolver axios uses for /api/v1 — so the
// REST and WS layers can never disagree about where the backend lives.
//
//   1. NEXT_PUBLIC_SOCKET_URL / NEXT_PUBLIC_WS_URL when set and live…
//      …EXCEPT a dead/stale tunnel host, which is ignored: a reissued or
//      expired Dev Tunnel used to win the priority chain and produced a dead
//      `wss://{old-id}-4000…` handshake plus ERR_NAME_NOT_RESOLVED everywhere.
//   2. Local page → http://localhost:4000.
//   3. Tunnel page → the live port-4000 sibling host.
//   4. Always → http://localhost:4000 loopback fallback.
function envWsBase(): string | null {
  return urlToWsBase(getWsUrl());
}

/** Strip a trailing "/api/v1" (and any slashes) so a WS origin never points at
 *  a scoped API path. Returns a bare origin or null. */
function urlToWsBase(raw: string | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let value = raw.trim().replace(/\/+$/, "");
  if (value.endsWith("/api/v1")) value = value.slice(0, -"/api/v1".length);
  try {
    const u = new URL(value);
    return u.origin;
  } catch {
    return value;
  }
}

const getBackendUrl = (): string => envWsBase() ?? "http://localhost:4000";

// ── CONNECTION ROBUSTNESS CONFIG ──
const PRIMARY_RETRY_MS = 60_000;
/** Throttle console.warn so a refused backend never spams the devtools log. */
const WARN_THROTTLE_MS = 2_000;

const SOCKET_OPTS: Partial<ManagerOptions & SocketOptions> = {
  path: "/socket.io",
  // ── TRANSPORT FALLBACK (not websocket-only) ──
  // `["websocket"]` alone has NO recovery path: when the upgrade is refused —
  // which is precisely what a Dev Tunnel or an intervening proxy does — Engine.IO
  // cannot fall back to HTTP long-polling and just retries the same failing
  // upgrade forever. Listing polling FIRST makes the handshake plain same-origin
  // HTTP (always proxied by the rewrite) and lets Engine.IO upgrade to
  // websocket opportunistically. Net effect: a blocked WS upgrade degrades to
  // polling instead of surfacing as a permanent connect_error.
  transports: ["polling", "websocket"],
  upgrade: true,
  autoConnect: true,
  withCredentials: true,
  reconnection: true,
  // NEVER give up: a dead/expired tunnel or an interface change must not
  // permanently strand the live feed.
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 10_000,
  randomizationFactor: 0.4,
  // Bounded cap on a single handshake attempt so a black-holed host surfaces a
  // connect_error (and the backoff ladder advances) instead of hanging forever.
  timeout: 15_000,
};

/**
 * NETWORK-CHANGE RECOVERY.
 *
 * `net::ERR_NETWORK_CHANGED` (Wi-Fi ↔ ethernet, VPN up/down, sleep/wake, tunnel
 * reissue) tears down the underlying TCP socket WITHOUT a clean socket.io
 * close in every browser, so the client can sit on a half-open transport that
 * never delivers another packet and never schedules a retry. Two guards fix it:
 *
 *  1. `online` / `visibilitychange` → force an immediate reconnect (and reset
 *     the exponential backoff) the moment connectivity returns.
 *  2. A liveness watchdog → if the socket believes it is connected but no
 *     packet has arrived for STALL_MS, or it is stuck in a non-connected state
 *     past the primary-retry window, force a hard reconnect.
 */
const LIVENESS_INTERVAL_MS = 15_000;
const STALL_MS = 45_000;

// ── MODULE-LEVEL SINGLETON (Fast-Refresh / remount friendly) ──
let globalSocket: Socket | null = null;
let globalEndpoint: string | null = null;

function connectEndpoint(endpoint: string): Socket {
  if (globalSocket && globalEndpoint === endpoint) return globalSocket;
  if (globalSocket) {
    globalSocket.removeAllListeners();
    globalSocket.disconnect();
    globalSocket = null;
  }
  globalSocket = io(endpoint, SOCKET_OPTS);
  globalEndpoint = endpoint;
  return globalSocket;
}

export const SocketProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [socket, setSocket] = useState<Socket | null>(() => {
    if (typeof window === "undefined") return null;
    return connectEndpoint(getBackendUrl());
  });
  const [status, setStatus] = useState<SocketConnectionStatus>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  socketRef.current = socket;
  const endpointRef = useRef<string>(getBackendUrl());
  const lastWarnAtRef = useRef(0);
  /** Timestamp of the last inbound frame — drives the stall watchdog. */
  const lastPacketAtRef = useRef(0);
  const primaryRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearPrimaryRetryTimer = useCallback(() => {
    if (primaryRetryTimerRef.current) {
      clearTimeout(primaryRetryTimerRef.current);
      primaryRetryTimerRef.current = null;
    }
  }, []);

  const throttledWarn = useCallback((msg: string, detail: unknown) => {
    const now = Date.now();
    if (now - lastWarnAtRef.current >= WARN_THROTTLE_MS) {
      lastWarnAtRef.current = now;
      console.warn(msg, detail);
    } else {
      console.debug(msg, detail);
    }
  }, []);

  const attach = useCallback(
    (instance: Socket) => {
      const onConnect = () => {
        clearPrimaryRetryTimer();
        setReconnectAttempt(0);
        setLastError(null);
        setStatus("connected");
        // Liveness baseline: any traffic restarts the stall clock.
        lastPacketAtRef.current = Date.now();
        console.info("[SocketProvider] Connected:", instance.id, {
          endpoint: endpointRef.current,
        });
      };

      // Any inbound frame proves the transport is alive. `live_tick` is the
      // high-frequency market feed; the others cover a quiet market so a
      // healthy-but-idle socket is never force-recycled.
      const markAlive = () => {
        lastPacketAtRef.current = Date.now();
      };
      instance.on("live_tick", markAlive);
      instance.on("tick", markAlive);
      instance.on("candle", markAlive);
      instance.on("feed_status", markAlive);

      const onDisconnect = (reason: string) => {
        setStatus(
          reason === "io client disconnect" ? "disconnected" : "reconnecting",
        );
        throttledWarn("[SocketProvider] Disconnected:", reason);
      };

      const onConnectError = (err: Error) => {
        setReconnectAttempt((prev) => prev + 1);
        setStatus("reconnecting");
        const msg = err?.message ?? "Socket connection failed";
        setLastError(msg);
        // 503-class transport failures (polling handshake refused while the
        // backend recovers) go through the debounced 503 gate: first warn,
        // silent for 10s, re-warn on a new incident.
        if (/503|Service Unavailable/i.test(msg)) {
          logDebounced503("[SocketProvider] Connection 503:", msg);
        } else {
          throttledWarn("[SocketProvider] Connection error:", msg);
        }
      };

      const onIoError = (err: Error) => {
        if (/503|Service Unavailable/i.test(err?.message ?? "")) {
          logDebounced503("[SocketProvider] Transport 503:", err?.message);
        } else {
          throttledWarn("[SocketProvider] Transport error:", err?.message);
        }
      };

      instance.on("connect", onConnect);
      instance.on("disconnect", onDisconnect);
      instance.on("connect_error", onConnectError);
      instance.on("error", onIoError);

      if (instance.connected) {
        clearPrimaryRetryTimer();
        setReconnectAttempt(0);
        setLastError(null);
        setStatus("connected");
      }
    },
    [clearPrimaryRetryTimer, throttledWarn],
  );

  useEffect(() => {
    if (socketRef.current) {
      attach(socketRef.current);
    }

    return () => {
      clearPrimaryRetryTimer();
      const current = socketRef.current;
      if (current) {
        current.removeAllListeners();
      }
    };
  }, [attach, clearPrimaryRetryTimer]);

  // ── NETWORK-CHANGE / STALL RECOVERY ────────────────────────────────────
  // A dropped interface (ERR_NETWORK_CHANGED), a reissued tunnel or a laptop
  // resume can leave the socket on a half-open transport that never delivers
  // another frame and never schedules a retry. Nothing here can throw: every
  // path is best-effort and the socket.io backoff ladder keeps running
  // underneath as the baseline recovery path.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const forceReconnect = (why: string) => {
      const instance = socketRef.current;
      if (!instance) return;
      try {
        // A half-open transport (ERR_NETWORK_CHANGED) never fires a close, so
        // socket.io's backoff ladder never starts. Tear the transport down and
        // rebuild it: disconnect() stops the automatic loop, the immediate
        // connect() restarts it from a clean handshake.
        if (instance.connected) {
          instance.disconnect();
        }
        instance.connect();
        lastPacketAtRef.current = Date.now();
        throttledWarn("[SocketProvider] forced reconnect:", why);
      } catch {
        /* never let recovery logic break the tree */
      }
    };

    const onOnline = () => forceReconnect("network online");
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        forceReconnect("tab visible");
      }
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);

    const watchdog = setInterval(() => {
      const instance = socketRef.current;
      if (!instance) return;
      const now = Date.now();

      if (!instance.connected) {
        // Stuck outside the connected state for longer than the primary retry
        // window → the automatic ladder is not making progress; kick it.
        if (lastPacketAtRef.current === 0) {
          lastPacketAtRef.current = now; // first tick: start the baseline
        } else if (now - lastPacketAtRef.current > PRIMARY_RETRY_MS) {
          lastPacketAtRef.current = now;
          forceReconnect("no connection within primary retry window");
        }
        return;
      }

      // Connected but silent for too long → half-open transport.
      if (
        lastPacketAtRef.current > 0 &&
        now - lastPacketAtRef.current > STALL_MS
      ) {
        lastPacketAtRef.current = now;
        forceReconnect("no inbound frame within stall window");
      }
    }, LIVENESS_INTERVAL_MS);

    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(watchdog);
    };
  }, [throttledWarn]);

  const connected = status === "connected";

  return (
    <SocketContext.Provider
      value={{
        socket,
        connected,
        status,
        reconnectAttempt,
        lastError,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
};

export const useSocket = (): SocketContextType => {
  const context = useContext(SocketContext);
  if (context === undefined) {
    throw new Error("useSocket must be used within a SocketProvider");
  }
  return context;
};
