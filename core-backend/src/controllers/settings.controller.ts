import { Request, Response } from "express";
import { settingsService } from "../services/settings.service";
import { logger } from "../utils/logger";

/**
 * Stable default user ID used when no JWT authentication is present.
 * This ensures settings/risk-rules pages work immediately in local development
 * without requiring a login session. In production with JWT, req.user.id
 * takes precedence.
 */
const DEFAULT_USER_ID = "default-user-id";

/**
 * Resolve the effective user ID from the request.
 * Priority: JWT user → X-User-ID header → DEFAULT_USER_ID
 */
function resolveUserId(req: Request): string {
  const jwtId = (req as any).user?.id;
  const headerId = req.headers["x-user-id"] as string | undefined;
  return jwtId || headerId || DEFAULT_USER_ID;
}

/**
 * GET /settings
 * Returns the current user's settings from the database.
 * Auto-creates default settings if none exist.
 */
export const getSettings = async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const settings = await settingsService.getSettings(userId);
    return res.json(settings);
  } catch (error) {
    logger.error("[SettingsController] Failed to get settings", {
      error: (error as Error).message,
    });
    return res.status(500).json({ error: "Failed to retrieve settings" });
  }
};

/**
 * PUT /settings
 * Updates the current user's settings and persists to database.
 * Validates all fields before saving.
 * Returns the updated settings entity.
 */
export const updateSettings = async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const { timeframe, confidenceGuardrail, maxRequestsPerMin, responseSlaMs } =
      req.body;

    // Validate each field if present
    const updates: Record<string, unknown> = {};

    if (timeframe !== undefined) {
      const validTfs = [
        "1m",
        "2m",
        "3m",
        "5m",
        "10m",
        "15m",
        "20m",
        "25m",
        "30m",
        "35m+",
        "1h",
        "4h",
        "1d",
      ];
      if (!validTfs.includes(timeframe)) {
        return res.status(400).json({
          error: "Validation Error",
          message: `Invalid timeframe. Must be one of: ${validTfs.join(", ")}`,
        });
      }
      updates.timeframe = timeframe;
    }

    if (confidenceGuardrail !== undefined) {
      const val = Number(confidenceGuardrail);
      if (!Number.isFinite(val) || val < 0 || val > 1) {
        return res.status(400).json({
          error: "Validation Error",
          message: "confidenceGuardrail must be a number between 0 and 1",
        });
      }
      updates.confidenceGuardrail = val;
    }

    if (maxRequestsPerMin !== undefined) {
      const val = Number(maxRequestsPerMin);
      if (!Number.isInteger(val) || val < 1 || val > 10000) {
        return res.status(400).json({
          error: "Validation Error",
          message: "maxRequestsPerMin must be an integer between 1 and 10000",
        });
      }
      updates.maxRequestsPerMin = val;
    }

    if (responseSlaMs !== undefined) {
      const val = Number(responseSlaMs);
      if (!Number.isInteger(val) || val < 100 || val > 30000) {
        return res.status(400).json({
          error: "Validation Error",
          message: "responseSlaMs must be an integer between 100 and 30000",
        });
      }
      updates.responseSlaMs = val;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: "Validation Error",
        message: "No valid fields to update",
      });
    }

    // Persist to database via Prisma
    const updated = await settingsService.updateSettings(
      userId,
      updates as any,
    );
    return res.json(updated);
  } catch (error) {
    logger.error("[SettingsController] Failed to update settings", {
      error: (error as Error).message,
    });
    return res.status(500).json({ error: "Failed to update settings" });
  }
};
