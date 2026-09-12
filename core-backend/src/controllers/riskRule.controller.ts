import { Request, Response } from "express";
import { riskRuleService } from "../services/riskRule.service";
import { logger } from "../utils/logger";

/**
 * Stable default user ID used when no JWT authentication is present.
 * This ensures risk rules pages work immediately in local development
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
 * GET /risk-rules
 * Returns all risk rules from the database for the current user.
 * Auto-seeds 4 default rules if none exist.
 */
export const getRiskRules = async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const rules = await riskRuleService.getRules(userId);
    return res.json({ rules, count: rules.length });
  } catch (error) {
    logger.error("[RiskRuleController] Failed to get rules", {
      error: (error as Error).message,
    });
    return res.status(500).json({ error: "Failed to retrieve risk rules" });
  }
};

/**
 * POST /risk-rules
 * Create a new risk rule in the database.
 */
export const createRiskRule = async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const { name, ruleType, value, enabled } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({
        error: "Validation Error",
        message: "name is required",
      });
    }

    const validTypes = [
      "max_drawdown",
      "stop_loss",
      "position_size",
      "max_leverage",
    ];
    if (!ruleType || !validTypes.includes(ruleType)) {
      return res.status(400).json({
        error: "Validation Error",
        message: `ruleType must be one of: ${validTypes.join(", ")}`,
      });
    }

    const val = Number(value);
    if (!Number.isFinite(val) || val <= 0) {
      return res.status(400).json({
        error: "Validation Error",
        message: "value must be a positive number",
      });
    }

    const rule = await riskRuleService.createRule(userId, {
      name: name.trim(),
      ruleType,
      value: val,
      enabled: enabled !== undefined ? Boolean(enabled) : true,
    });

    return res.status(201).json(rule);
  } catch (error) {
    logger.error("[RiskRuleController] Failed to create rule", {
      error: (error as Error).message,
    });
    return res.status(500).json({ error: "Failed to create risk rule" });
  }
};

/**
 * PUT /risk-rules/:id
 * Update an existing risk rule and persist to database.
 */
export const updateRiskRule = async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const { id } = req.params;
    const { name, value, enabled } = req.body;

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (value !== undefined) {
      const val = Number(value);
      if (!Number.isFinite(val) || val <= 0) {
        return res.status(400).json({
          error: "Validation Error",
          message: "value must be a positive number",
        });
      }
      updates.value = val;
    }
    if (enabled !== undefined) updates.enabled = Boolean(enabled);

    const rule = await riskRuleService.updateRule(id, userId, updates);
    return res.json(rule);
  } catch (error) {
    const msg = (error as Error).message;
    if (msg.includes("not found") || msg.includes("access denied")) {
      return res.status(404).json({ error: msg });
    }
    logger.error("[RiskRuleController] Failed to update rule", { error: msg });
    return res.status(500).json({ error: "Failed to update risk rule" });
  }
};

/**
 * DELETE /risk-rules/:id
 * Delete a risk rule from the database.
 */
export const deleteRiskRule = async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const { id } = req.params;
    await riskRuleService.deleteRule(id, userId);
    return res.json({ success: true, message: "Risk rule deleted" });
  } catch (error) {
    const msg = (error as Error).message;
    if (msg.includes("not found") || msg.includes("access denied")) {
      return res.status(404).json({ error: msg });
    }
    logger.error("[RiskRuleController] Failed to delete rule", { error: msg });
    return res.status(500).json({ error: "Failed to delete risk rule" });
  }
};
