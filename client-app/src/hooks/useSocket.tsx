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
  /** True when the transport fell back to the same-origin socket.io rewrite. */
  usingFallbackUrl: boolean;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

// ── CONNECTION ROBUSTNESS CONFIG ──
//
// PRIMARY endpoint = env-resolved backend URL (development `.env.local` forces
//   http://localhost:4000 → ws://localhost:4000/socket.io; expected).
// FALLBACK endpoint = "/" → same-origin Socket.IO — Next.js `/socket.io/:path*`
//   rewrite proxies to the backend. This is the graceful escape hatch when the
//   DIRECT ws:// to :4000 is refused (backend briefly down, firewall, mixed
//   content, Dev Tunnel CSP) while the Next server is still serving the page.
//
//   - After FALLBACK_AFTER_FAILURES consecutive `connect_error`s the provider
//     rebinds ONCE to the fallback endpoint (socket.io's own exponential
//     backoff already throttles direct-endpoint retries in the meantime).
//   - When the fallback CONNECTS, a PRIMARY_RETRY_MS probe rebinds back to the
//     preferred direct endpoint so a recovered backend is reclaimed
//     automatically (if still down it fails once more and falls back again).
const FALLBACK_AFTER_FAILURES = 3;
const PRIMARY_RETRY_MS = 60_000;
/** Throttle console.warn so a refused backend never spams the devtools log —
 *  one warn every 2s per reconnect storm (MASTER MISSION part 2). */
const WARN_THROTTLE_MS = 2_000;

const SOCKET_OPTS: Partial<ManagerOptions & SocketOptions> = {
  // websocket-first with polling fallback handshake (same as before)
  transports: ["websocket", "polling"],
  autoConnect: true,
  // ── EXPONENTIAL BACKOFF, NOT SPAM ──
  // socket.io-client doubles reconnectionDelay per failure, capped at
  // reconnectionDelayMax (1s → 10s randomized). A longer base + lower cap keep
  // the reconnect machine gentle under sustained outages while the transport
  // still reclaims a recovered backend within seconds.
  reconnection: true,
  reconnectionAttempts: Infinity, // never give up — live ticks are mandatory
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 10_000,
  randomizationFactor: 0.4,
  timeout: 10_000,
};

// ── MODULE-LEVEL SINGLETON PER ENDPOINT (Fast-Refresh / remount friendly) ──
// Keeps one cached Socket tagged with the endpoint it was created for, so a
// fallback rebind tears down the old transport and swaps cleanly.
let globalSocket: Socket | null = null;
let globalEndpoint: string | null = null;

function connectEndpoint(endpoint: string): Socket {
  if (globalSocket && globalEndpoint === endpoint) return globalSocket;
  if (globalSocket) {
    // Swapping endpoints — tear the old transport down cleanly first.
    globalSocket.removeAllListeners();
    globalSocket.disconnect();
    globalSocket = null;
  }
  globalSocket = io(endpoint, SOCKET_OPTS);
  globalEndpoint = endpoint;
  return globalSocket;
}

/**
 * SINGLETON Socket.IO socket bound to the RESOLVED backend URL with automatic
 * fallback + exponential backoff + throttled diagnostics.
 *
 * URL resolution (getWsUrl):
 *   - localhost dev      → NEXT_PUBLIC_WS_URL (http://localhost:4000)
 *   - Dev Tunnels/remote → same-origin "/" (Next.js rewrite proxies
 *                          /socket.io/* to the backend — no hardcoded host).
 *   - Production hosts   → ws(s)://<hostname>:4000
 */
