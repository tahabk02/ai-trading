import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { riskStateService } from "../services/riskState.service";

// ════════════════════════════════════════════════════════════════════
// SHORT-TTL IN-MEMORY GET CACHE — /risk-state HTTP ERROR ELIMINATION
// ════════════════════════════════════════════════════════════════════
// The client polls risk-state on a shared 30s cadence. Each hit would
// otherwise round-trip a Prisma read for a snapshot that barely changes
// between candles. We cache the resolved snapshot per user for a short TTL,
// so back-to-back polls reuse one DB read while still staying fresh enough
// that a new trade result or kill-switch flip is reflected within seconds.
// The mutation endpoints (recordTradeResult/reset/engage/max-drawdown) bust
// the cache so a successive GET never serves stale data after a change.
const RISK_STATE_TTL_MS = 5_000;
const riskStateCache = new Map<
  string,
  { expiresAt: number; snapshot: unknown }
>();

function getCachedRiskState(userId: string): unknown | null {
  const hit = riskStateCache.get(userId);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    riskStateCache.delete(userId);
    return null;
  }
  return hit.snapshot;
}

function setCachedRiskState(userId: string, snapshot: unknown): void {
  riskStateCache.set(userId, {
    expiresAt: Date.now() + RISK_STATE_TTL_MS,
    snapshot,
  });
}

function bustRiskStateCache(userId: string): void {
  riskStateCache.delete(userId);
}

/**
 * GET /risk-state
 * Returns the caller's live daily-risk snapshot: equity curve, drawdown %,
 * trade counters, and kill-switch status. Served from a short-TTL cache.
 */
export const getRiskState = async (req: Request, res: Response) => {
  try {
    // Auth middleware attaches the verified user; fall back to a stable
    // single-operator identity for signal-only deployments.
    const userId =
      (req as Request & { user?: { id?: string } }).user?.id ?? "default";

    const cached = getCachedRiskState(userId);
    if (cached !== null) {
      res.setHeader("Cache-Control", `private, max-age=${RISK_STATE_TTL_MS / 1000}`);
      return res.json(cached);
    }

    const snapshot = await riskStateService.getState(userId);
    setCachedRiskState(userId, snapshot);
    res.setHeader("Cache-Control", `private, max-age=${RISK_STATE_TTL_MS / 1000}`);
    return res.json(snapshot);
  } catch (error) {
    logger.error("[riskState.controller] Failed to load risk state", {
      error,
    });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * POST /risk-state/trade-result
 * Records a settled trade's signed P&L into the daily equity curve and
 * re-evaluates the kill switch IMMEDIATELY. Body: { pnl: number }
 */
export const postTradeResult = async (req: Request, res: Response) => {
  try {
    const userId =
      (req as Request & { user?: { id?: string } }).user?.id ?? "default";

    const { pnl } = req.body as { pnl?: number };
    if (
      pnl === undefined ||
      pnl === null ||
      typeof pnl !== "number" ||
      !Number.isFinite(pnl)
    ) {
      return res.status(400).json({
        error: "Validation Error",
        message: 'A finite numeric "pnl" field is required.',
      });
    }

    const snapshot = await riskStateService.recordTradeResult(userId, {
      pnl,
    });
    bustRiskStateCache(userId);
    return res.json(snapshot);
  } catch (error) {
    logger.error("[riskState.controller] Failed to record trade result", {
      error,
    });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * POST /risk-state/reset
 * MANUAL KILL-SWITCH RESET — clears the execution lock. The drawdown
 * counter persists; continued losses re-engage the switch automatically.
 */
export const postResetKillSwitch = async (req: Request, res: Response) => {
  try {
    const userId =
      (req as Request & { user?: { id?: string } }).user?.id ?? "default";

    const snapshot = await riskStateService.resetKillSwitch(userId);
    logger.info("[riskState.controller] Kill switch reset", { userId });
    bustRiskStateCache(userId);
    return res.json(snapshot);
  } catch (error) {
    logger.error("[riskState.controller] Kill switch reset failed", {
      error,
    });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * POST /risk-state/engage
 * EMERGENCY KILL-SWITCH ENGAGE — manual LOCK. Halts ALL live trade
 * execution immediately regardless of drawdown state. Body (optional):
 * { reason?: string }
 */
export const postEngageKillSwitch = async (req: Request, res: Response) => {
  try {
    const userId =
      (req as Request & { user?: { id?: string } }).user?.id ?? "default";

    const { reason } = req.body as { reason?: string };
    const snapshot = await riskStateService.engageKillSwitch(userId, reason);
    logger.info("[riskState.controller] Kill switch manually engaged", {
      userId,
    });
    bustRiskStateCache(userId);
    return res.json(snapshot);
  } catch (error) {
    logger.error("[riskState.controller] Kill switch engage failed", {
      error,
    });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * PUT /risk-state/max-drawdown
 * Configures the max daily drawdown threshold (clamped 0.5%–25%).
 * Body: { maxDrawdownPct: number }
 */
export const putMaxDrawdown = async (req: Request, res: Response) => {
  try {
    const userId =
      (req as Request & { user?: { id?: string } }).user?.id ?? "default";

    const { maxDrawdownPct } = req.body as { maxDrawdownPct?: number };
    if (
      maxDrawdownPct === undefined ||
      maxDrawdownPct === null ||
      typeof maxDrawdownPct !== "number" ||
      !Number.isFinite(maxDrawdownPct)
    ) {
      return res.status(400).json({
        error: "Validation Error",
        message: 'A finite numeric "maxDrawdownPct" field is required.',
      });
    }

    const snapshot = await riskStateService.setMaxDrawdown(
      userId,
      maxDrawdownPct,
    );
    bustRiskStateCache(userId);
    return res.json(snapshot);
  } catch (error) {
    logger.error("[riskState.controller] Max drawdown update failed", {
      error,
    });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
