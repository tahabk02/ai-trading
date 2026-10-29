import { Router, Request, Response, NextFunction } from "express";
import { timingSafeEqual, createHash } from "crypto";
import { PrismaClient } from "@prisma/client";
import { CacheService } from "../services/cache.service";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";
import axios from "axios";
import { forexDataService } from "../services/forexData.service";
import { realtimeTickBuffer } from "../services/realtimeTickBuffer.service";
import { pocketOptionBridgeService } from "../services/pocketOptionBridge.service";
import { poAuthManager } from "../services/poAuthManager";
import { orderbookHealth } from "../controllers/orderbook.controller";
import { historyCollector } from "../services/historyCollector.service";
import packageJson from "../../package.json";
import { allowedOrigins } from "../config/cors";
import { buildClockSnapshot } from "./time.routes";

// MASTER MISSION 1.3 — byte-truth service version read straight from the
// built package (never a hand-edited duplicate string).
export const SERVICE_VERSION: string = String(packageJson.version ?? "0.0.0");

const router = Router();
const prisma = new PrismaClient();

// ── AI ENGINE HEALTH PROBE ──
// GET /api/v1/health/ai — probes the Python AI Engine's own /api/v1/health and
// reports { status, latency_ms, last_error }. `status` is "up" when the engine
// answered, "down" on timeout/refused/5xx. `last_error` carries the most
// recent failure detail (null on the first healthy probe). Short timeout: this
// endpoint must never back-pressure the API surface.
const AI_ENGINE_HEALTH_URL = `${(secrets.AI_ENGINE_URL || "http://ai-engine:8000").replace(/\/+$/, "")}/api/v1/health`;
const AI_HEALTH_TIMEOUT_MS = 2_000;
let lastAiError: string | null = null;

/**
 * GET /health (root, MASTER MISSION 1.3)
 *
 * Lightweight liveness: always answers 200 with a JSON body carrying uptime
 * and the built service version. Never performs DB/cache probes — those live
 * on /api/v1/health so a single failing dependency can't take down the
 * autopilot's reachability probe.
 */
export function rootHealthBody(): {
  status: "ok";
  uptime: number;
  version: string;
  service: string;
  timestamp: string;
} {
  return {
    status: "ok",
    uptime: Math.round(process.uptime() * 10) / 10,
    version: SERVICE_VERSION,
    service: "core-backend",
    timestamp: new Date().toISOString(),
  };
}

/**
 * GET /health/ai — one-shot snapshot of the AI engine probe.
 * Extracted from the /api/v1 router so the ROOT namespace can reuse the exact
 * same probe (same timeout, same last_error cache) without a second copy.
 */
export async function buildAiHealthSnapshot(): Promise<{
  status: string;
  latency_ms: number;
  last_error: string | null;
  timestamp: string;
}> {
  const probe = await probeAiEngineHealth();
  return {
    status: probe.status,
    latency_ms: probe.latency_ms,
    last_error: lastAiError,
    timestamp: new Date().toISOString(),
  };
}

/**
 * GET /health/data — one snapshot function shared by /api/v1/health/data and
 * the root /health/data (single source of truth for source health).
 */
export function buildDataHealthSnapshot(): {
  status: string;
  sources: {
    name: string;
    status: string;
    last_ok_ts: number | null;
    last_error: string | null;
  }[];
  timestamp: string;
} {
  const sources = Object.entries(forexDataService.getSourceHealth()).map(
    ([name, health]) => ({
      name,
      status: health.ok ? "ok" : "down",
      last_ok_ts: health.ok ? health.lastCheck : null,
      last_error: health.lastError,
    }),
  );
  const status =
    sources.length === 0
      ? "degraded"
      : sources.some((source) => source.status === "ok")
        ? "ok"
        : "down";
  return { status, sources, timestamp: new Date().toISOString() };
}

/**
 * Root health router — the routes the autopilot actually probes on :4000
 * (GET /health, GET /health/ai, GET /health/data). Mounted on the app root in
 * index.ts so `curl localhost:4000/health` answers 200 instead of 404.
 */
