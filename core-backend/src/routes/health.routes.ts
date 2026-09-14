import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { CacheService } from "../services/cache.service";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";
import axios from "axios";
import { forexDataService } from "../services/forexData.service";
import { orderbookHealth } from "../controllers/orderbook.controller";
import packageJson from "../../package.json";
import { allowedOrigins } from "../config/cors";

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
 * GET /health/orderbook
 *
 * Reports the /orderbook endpoint's last outcome from the controller's health
 * ledger (`orderbookHealth`): observation only — never mutates state. `status`
 * is "ok" while no upstream failure was recorded, "down" after a timeout /
 * upstream failure until the next successful call.
 */
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
