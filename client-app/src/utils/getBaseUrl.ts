/**
 * getBaseUrl.ts
 *
 * Detects the runtime environment and returns the correct base URL for
 * API and WebSocket connections, with seamless dynamic Dev Tunnel resolution.
 *
 * ── Logic ──
 * 1. **Explicit env override** (`NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL`):
 *    used verbatim when present and not a dead tunnel host.
 * 2. **Browser environment** (`typeof window !== "undefined"`): a SAME-ORIGIN
 *    RELATIVE path for EVERY hostname — `/api/v1`, `window.location.origin`,
 *    `/ai`. The Next.js rewrites in next.config.js resolve the backend
 *    server-side. Nothing about the browser's URL reaches the backend config.
 * 3. **Server/SSR environment**: absolute loopback, since a server-side fetch
 *    does not go through the rewrite proxy.
 *
 * Why same-origin everywhere (and never `https://<host>:4000`):
 *   * a Dev Tunnel exposes only its own origin — `:4000` on the tunnel host is
 *     not forwarded, so an absolute port URL yields ERR_CONNECTION_REFUSED;
 *   * any absolute cross-origin URL additionally requires CORS on the backend;
 *   * a relative path keeps working when a tunnel is reissued or expires,
 *     because the proxy target is resolved on the Next.js SERVER, where the
 *     tunnel hostname is irrelevant.
 */

/**
 * Browser check, evaluated PER CALL.
 *
 * Deliberately not a module-level `const isBrowser = typeof window !==
 * "undefined"`: that snapshots the answer at import time, which is wrong the
 * moment a module instance is ever evaluated in a mixed environment (SSR and
 * browser in one process, a test that installs `window` after the import, or a
 * worker). A function is always correct and costs nothing.
 */
function isBrowser(): boolean {
  return typeof window !== "undefined";
}

type PublicEnvKey =
  | "NEXT_PUBLIC_API_URL"
  | "NEXT_PUBLIC_WS_URL"
  | "NEXT_PUBLIC_SOCKET_URL"
  | "NEXT_PUBLIC_AI_ENGINE_URL";

/**
 * Read a `NEXT_PUBLIC_*` value safely in EVERY runtime: the browser bundle,
 * the Node/SSR runtime, and unit tests.
 *
 * Two independent hazards are handled here, and both must be respected:
 *
 *  1. `process` may not be DECLARED at all in the browser. Optional chaining
 *     does NOT help: `process?.env` still throws `ReferenceError: process is
 *     not defined`, because the identifier is resolved before `?.` applies.
 *     The ONLY safe test for an undeclared identifier is `typeof`, so the
 *     guard must short-circuit BEFORE `process` is ever dereferenced.
 *
 *  2. The read must be a LITERAL `process.env.NEXT_PUBLIC_X` member
 *     expression, because that is the only form Next's `DefinePlugin` can
 *     statically replace with a string at build time. A dynamic lookup
 *     (`process.env[key]`) is left as a real runtime `process.env` access, and
 *     so is the optional-member form `process.env?.X` — either one ships a
 *     live `process` reference into the client bundle and throws in the
 *     browser. A `switch` over literal keys keeps the call sites dynamic while
 *     every actual read stays statically analysable.
 */
export function readPublicEnv(key: PublicEnvKey): string | undefined {
  // Short-circuit on `typeof` — reaching `process` below is only safe once we
  // know it is declared.
  if (typeof process === "undefined") return undefined;
  if (!process.env) return undefined; // declared but env-less (browser shim)
  switch (key) {
    case "NEXT_PUBLIC_API_URL":
      return process.env.NEXT_PUBLIC_API_URL;
    case "NEXT_PUBLIC_WS_URL":
      return process.env.NEXT_PUBLIC_WS_URL;
    case "NEXT_PUBLIC_SOCKET_URL":
      return process.env.NEXT_PUBLIC_SOCKET_URL;
    case "NEXT_PUBLIC_AI_ENGINE_URL":
      return process.env.NEXT_PUBLIC_AI_ENGINE_URL;
    default:
      return undefined;
  }
}


/**
 * STALE-TUNNEL OVERRIDE GUARD.
 *
 * A `NEXT_PUBLIC_*` override that points at a Dev Tunnel is only meaningful
 * when the browser is actually being served FROM that same tunnel. A tunnel
 * that was reissued (new id) or expired leaves a dead host in `.env.local`,
 * and because the env override has the highest priority it wins over every
 * other rule — producing ERR_NAME_NOT_RESOLVED on every /api/v1 request and a
 * dead `wss://…-4000.…` handshake, even though local ports 4000/8000 are up.
 *
 * Rule: when the override's host is a tunnel host and the live page is served
 * from a DIFFERENT host (or from localhost), the override is stale → ignore it
 * and resolve relatively/loopback. Warn once so the dead value is discoverable
 * instead of silently ignored.
 */