export const rootHealthRouter: Router = (() => {
  const r = Router();
  r.get("/", (_req: Request, res: Response) => {
    res.json(rootHealthBody());
  });
  r.get("/cors", (_req: Request, res: Response) => {
    res.json({ allowed: allowedOrigins });
  });
  r.get("/clock", (_req: Request, res: Response) => {
    res.json(buildClockSnapshot());
  });
  r.get("/ai", async (_req: Request, res: Response) => {
    try {
      res.json(await buildAiHealthSnapshot());
    } catch (err) {
      logger.error("Health check: ai probe crashed", { error: err });
      res.status(503).json({
        status: "down",
        latency_ms: 0,
        last_error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  });
  r.get("/data", (_req: Request, res: Response) => {
    const body = buildDataHealthSnapshot();
    res.status(body.status === "down" ? 503 : 200).json(body);
  });
  r.get("/feed", (_req: Request, res: Response) => {
    res.json(buildFeedHealthSnapshot());
  });
  r.get("/orderbook", (_req: Request, res: Response) => {
    res.json({
      status: orderbookHealth.last_error == null ? "ok" : "down",
      latency_ms: orderbookHealth.last_latency_ms,
      last_error: orderbookHealth.last_error,
      last_ok_ts: orderbookHealth.last_ok_ts,
      timestamp: new Date().toISOString(),
    });
  });
  // GET /health/history?symbol=XYZ — 30-minute persisted-window proof for one
  // asset (Alpha.5 Pro Part 3). Mirrors /api/v1/health/history on the ROOT
  // namespace so the autopilot probes stay consistent.
  r.get("/history", async (req: Request, res: Response) => {
    const symbol = String(req.query.symbol ?? req.query.s ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) {
      res.status(400).json({ error: "symbol is required" });
      return;
    }
    try {
      const health = await historyCollector.getHistoryHealth(symbol);
      res.status(health.window_complete ? 200 : 202).json(health);
    } catch (err) {
      logger.error("Health check: history probe crashed", { error: err });
      res.status(503).json({
        symbol,
        bars_30m: 0,
        ticks_30m: 0,
        min_bucket_ms: null,
        max_bucket_ms: null,
        window_complete: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  // GET /health/ticks?symbol=XYZ&n=30 — tape diagnostic (PART 43.5 [472]).
  r.get("/ticks", (req: Request, res: Response) => {
    const symbol = String(req.query.symbol ?? req.query.s ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) {
      res.status(400).json({ error: "symbol is required" });
      return;
    }
    const n = Math.min(Math.max(Number(req.query.n) || 30, 1), 200);
    res.json(buildTapeDebugSnapshot(symbol, n));
  });
  // GET /health/po-auth — PO session/credential self-healing posture (PART on
  // SSID automation). Observational: never mutates state.
  r.get("/po-auth", (_req: Request, res: Response) => {
    res.json(poAuthManager.buildSnapshot());
  });
  // POST /health/po-auth/refresh — trigger a background SSID refresh.
  // GUARDED (PART 43.6 [480]): admin key or internal-only.
  r.post(
    "/po-auth/refresh",
    poAuthRefreshGuard,
    async (req: Request, res: Response) => {
      res.json(await runPoAuthRefresh(req.query.reason));
    },
  );
  // POST /health/po-auth/reset — HUMAN-ONLY circuit-breaker reset.
  r.post(
    "/po-auth/reset",
    poAuthRefreshGuard,
    (req: Request, res: Response) => {
      res.json(runPoAuthReset(req.query.reason));
    },
  );
  return r;
})();

async function probeAiEngineHealth(): Promise<{
  status: string;
  latency_ms: number;
}> {
  const t0 = Date.now();
  try {
    const { data } = await axios.get<unknown>(AI_ENGINE_HEALTH_URL, {
      timeout: AI_HEALTH_TIMEOUT_MS,
      headers: { "X-API-Key": secrets.AI_ENGINE_API_KEY },
    });
    lastAiError = null;
    return {
      status:
        typeof data === "object" &&
        data !== null &&
        (data as Record<string, unknown>).status
          ? String((data as Record<string, unknown>).status)
          : "up",
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastAiError = msg;
    return { status: "down", latency_ms: Date.now() - t0 };
  }
}

/**
 * GET /health/ai
 *
 * Returns the AI Engine's reachability/health. Purely observational — never
 * mutates engine state. When the engine is down the endpoint still answers
 * 200 with status "down" so operators/health-checkers get a structured body
 * (never a bare 503) and can diff latency_ms across calls.
 */
router.get("/ai", async (_req: Request, res: Response) => {
  try {
    res.json(await buildAiHealthSnapshot());
  } catch (err) {
    logger.error("Health check: ai probe crashed", { error: err });
    res.status(503).json({
      status: "down",
      latency_ms: 0,
      last_error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /health/feed — one snapshot function shared by /api/v1/health/feed and
 * the root /health/feed (single source of truth for live-feed health).
 *
 *   status: "live" | "degraded" | "awaiting_ssid" | "auth_failed"
 *   last_tick_ts   ISO instant of the newest GENUINE tick on the real tape.
 *   ticks_received session-lifetime real tick count (ring-buffer service).
 *   candles_emitted session-lifetime count of REAL candles written (PO M20
 *                  bars + live-tick bucket rollovers).
 *
 * Every number is real observed data — never fabricated by this endpoint.
 */
export function buildFeedHealthSnapshot(): {
  status: "live" | "degraded" | "awaiting_ssid" | "auth_failed";
  last_tick_ts: string | null;
  ticks_received: number;
  candles_emitted: number;
  /** Age of the newest PO-sourced tick (null = none this session). */
  po_tick_age_ms: number | null;
  /** True when no fresh PO tick is reaching the tape (proxy owns the feed). */
  po_offline: boolean;
  detail: string;
  timestamp: string;
} {
  const feed = pocketOptionBridgeService.getCurrentFeedStatus().status;
  let status: "live" | "degraded" | "awaiting_ssid" | "auth_failed";
  if (feed === "live") status = "live";
  else if (feed === "awaiting_ssid") status = "awaiting_ssid";
  else if (feed === "auth_failed") status = "auth_failed";
  else status = "degraded";

  const tracked = realtimeTickBuffer.getTrackedSymbols();
  let ticks = 0;
  for (const symbol of tracked) ticks += realtimeTickBuffer.getTickCount(symbol);
  const poTickAgeMs = realtimeTickBuffer.getGlobalPoFreshAgeMs();

  return {
    status,
    last_tick_ts: realtimeTickBuffer.getGlobalLastTickAt() ?? null,
    ticks_received: ticks,
    candles_emitted: forexDataService.getCandleEmissionCount(),
    po_tick_age_ms: poTickAgeMs,
    po_offline: poTickAgeMs == null || poTickAgeMs > 15_000,
    detail: feed,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Trigger a background Pocket Option SSID refresh (session tier, then the
 * opt-in last-resort credential tier) and return the outcome plus a fresh
 * auth snapshot. Best-effort: `poAuthManager.refresh` never throws, so this can
 * never 5xx the health surface.
 */
async function runPoAuthRefresh(reasonRaw: unknown): Promise<{
  ok: boolean;
  method: string;
  durationMs: number;
  reason: string;
  error?: string;
  snapshot: ReturnType<typeof poAuthManager.buildSnapshot>;
}> {
  const reason =
    typeof reasonRaw === "string" && reasonRaw.trim()
      ? reasonRaw.trim()
      : "manual";
  const result = await poAuthManager.refresh(reason, { humanReset: true });
  return { ...result, snapshot: poAuthManager.buildSnapshot() };
}

/**
 * Human-triggered circuit-breaker reset (PART 43.6 [480]): clears the open
 * circuit / challenge interlock after the operator has investigated. Mutation
 * is intentional here — a human decided to retry.
 */
function runPoAuthReset(reasonRaw: unknown): {
  ok: true;
  reason: string;
  snapshot: ReturnType<typeof poAuthManager.buildSnapshot>;
} {
  const reason =
    typeof reasonRaw === "string" && reasonRaw.trim()
      ? reasonRaw.trim()
      : "operator";
  poAuthManager.resetBreaker(reason);
  return { ok: true, reason, snapshot: poAuthManager.buildSnapshot() };
}

/**
 * PART 43.7 [486] — client IP derivation for the mutating-route guard.
 *
 * `req.ip` is used, NOT the raw socket address, because the service sits behind
 * a reverse proxy (DevTunnels / nginx) that terminates TLS and appends the real
 * client to `X-Forwarded-For`. `index.ts` sets `app.set("trust proxy", 1)` so
 * Express trusts exactly ONE hop: `req.ip` becomes the address that trusted
 * proxy reported (the real client). A caller cannot forge it by sending its own
 * `X-Forwarded-For` — spoofed entries sit to the LEFT of the trusted hop and are
 * ignored. With no trust-proxy setting, `req.ip` would be the proxy's loopback
 * address for EVERY remote caller, which is precisely why the hosted posture
 * fails closed instead of trusting "loopback" (see below).
 */
function clientIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || "");
}

/** Loopback (IPv4/IPv6, incl. IPv4-mapped) — dev-only convenience path. */
export function isLoopbackIp(ip: string): boolean {
  const v = (ip || "").trim();
  return (
    v === "localhost" ||
    v === "::1" ||
    v.startsWith("127.") ||
    v.startsWith("::ffff:127.")
  );
}

/**
 * PART 43.6 [480] / PART 43.7 [486] — POST /health/po-auth/refresh|reset are
 * MUTATING surfaces. They are gated and, when hosted, FAIL CLOSED:
 *
 *   • FAIL CLOSED (hosted): with NO PO_HEALTH_ADMIN_KEY the routes are
 *     effectively DISABLED — 404, indistinguishable from a route that does not
 *     exist. They never fall back to "loopback-only", which a reverse proxy
 *     defeats by presenting the caller on loopback.
 *   • KEY configured (hosted or not): the caller MUST present it in the
 *     `X-PO-Admin-Key` header (constant-time compare). Absent → 401, wrong →
 *     403. There is NO loopback bypass once a key exists.
 *   • DEV only (PO_HEALTH_HOSTED=false, no key): loopback callers pass;
 *     non-loopback → 403. Convenience for local development only.
 *
 * GET /health/po-auth (read-only snapshot) is NOT gated.
 */
export function poAuthRefreshGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const configured = (secrets.PO_HEALTH_ADMIN_KEY || "").trim();

  if (!configured) {
    // Hosted + no key → fail closed: the mutating routes must not exist.
    if (secrets.PO_HEALTH_HOSTED) {
      res.status(404).json({ error: "Not Found" });
      return;
    }
    // Development-only: internal (loopback) callers.
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

  const supplied = (req.get("x-po-admin-key") || "").trim();
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

/**
 * Constant-time string equality. Both inputs are SHA-256 hashed first so hashing
 * runs over fixed-length buffers (no early exit on a length difference) and the
 * comparison itself is `crypto.timingSafeEqual`.
 */
function safeEqualString(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * GET /health/orderbook
 *
 * Reports the /orderbook endpoint's last outcome from the controller's health
 * ledger (`orderbookHealth`): observation only — never mutates state. `status`
 * is "ok" while no upstream failure was recorded, "down" after a timeout /
 * upstream failure until the next successful call.
 */
router.get("/clock", (_req: Request, res: Response) => {
  res.json(buildClockSnapshot());
});

router.get("/orderbook", (_req: Request, res: Response) => {
  res.json({
    status: orderbookHealth.last_error == null ? "ok" : "down",
    latency_ms: orderbookHealth.last_latency_ms,
    last_error: orderbookHealth.last_error,
    last_ok_ts: orderbookHealth.last_ok_ts,
    timestamp: new Date().toISOString(),
  });
});

router.get("/data", (_req: Request, res: Response) => {
  const body = buildDataHealthSnapshot();
  return res.status(body.status === "down" ? 503 : 200).json(body);
});

/**
 * GET /health/ticks?symbol=XYZ&n=30 — PART 43.5 [472] TAPE DIAGNOSTIC.
 *
 * Dumps the last `n` raw ring entries for a symbol (oldest → newest) with the
 * AUTHORING SOURCE, price and timestamp of each. Lets an operator confirm at a
 * glance whether a pair is fed a genuine PO tick or a static market proxy that
 * a fallback re-serves every second (constant price, source != pocket_option*,
 * last tick < 1s old = the PO-offline-proxy hypothesis). Purely observational.
 */
export function buildTapeDebugSnapshot(
  symbol: string,
  n = 30,
): {
  symbol: string;
  count: number;
  newest: {
    price: number;
    iso: string;
    source: string | null;
    heldMsAgo: number;
    stale: boolean;
  } | null;
  distinctPrices: number;
  allPricesConstant: boolean;
  newestSourceIsPo: boolean;
  ticks: ReturnType<typeof realtimeTickBuffer.getTapeDebug>;
} {
  const ticks = realtimeTickBuffer.getTapeDebug(symbol, n);
  const newest = ticks.length > 0 ? ticks[ticks.length - 1] : null;
  const distinct = new Set(ticks.map((t) => t.price));
  return {
    symbol: String(symbol || "").trim().toUpperCase(),
    count: ticks.length,
    newest: newest
      ? {
          price: newest.price,
          iso: newest.iso,
          source: newest.source,
          heldMsAgo: newest.heldMsAgo,
          stale: newest.stale,
        }
      : null,
    distinctPrices: distinct.size,
    allPricesConstant: ticks.length > 1 && distinct.size === 1,
    newestSourceIsPo:
      newest?.source != null && /^pocket_option/i.test(newest.source),
    ticks,
  };
}

/**
 * GET /health/feed — live-feed health snapshot (mirror of root namespace).
 * Reports feed status, last genuine tick, ticks_received and candles_emitted
 * so the market terminal can surface live bridge health.
 */
router.get("/feed", (_req: Request, res: Response) => {
  res.json(buildFeedHealthSnapshot());
});

// GET /health/ticks?symbol=XYZ&n=30 — tape diagnostic (PART 43.5 [472]).
router.get("/ticks", (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? req.query.s ?? "")
    .trim()
    .toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  const n = Math.min(Math.max(Number(req.query.n) || 30, 1), 200);
  res.json(buildTapeDebugSnapshot(symbol, n));
});

/**
 * GET /health/po-auth — Pocket Option SSID self-healing posture.
 *
 * Observational snapshot: whether the opt-in last-resort credential fallback is
 * configured, whether a captured session file exists (and its age), and the
 * outcome of the last refresh. Purely read-only — never mutates state.
 */
router.get("/po-auth", (_req: Request, res: Response) => {
  res.json(poAuthManager.buildSnapshot());
});

/**
 * POST /health/po-auth/refresh — trigger a background SSID refresh via
 * session/refresh_ssid.py (session tier, then the opt-in credential tier).
 * Returns the refresh outcome + a fresh snapshot. Never throws.
 * GUARDED (PART 43.6 [480]): admin key or internal-only. This is the human
 * path and may run while the circuit breaker is open.
 */
router.post(
  "/po-auth/refresh",
  poAuthRefreshGuard,
  async (req: Request, res: Response) => {
    res.json(await runPoAuthRefresh(req.query.reason));
  },
);

/**
 * POST /health/po-auth/reset — HUMAN-ONLY circuit-breaker reset after an
 * operator has investigated (captcha/2FA interlock or 3x login failure).
 * GUARDED like /po-auth/refresh.
 */
router.post(
  "/po-auth/reset",
  poAuthRefreshGuard,
  (req: Request, res: Response) => {
    res.json(runPoAuthReset(req.query.reason));
  },
);

/**
 * GET /health
 *
 * Returns the overall health status of the core backend service,
 * including connectivity checks for the database and cache layer.
 */
router.get("/", async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};

  // ── Database check ──
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "healthy";
  } catch (error) {
    checks.database = "unhealthy";
    logger.error("Health check: database unhealthy", { error });
  }

  // ── Cache check ──
  try {
    const cache = CacheService.getInstance();
    checks.cache = cache.isConnected() ? "healthy" : "disconnected";
  } catch {
    checks.cache = "unhealthy";
  }

  // ── Overall status ──
  const allHealthy = Object.values(checks).every((v) => v === "healthy");
  const status = allHealthy ? "healthy" : "degraded";

  res.status(allHealthy ? 200 : 503).json({
    status,
    service: "core-backend",
    timestamp: new Date().toISOString(),
    checks,
  });
});

/**
 * GET /health/ready
 *
 * Readiness probe — returns 200 when the service is ready to accept traffic.
 */
router.get("/ready", (_req: Request, res: Response) => {
  res.json({ status: "ready" });
});

/**
 * GET /health/live
 *
 * Liveness probe — always returns 200 while the process is running.
 */
router.get("/live", (_req: Request, res: Response) => {
  res.json({ status: "alive" });
});

export default router;
