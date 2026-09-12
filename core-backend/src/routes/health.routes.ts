import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { CacheService } from "../services/cache.service";
import { logger } from "../utils/logger";

const router = Router();
const prisma = new PrismaClient();

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