export function isStaleTunnelOverride(raw: string | null | undefined): boolean {
  if (!raw || typeof raw !== "string") return false;
  let host: string;
  try {
    host = new URL(raw.trim()).hostname;
  } catch {
    return false; // not an absolute URL — it is a path, not a stale host
  }
  if (!host.includes("devtunnels.ms") && !host.includes("tunnels.api.visualstudio.com")) {
    return false;
  }
  if (!isBrowser()) return false;
  const live = window.location.hostname;
  if (host === live) return false; // genuinely serving from that tunnel
  const warnKey = `po-stale-tunnel:${host}`;
  if (!window.sessionStorage?.getItem(warnKey)) {
    try {
      window.sessionStorage?.setItem(warnKey, "1");
    } catch {
      /* storage disabled — the warning below is best-effort */
    }
    console.warn(
      `[config] Ignoring stale tunnel override "${host}" — this page is served from ` +
        `"${live}". Falling back to same-origin/loopback URLs. Update ` +
        `NEXT_PUBLIC_* in .env.local (or clear them to use the Next.js rewrites).`,
    );
  }
  return true;
}

/** A usable override: non-empty AND not a dead/stale tunnel host. */
function usableOverride(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  return isStaleTunnelOverride(raw) ? null : raw.trim();
}

/**
 * Robust local-host detection — any hostname that is NOT local is treated as
 * a remote/tunnel origin. This is deliberately permissive so new Dev Tunnel
 * formats (e.g. `*.tunnels.api.visualstudio.com`, `*.loca.lt`) are always
 * routed through the Next.js rewrites instead of a hardcoded localhost.
 */
function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local") ||
    hostname.endsWith("local") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("172.") ||
    hostname.startsWith("169.254.") ||
    hostname === "host.docker.internal"
  );
}

export function getApiBaseUrl(): string {
  // Explicit override, read through the guarded/inlinable accessor. On the
  // client this is a no-op when `process` is absent, and the relative-path
  // branch below takes over.
  const envApi = usableOverride(readPublicEnv("NEXT_PUBLIC_API_URL"));
  if (envApi) {
    return envApi;
  }

  if (isBrowser()) {
    // ── SAME-ORIGIN RELATIVE PATH — for EVERY hostname ──
    //
    // This applies to localhost AND to remote/tunnel origins. An earlier
    // revision special-cased non-local hosts to
    // `https://<hostname>:4000/api/v1`, which is unreachable in exactly the
    // environments that needed it:
    //   * a Dev Tunnel terminates TLS on 443 only — `:4000` on the tunnel host
    //     is not forwarded, so the browser got ERR_CONNECTION_REFUSED;
    //   * the request was then also cross-origin, so it needed CORS on top;
    //   * on a bare VPS the backend may not even listen on 4000 publicly.
    //
    // A RELATIVE path is strictly better: the browser only ever talks to the
    // origin that served the page, so there is no CORS, no loopback reference,
    // and no dependency on which ports a tunnel happens to expose. The
    // Next.js rewrites in next.config.js resolve the backend SERVER-side,
    // where the tunnel hostname and the browser's port are irrelevant.
    return "/api/v1";
  }

  // ── SERVER-SIDE (SSR/Build time) ──
  // Server-side fetches bypass the browser and talk to the backend directly.
  return "http://localhost:4000/api/v1";
}

export function getWsUrl(): string {
  const envSocket = usableOverride(readPublicEnv("NEXT_PUBLIC_SOCKET_URL"));
  if (envSocket) {
    return envSocket;
  }
  const envWs = usableOverride(readPublicEnv("NEXT_PUBLIC_WS_URL"));
  if (envWs) {
    return envWs;
  }

  if (isBrowser()) {
    // ── SAME-ORIGIN — for EVERY hostname, including Dev Tunnels ──
    //
    // Socket.IO then requests "/socket.io/?EIO=4…" on the page's own origin,
    // which next.config.js rewrites to the backend. An earlier revision
    // rewrote the origin's port segment (-3000. → -4000.) on tunnels, which
    // required a SECOND tunnel to be running; when it was not, every
    // handshake died with ERR_CONNECTION_REFUSED. Same-origin needs no second
    // tunnel and no CORS.
    return window.location.origin;
  }

  return "http://localhost:4000";
}

export function getAiEngineUrl(): string {
  const envAi = usableOverride(readPublicEnv("NEXT_PUBLIC_AI_ENGINE_URL"));
  if (envAi) {
    return envAi;
  }

  if (isBrowser()) {
    // Same reasoning as getApiBaseUrl: relative for every hostname, resolved
    // server-side by the "/ai/:path*" rewrite.
    return "/ai";
  }

  return "http://localhost:8000/api/v1";
}

/**
 * Returns true if the app is being accessed through a Dev Tunnel
 * or any remote/production URL (not localhost).
 */
export function isRemoteTunnel(): boolean {
  if (!isBrowser()) return false;
  return !isLocalHost(window.location.hostname);
}
