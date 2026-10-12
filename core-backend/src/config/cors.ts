import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger";

// Local dev only. Everything else must be listed EXPLICITLY below or via env.
// No wildcard/pattern matching: a reflected origin combined with
// `credentials: true` lets any site that can register a matching hostname read
// authenticated responses. Dev Tunnels hand out `*.devtunnels.ms` subdomains to
// whoever asks, so "any *.devtunnels.ms" is equivalent to "any origin".
const BASE_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

function originFromValue(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function splitOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Explicit, exact-match allowlist. Populate with:
 *   CORS_ORIGIN                 comma-separated extra web origins
 *   NEXT_PUBLIC_API_URL         comma-separated extra web origins
 *   CORS_ALLOWED_TUNNEL_ORIGINS comma-separated FULL tunnel origins, e.g.
 *                               https://b3lrfrj9-3000.uks1.devtunnels.ms
 * Values are normalised to `URL.origin`, so a trailing slash or path is dropped.
 * An unparseable entry (including a bare `*`) is ignored rather than honoured.
 */
const configuredOrigins = [
  ...splitOrigins(process.env.CORS_ORIGIN),
  ...splitOrigins(process.env.NEXT_PUBLIC_API_URL),
  ...splitOrigins(process.env.CORS_ALLOWED_TUNNEL_ORIGINS),
]
  .map(originFromValue)
  .filter((value): value is string => Boolean(value));

export const allowedOrigins = Array.from(
  new Set([...BASE_ALLOWED_ORIGINS, ...configuredOrigins]),
);

/**
 * Exact string equality against the allowlist. There is deliberately no
 * hostname-suffix test here — a suffix match on a shared hosting domain is the
 * bug this function previously had.
 */
export function isAllowedCorsOrigin(origin: string): boolean {
  return allowedOrigins.includes(origin);
}

/** Rate-limit for rejected-origin logs (one line per origin per window). */
const REJECT_LOG_INTERVAL_MS = 60_000;
const lastRejectLoggedAt: Map<string, number> = new Map();

/**
 * Dynamic origin resolver.
 *
 * `origin: "*"` is ILLEGAL together with `credentials: true` — browsers reject
 * `Access-Control-Allow-Origin: *` on a credentialed request, so a wildcard
 * "fix" makes the failure worse. The correct pattern is to REFLECT the caller's
 * exact origin, which is what this resolver does for allowlisted origins only:
 * the configured localhost/production origins plus any tunnel origin explicitly
 * registered in `CORS_ALLOWED_TUNNEL_ORIGINS`.
 *
 * A rejected origin resolves to `false` (no CORS headers) instead of throwing.
 * Throwing pushed the error into the global handler, which answered 500 with no
 * CORS headers — the browser then reported only "missing
 * Access-Control-Allow-Origin", hiding the real request/response. Denying keeps
 * the actual status visible in the network tab while still blocking the read.
 */
export function corsOriginResolver(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  // Same-origin/non-CORS callers (curl, health probes, SSR) send no Origin.
  if (!origin || isAllowedCorsOrigin(origin)) {
    callback(null, true);
    return;
  }
  const now = Date.now();
  const lastLogged = lastRejectLoggedAt.get(origin) ?? 0;
  if (now - lastLogged >= REJECT_LOG_INTERVAL_MS) {
    lastRejectLoggedAt.set(origin, now);
    logger.warn("[CORS] Origin rejected — no CORS headers sent", {
      origin,
      allowed: allowedOrigins,
    });
  }
  callback(null, false);
}

export function privateNetworkMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.header("Access-Control-Request-Private-Network") === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
}

export const corsOptions = {
  origin: corsOriginResolver,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Access-Control-Allow-Origin",
    "Access-Control-Request-Private-Network",
  ],
  /**
   * Preflight handling: answer the browser's OPTIONS probe directly (do not
   * continue into routing/handlers) with a bare 204, and let the browser cache
   * the preflight so a 1Hz dashboard does not re-preflight every request.
   */
  optionsSuccessStatus: 204,
  preflightContinue: false,
  maxAge: 86_400,
};