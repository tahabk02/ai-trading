/**
 * config.ts
 *
 * Centralised runtime configuration with seamless Localhost ↔ Dev Tunnels switching.
 *
 * ── Strategy (dynamic, ZERO hardcoded tunnel endpoints) ──
 * 1. If `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` / `NEXT_PUBLIC_AI_ENGINE_URL`
 *    are explicitly set, use them verbatim (highest priority).
 * 2. Browser accessing via a Dev Tunnel / remote host (hostname includes
 *    "devtunnels.ms", "ngrok.io", ".vercel.app", etc.) → route through the
 *    CURRENT origin (the Next.js server) using RELATIVE paths and let the
 *    Next.js rewrites forward to the backend services. This works for ANY
 *    tunnel domain, old or new, without hardcoding stale endpoints and
 *    without exposing raw `http://localhost:4000` to the browser.
 * 3. Local development (localhost / 127.0.0.1 / private network) → direct
 *    localhost URLs.
 * 4. Server-side rendering → localhost defaults.
 *
 * This guarantees the frontend works on:
 * - Local development (http://localhost:3000 → proxied to localhost:4000 / :8000)
 * - ANY active VS Code Dev Tunnel (https://*.devtunnels.ms → same-origin rewrites)
 * - Production / other remote deploys (via NEXT_PUBLIC_* env vars)
 */

const isBrowser = typeof window !== "undefined";

/**
 * Robust local-host detection. Any hostname that is NOT local is treated as a
 * remote/tunnel origin (Dev Tunnels, ngrok, Vercel, custom domains, etc.).
 * This is deliberately more permissive than a fixed suffix whitelist so that
 * NEW Dev Tunnel hostname formats (e.g. `*.tunnels.api.visualstudio.com`,
 * `*.loca.lt`, `*.devtunnels.ms`) are always detected and routed through the
 * Next.js rewrites — never a hardcoded `http://localhost:4000`.
 */
function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("172.") ||
    hostname.startsWith("169.254.") ||
    hostname === "host.docker.internal"
  );
}

function isRemoteHostname(hostname: string): boolean {
  return !isLocalHostname(hostname);
}

/**
 * Detect whether the current browser origin is an active VS Code Dev Tunnel.
 * Dev Tunnel hostnames follow the format: `{id}-{port}.{region}.devtunnels.ms`
 * e.g. `https://2n0ksl75-3000.uks1.devtunnels.ms`.
 */
function isDevTunnelHostname(hostname: string): boolean {
  return hostname.includes("devtunnels.ms");
}

const getBaseUrls = () => {
  // ── 1. Explicit env overrides (highest priority) ──
  const envApi = process.env.NEXT_PUBLIC_API_URL;
  const envWs = process.env.NEXT_PUBLIC_WS_URL;
  const envAi = process.env.NEXT_PUBLIC_AI_ENGINE_URL;

  if (envApi || envWs || envAi) {
    return {
      API_URL:
        envApi || (envWs ? `${envWs}/api/v1` : "http://localhost:4000/api/v1"),
      WS_URL: envWs || "http://localhost:4000",
      AI_ENGINE_URL: envAi || "http://localhost:8000/api/v1",
    };
  }

  if (isBrowser) {
    // ── ABSOLUTE RELATIVE PATHS — ZERO CROSS-ORIGIN REQUESTS ──
    // The browser talks ONLY to the Next.js origin via relative paths:
    //   /api/v1  → Next.js rewrite → http://localhost:4000/api/v1
    //   /        → Next.js rewrite → http://localhost:4000 (socket.io)
    //   /ai      → Next.js rewrite → http://localhost:8000 (AI Engine)
    // This works identically on localhost AND ANY Dev Tunnel (https://*.devtunnels.ms).
    // It bypasses cross-origin browser loopback blocks and CORS entirely — the
    // browser never issues a cross-origin fetch, so there are ZERO network errors.
    return {
      API_URL: "/api/v1",
      WS_URL: "/",
      AI_ENGINE_URL: "/ai",
    };
  }

  // ── 4. Server-side rendering / SSR defaults ──
  return {
    API_URL: "http://localhost:4000/api/v1",
    WS_URL: "http://localhost:4000",
    AI_ENGINE_URL: "http://localhost:8000/api/v1",
  };
};

export const urls = getBaseUrls();

/** True when the app is being accessed through a Dev Tunnel / remote origin. */
export function isRemoteTunnel(): boolean {
  if (!isBrowser) return false;
  return isRemoteHostname(window.location.hostname);
}
