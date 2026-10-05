import type { NextFunction, Request, Response } from "express";

// Local dev only. Everything else must be listed EXPLICITLY below or via env.
// No wildcard/pattern matching: a reflected origin combined with
// `credentials: true` lets any site that can register a matching hostname read
// authenticated responses. Dev Tunnels hand out `*.devtunnels.ms` subdomains to
// whoever asks, so "any *.devtunnels.ms" is equivalent to "any origin".
const BASE_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

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

export function corsOriginResolver(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  // Same-origin/non-CORS callers (curl, health probes, SSR) send no Origin.
  if (!origin || isAllowedCorsOrigin(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`Origin ${origin} not allowed by CORS`));
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
};