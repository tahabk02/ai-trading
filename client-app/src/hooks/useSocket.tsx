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
import { WS_URL, API_URL } from "@/lib/env";

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

// ── BACKEND URL RESOLUTION (env-driven, NEVER window.location.origin) ──
// The socket MUST connect to the backend (port 4000), never to the Next.js
// origin. Priority (values come from src/lib/env.ts, inlined at build time —
// `process` is never referenced in this client module):
//   1. WS_URL   — the explicit WebSocket/backend tunnel host.
//   2. API_URL  — same backend; a trailing "/api/v1" base is normalized away
//                 so the socket.io handshake hits "/socket.io" on the origin
//                 (never ".../api/v1/socket.io/...").
//   3. http://localhost:4000 — safe loopback fallback.
// window.location.origin is deliberately UNUSED: the Next.js frontend lives on
// a different port/tunnel (e.g. :3001 devtunnel) whose origin would 404 the
// socket.io handshake.
function envWsBase(): string | null {
  return urlToWsBase(WS_URL || API_URL);
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
  transports: ["websocket"],
  upgrade: false,
  autoConnect: true,
  withCredentials: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 10_000,
  randomizationFactor: 0.4,
  timeout: 15_000,
};

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
        console.info("[SocketProvider] Connected:", instance.id, {
          endpoint: endpointRef.current,
        });
      };

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
