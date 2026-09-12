import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";
import { riskRuleService } from "./riskRule.service";

const prisma = new PrismaClient();

export interface TradeValidationResult {
  allowed: boolean;
  reason?: string;
  suggestedSize?: number;
}

export class RiskEngineService {
  private static instance: RiskEngineService;

  private constructor() {}

  public static getInstance(): RiskEngineService {
    if (!RiskEngineService.instance) {
      RiskEngineService.instance = new RiskEngineService();
    }
    return RiskEngineService.instance;
  }

  /**
   * Validate a trade against user-defined risk rules.
   *
   * Checks:
   *  1. Max Drawdown: If current drawdown % > limit, block trade.
   *  2. Daily Stop-Loss: If today's realized loss % > limit, block trade.
   *  3. Position Sizing: Calculate size based on % of capital.
   */
  async validateTrade(
    userId: string,
    symbol: string,
    capital: number,
    requestedAmount: number,
  ): Promise<TradeValidationResult> {
    const rules = await riskRuleService.getRules(userId);
    const enabledRules = rules.filter((r) => r.enabled);

    // ── 1. Daily Stop-Loss Check ──
    const dailySlRule = enabledRules.find((r) => r.ruleType === "stop_loss");
    if (dailySlRule) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const trades = await (prisma as any).trade.findMany({
        where: {
          userId,
          status: "CLOSED",
          closedAt: { gte: today },
        },
      });

      const dailyPnl = trades.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);
      const dailyLossPct = capital > 0 ? (Math.abs(Math.min(0, dailyPnl)) / capital) * 100 : 0;

      if (dailyLossPct >= dailySlRule.value) {
        logger.warn("[RiskEngine] Daily stop-loss breached", {
          userId,
          dailyLossPct,
          limit: dailySlRule.value,
        });
        return {
          allowed: false,
          reason: `Daily stop-loss limit breached (${dailyLossPct.toFixed(2)}% >= ${dailySlRule.value}%)`,
        };
      }
    }

    // ── 2. Max Drawdown Check ──
    const drawdownRule = enabledRules.find((r) => r.ruleType === "max_drawdown");
    if (drawdownRule) {
      // Calculate current drawdown based on closed trades vs starting capital
      const allTrades = await (prisma as any).trade.findMany({
        where: { userId, status: "CLOSED" },
        orderBy: { closedAt: "asc" },
      });

      let peak = capital;
      let currentEquity = capital;

      for (const t of allTrades) {
        currentEquity += (t.pnl || 0);
        if (currentEquity > peak) peak = currentEquity;
      }

      const drawdownPct = peak > 0 ? ((peak - currentEquity) / peak) * 100 : 0;

      if (drawdownPct >= drawdownRule.value) {
        logger.warn("[RiskEngine] Max drawdown breached", {
          userId,
          drawdownPct,
          limit: drawdownRule.value,
        });
        return {
          allowed: false,
          reason: `Max drawdown limit breached (${drawdownPct.toFixed(2)}% >= ${drawdownRule.value}%)`,
        };
      }
    }

    // ── 3. Dynamic Position Sizing ──
    const sizeRule = enabledRules.find((r) => r.ruleType === "position_size");
    let suggestedSize = requestedAmount;

    if (sizeRule) {
      const maxSize = (capital * sizeRule.value) / 100;
      if (requestedAmount > maxSize) {
        logger.info("[RiskEngine] Capping position size", {
          userId,
          requested: requestedAmount,
          capped: maxSize,
          limit: sizeRule.value,
        });
        suggestedSize = maxSize;
      }
    }

    return {
      allowed: true,
      suggestedSize,
    };
  }
}

export const riskEngine = RiskEngineService.getInstance();