export const SocketProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [socket, setSocket] = useState<Socket | null>(() => {
    // Lazily create the singleton on first render. NEVER on the server: SSR
    // would construct a real socket.io manager on the Node side and burn
    // connections during build/SSR — the client re-hydrates with its own.
    if (typeof window === "undefined") return null;
    return connectEndpoint(getWsUrl());
  });
  const [status, setStatus] = useState<SocketConnectionStatus>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [usingFallbackUrl, setUsingFallbackUrl] = useState(false);

  // Latest instance + endpoint so the runtime rebind can target the CURRENT
  // transport without creating a circular useCallback dependency.
  const socketRef = useRef<Socket | null>(null);
  socketRef.current = socket;
  const endpointRef = useRef<string>(getWsUrl());
  const failureCountRef = useRef(0);
  const lastWarnAtRef = useRef(0);
  const primaryRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Holds the LATEST rebind implementation; attach() reads it at runtime.
  const rebindRef = useRef<(endpoint: string) => void>(() => {});

  const clearPrimaryRetryTimer = useCallback(() => {
    if (primaryRetryTimerRef.current) {
      clearTimeout(primaryRetryTimerRef.current);
      primaryRetryTimerRef.current = null;
    }
  }, []);

  const throttledWarn = useCallback(
    (msg: string, detail: unknown) => {
      const now = Date.now();
      if (now - lastWarnAtRef.current >= WARN_THROTTLE_MS) {
        lastWarnAtRef.current = now;
        console.warn(msg, detail);
      } else {
        console.debug(msg, detail);
      }
    },
    [],
  );

  const attach = useCallback(
    (instance: Socket) => {
      const onConnect = () => {
        failureCountRef.current = 0;
        clearPrimaryRetryTimer();
        setReconnectAttempt(0);
        setLastError(null);
        setStatus("connected");
        console.info("[SocketProvider] Connected:", instance.id, {
          endpoint: endpointRef.current,
        });

        // Landed on the fallback → probe back to the preferred direct
        // endpoint so a recovered backend is reclaimed automatically.
        if (endpointRef.current !== getWsUrl()) {
          clearPrimaryRetryTimer();
          primaryRetryTimerRef.current = setTimeout(() => {
            primaryRetryTimerRef.current = null;
            rebindRef.current(getWsUrl());
          }, PRIMARY_RETRY_MS);
        }
      };

      const onDisconnect = (reason: string) => {
        // "io client disconnect" is an intentional local close (we initiated).
        setStatus(
          reason === "io client disconnect" ? "disconnected" : "reconnecting",
        );
        throttledWarn("[SocketProvider] Disconnected:", reason);
      };

      const onConnectError = (err: Error) => {
        failureCountRef.current += 1;
        const attempt = failureCountRef.current;
        setReconnectAttempt(attempt);
        setStatus(attempt > 1 ? "reconnecting" : "connecting");
        const msg = err?.message ?? "Socket connection failed";
        setLastError(msg);
        // Throttle to one warn / WARN_THROTTLE_MS — a refused backend must NOT
        // spam ERR_CONNECTION_REFUSED warnings for every backoff retry.
        throttledWarn("[SocketProvider] Connection error:", msg);

        // Fallback once per failure run (never rebind in a tight loop):
        // direct endpoint → same-origin rewrite after repeated refusals.
        if (
          attempt >= FALLBACK_AFTER_FAILURES &&
          endpointRef.current === getWsUrl()
        ) {
          rebindRef.current("/");
        }
      };

      // Socket.IO fires this for manager-level errors too (polling 4xx / 5xx).
      const onIoError = (err: Error) => {
        throttledWarn("[SocketProvider] Transport error:", err?.message);
      };

      instance.on("connect", onConnect);
      instance.on("disconnect", onDisconnect);
      instance.on("connect_error", onConnectError);
      instance.on("error", onIoError);

      // Already connected (e.g. re-attach after Fast Refresh reuse).
      if (instance.connected) {
        failureCountRef.current = 0;
        clearPrimaryRetryTimer();
        setReconnectAttempt(0);
        setLastError(null);
        setStatus("connected");
      }
    },
    [clearPrimaryRetryTimer, throttledWarn],
  );

  // Rebind implementation (kept in a ref to avoid a useCallback cycle).
  rebindRef.current = (endpoint: string) => {
    const current = socketRef.current;
    if (current) {
      current.removeAllListeners();
    }
    const next = connectEndpoint(endpoint);
    endpointRef.current = endpoint;
    setUsingFallbackUrl(endpoint !== getWsUrl());
    setStatus("connecting");
    setSocket(next);
    attach(next);
  };

  useEffect(() => {
    // Mount: attach to the already-created singleton (lazily created above).
    // On SSR there is no socket — the browser re-hydrates and re-runs this and
    // the lazy initializer above on the client.
    if (socketRef.current) {
      attach(socketRef.current);
    }

    return () => {
      clearPrimaryRetryTimer();
      // Detach listeners but KEEP the singleton transport alive so Fast
      // Refresh, layout re-renders and future mounts reuse one live connection
      // instead of churning sockets + re-arming the handshake each time.
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
        usingFallbackUrl,
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