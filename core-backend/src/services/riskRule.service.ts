import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";

const prisma = new PrismaClient();

export interface RiskRuleData {
  id: string;
  name: string;
  ruleType: string;
  value: number;
  enabled: boolean;
}

export interface CreateRiskRuleInput {
  name: string;
  ruleType: string;
  value: number;
  enabled?: boolean;
}

export interface UpdateRiskRuleInput {
  name?: string;
  value?: number;
  enabled?: boolean;
}

export class RiskRuleService {
  /**
   * Get all risk rules for a user.
   * Creates default rules if none exist.
   */
  async getRules(userId: string): Promise<RiskRuleData[]> {
    let rules = await prisma.riskRule.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

    if (rules.length === 0) {
      // Seed defaults
      const defaults: CreateRiskRuleInput[] = [
        {
          name: "Max Drawdown",
          ruleType: "max_drawdown",
          value: 25.0, // 25%
          enabled: true,
        },
        {
          name: "Stop-Loss Threshold",
          ruleType: "stop_loss",
          value: 2.0, // 2%
          enabled: true,
        },
        {
          name: "Position Size Limit",
          ruleType: "position_size",
          value: 10.0, // 10% of account
          enabled: true,
        },
        {
          name: "Max Leverage",
          ruleType: "max_leverage",
          value: 3.0, // 3x
          enabled: false,
        },
      ];

      for (const def of defaults) {
        await prisma.riskRule.create({
          data: { ...def, userId },
        });
      }

      rules = await prisma.riskRule.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      });

      logger.info("[RiskRuleService] Seeded default risk rules", { userId });
    }

    return rules.map((r) => ({
      id: r.id,
      name: r.name,
      ruleType: r.ruleType,
      value: r.value,
      enabled: r.enabled,
    }));
  }

  /**
   * Create a new risk rule for a user.
   */
  async createRule(
    userId: string,
    input: CreateRiskRuleInput,
  ): Promise<RiskRuleData> {
    const rule = await prisma.riskRule.create({
      data: {
        userId,
        name: input.name,
        ruleType: input.ruleType,
        value: input.value,
        enabled: input.enabled ?? true,
      },
    });

    logger.info("[RiskRuleService] Rule created", {
      userId,
      ruleId: rule.id,
      ruleType: rule.ruleType,
    });

    return {
      id: rule.id,
      name: rule.name,
      ruleType: rule.ruleType,
      value: rule.value,
      enabled: rule.enabled,
    };
  }

  /**
   * Update an existing risk rule.
   */
  async updateRule(
    ruleId: string,
    userId: string,
    input: UpdateRiskRuleInput,
  ): Promise<RiskRuleData> {
    // Verify ownership
    const existing = await prisma.riskRule.findFirst({
      where: { id: ruleId, userId },
    });
    if (!existing) {
      throw new Error("Risk rule not found or access denied");
    }

    const updated = await prisma.riskRule.update({
      where: { id: ruleId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.value !== undefined && { value: input.value }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
      },
    });

    logger.info("[RiskRuleService] Rule updated", {
      ruleId,
      userId,
      changes: input,
    });

    return {
      id: updated.id,
      name: updated.name,
      ruleType: updated.ruleType,
      value: updated.value,
      enabled: updated.enabled,
    };
  }

  /**
   * Delete a risk rule.
   */
  async deleteRule(ruleId: string, userId: string): Promise<void> {
    const existing = await prisma.riskRule.findFirst({
      where: { id: ruleId, userId },
    });
    if (!existing) {
      throw new Error("Risk rule not found or access denied");
    }

    await prisma.riskRule.delete({ where: { id: ruleId } });
    logger.info("[RiskRuleService] Rule deleted", { ruleId, userId });
  }
}

export const riskRuleService = new RiskRuleService();
