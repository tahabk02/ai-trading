/**
 * internalAuth.middleware.ts — PART 44.1 [503]
 *
 * Two internal-surface guards for routes that were previously OPEN:
 *
 *   • `requireAiEngineKey` — POST /api/v1/signals/receive. The AI engine is the
 *     only legitimate caller; it must present the service-to-service shared
 *     secret in the `X-API-Key` header (the SAME `AI_ENGINE_API_KEY` the
 *     backend already sends outbound, and that the engine verifies inbound in
 *     `ai-engine/app/api/deps.py`). Fails CLOSED in production when the secret
 *     is unset (503), so an unconfigured backend rejects service traffic rather
 *     than trusting it.
 *
 *   • `requireAdminKey` — GET /api/v1/audit/execution-logs. This is an operator
 *     read surface for signal/trade decisions; it is gated behind the platform
 *     admin key (`PO_HEALTH_ADMIN_KEY`, `X-PO-Admin-Key`) with the same
 *     semantics as the mutating /health/po-auth routes: hosted + no key → 404
 *     (disabled), dev + no key → loopback only, key set → every caller must
 *     present it (missing 401 / mismatch 403).
 *
 * Both comparisons are constant-time (SHA-256 + `crypto.timingSafeEqual`).
 * `requireAdminKey` mirrors `poAuthRefreshGuard` (routes/health.routes.ts);
 * it is re-implemented here rather than imported so the audit router does not
 * pull in the whole health-router dependency graph.
 */

import { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "crypto";
import { secrets } from "../config/secrets";
import { logger } from "../utils/logger";

const HEADER_AI_ENGINE_KEY = "x-api-key";
const HEADER_ADMIN_KEY = "x-po-admin-key";
// The dev-only fallback in config/secrets.ts — never a real secret, so it does
// not count as "configured" and must not gate production traffic.
const DEV_INTERNAL_KEY = "dev-internal-service-key";

function safeEqualString(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function isProduction(): boolean {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function clientIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || "");
}

function isLoopbackIp(ip: string): boolean {
  const v = (ip || "").trim();
  return (
    v === "localhost" ||
    v === "::1" ||
    v.startsWith("127.") ||
    v.startsWith("::ffff:127.")
  );
}

/**
 * POST /signals/receive — service-to-service shared secret.
 *
 *   • secret configured (non-default): missing header → 401, mismatch → 403,
 *     match → pass. There is no loopback bypass.
 *   • secret unconfigured: production → 503 (fail closed); dev/test → pass
 *     (both services run on one trusted host).
 */
export function requireAiEngineKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = String(secrets.AI_ENGINE_API_KEY || "").trim();
  const configured = expected.length > 0 && expected !== DEV_INTERNAL_KEY;

  if (!configured) {
    if (isProduction()) {
      logger.error("signal_receive_rejected_unconfigured_key");
      res.status(503).json({
        error: "AI_ENGINE_API_KEY is not configured on the backend",
      });
      return;
    }
    next();
    return;
  }

  const supplied = String(req.get(HEADER_AI_ENGINE_KEY) || "").trim();
  if (supplied && safeEqualString(supplied, expected)) {
    next();
    return;
  }
  logger.warn("signal_receive_rejected", {
    reason: supplied ? "invalid_key" : "missing_key",
    ip: clientIp(req),
  });
  res.status(supplied ? 403 : 401).json({
    error: supplied
      ? "forbidden: invalid X-API-Key"
      : "unauthorized: X-API-Key required",
  });
}

/**
 * GET /audit/execution-logs — operator admin key (mirrors poAuthRefreshGuard).
 */
export function requireAdminKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const configured = String(secrets.PO_HEALTH_ADMIN_KEY || "").trim();

  if (!configured) {
    if (secrets.PO_HEALTH_HOSTED) {
      res.status(404).json({ error: "Not Found" });
      return;
    }
    if (isLoopbackIp(clientIp(req))) {
      next();
      return;
    }
    res.status(403).json({
      error:
        "forbidden: internal-only — set PO_HEALTH_ADMIN_KEY to allow a remote caller",
    });
    return;
  }

  const supplied = String(req.get(HEADER_ADMIN_KEY) || "").trim();
  if (supplied && safeEqualString(supplied, configured)) {
    next();
    return;
  }
  res.status(supplied ? 403 : 401).json({
    error: supplied
      ? "forbidden: invalid X-PO-Admin-Key"
      : "unauthorized: X-PO-Admin-Key required",
  });
}
