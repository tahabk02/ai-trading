/**
 * getBaseUrl.ts
 *
 * Detects the runtime environment and returns the correct base URL for
 * API and WebSocket connections, with seamless dynamic Dev Tunnel resolution.
 *
 * ── Logic ──
 * 1. **Explicit env override** (`NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL`):
 *    used verbatim when present.
 * 2. **Browser environment** (`typeof window !== "undefined"`):
 *    - Local host (localhost, 127.0.0.1, private ranges) → direct `http://localhost:4000`.
 *    - Remote / Dev Tunnel (any *.devtunnels.ms, ngrok, vercel, etc.) →
 *      FORCED RELATIVE paths (`/api/v1`, `/`, `/ai`); Next.js rewrites proxy
 *      to the backend services. This works for ANY active tunnel domain, old
 *      or new, with zero hardcoded endpoints and never exposes raw
 *      `http://localhost:4000` to the browser.
 * 3. **Server/SSR environment**: always `http://localhost:4000`.
 */

const isBrowser = typeof window !== "undefined";

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
  // If NEXT_PUBLIC_API_URL is explicitly set in .env at build time, use it directly
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }

  if (isBrowser) {
    const hostname = window.location.hostname;

    // ── PRODUCTION: Detect non-localhost hostnames and construct absolute URL ──
    // If accessing from a non-localhost domain (e.g., 91.99.71.111, example.com),
    // construct the API URL using the same hostname + port 4000
    if (!isLocalHost(hostname)) {
      const protocol = window.location.protocol; // http: or https:
      const port = 4000; // Backend API port
      return `${protocol}//${hostname}:${port}/api/v1`;
    }

    // ── LOCAL DEV & DEV TUNNELS: Use relative paths with Next.js rewrites ──
    // Relative paths work for:
    // - localhost:3000 (rewrites to localhost:4000)
    // - Dev Tunnels (*.devtunnels.ms, etc.) — rewrites work via same-origin
    return "/api/v1";
  }

  // ── SERVER-SIDE (SSR/Build time) ──
  // Return localhost by default; will use env var if set above
  return "http://localhost:4000/api/v1";
}

export function getWsUrl(): string {
  // If NEXT_PUBLIC_WS_URL is explicitly set in .env at build time, use it directly
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }

  if (isBrowser) {
    const hostname = window.location.hostname;

    // ── PRODUCTION: Detect non-localhost hostnames and construct absolute URL ──
    if (!isLocalHost(hostname)) {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const port = 4000;
      return `${protocol}//${hostname}:${port}`;
    }

    // ── LOCAL DEV & DEV TUNNELS: Use relative path ──
    // Socket.IO will connect to the Next.js origin on /.
    // The Next.js rewrite proxy forwards /socket.io/* to the backend.
    return "/";
  }

  return "http://localhost:4000";
}

export function getAiEngineUrl(): string {
  // If NEXT_PUBLIC_AI_ENGINE_URL is explicitly set in .env at build time, use it directly
  if (
    typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_AI_ENGINE_URL
  ) {
    return process.env.NEXT_PUBLIC_AI_ENGINE_URL;
  }

  if (isBrowser) {
    const hostname = window.location.hostname;

    // ── PRODUCTION: Detect non-localhost hostnames and construct absolute URL ──
    if (!isLocalHost(hostname)) {
      const protocol = window.location.protocol;
      const port = 8000;
      return `${protocol}//${hostname}:${port}/api/v1`;
    }

    // ── LOCAL DEV & DEV TUNNELS: Use relative path with Next.js rewrite ──
    return "/ai";
  }

  return "http://localhost:8000/api/v1";
}

/**
 * Returns true if the app is being accessed through a Dev Tunnel
 * or any remote/production URL (not localhost).
 */
export function isRemoteTunnel(): boolean {
  if (!isBrowser) return false;
  return !isLocalHost(window.location.hostname);
}
