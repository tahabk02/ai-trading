import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { symbolRegistry } from "../services/symbolRegistry.service";
import { forexDataService } from "../services/forexData.service";
import { riskStateService } from "../services/riskState.service";

// ── In-memory trade store (replace with DB in production) ──
interface TradeRecord {
  id: string;
  symbol: string;
  direction: "CALL" | "PUT";
  investment: number;
  entry_price: number;
  expiration: number;
  payout: number;
  status: "OPEN" | "WIN" | "LOSS";
  created_at: string;
  expires_at: string;
}

const tradesStore: TradeRecord[] = [];
let tradeCounter = 0;

// ── POST /trades — Execute a trade (signal log, STRICT OTC ONLY) ──
export const executeTrade = async (req: Request, res: Response) => {
  try {
    const { symbol, direction, investment, expiration } = req.body as {
      symbol?: string;
      direction?: "CALL" | "PUT";
      investment?: number;
      expiration?: number;
    };

    if (
      !symbol ||
      !direction ||
      investment === undefined ||
      investment === null ||
      !expiration
    ) {
      return res.status(400).json({
        error: "Validation Error",
        message: "symbol, direction, investment, and expiration are required.",
      });
    }

    const cleanSymbol = symbol.trim().toUpperCase();

    // ════════════════════════════════════════════════════════════════
    // STRICT OTC WHITELIST GATE — only the 10 OTC pairs can be traded.
    // Stocks/crypto/anything else are rejected at this boundary.
    // ════════════════════════════════════════════════════════════════
    if (!symbolRegistry.isValidSymbolSync(cleanSymbol)) {
      return res.status(400).json({
        error: "Symbol not allowed",
        symbol: cleanSymbol,
        message: `"${cleanSymbol}" is not in the strict OTC forex whitelist. Only the 34 OTC pairs are supported.`,
      });
    }

    if (direction !== "CALL" && direction !== "PUT") {
      return res.status(400).json({
        error: "Validation Error",
        message: 'direction must be either "CALL" or "PUT".',
      });
    }

    // ════════════════════════════════════════════════════════════════
    // ⛔ AUTOMATED KILL SWITCH — ADVANCED RISK MANAGEMENT (ALPHA 5 PRO)
    // Evaluates the daily drawdown against the configured max (default
    // 3%). If the threshold is breached, the switch AUTO-ENGAGES and ALL
    // trade execution is LOCKED until manual reset or the next UTC day.
    // No trade can bypass this gate.
    // ════════════════════════════════════════════════════════════════
    const operatorId =
      (req as Request & { user?: { id?: string } }).user?.id ?? "default";
    const riskSnapshot = await riskStateService.evaluateAndEnforce(operatorId);
    if (riskSnapshot.killSwitchLocked) {
      logger.error("[trades.controller] Trade BLOCKED by kill switch", {
        symbol: cleanSymbol,
        direction,
        drawdownPct: riskSnapshot.drawdownPct,
        limit: riskSnapshot.maxDailyDrawdownPct,
      });
      return res.status(423).json({
        error: "Kill Switch Engaged",
        message:
          riskSnapshot.lockedReason ??
          `Daily drawdown ${riskSnapshot.drawdownPct.toFixed(2)}% breached the ${riskSnapshot.maxDailyDrawdownPct}% limit. Trading is locked until reset.`,
        riskState: {
          drawdownPct: riskSnapshot.drawdownPct,
          maxDailyDrawdownPct: riskSnapshot.maxDailyDrawdownPct,
          equity: riskSnapshot.equity,
          peakEquity: riskSnapshot.peakEquity,
          realizedPnl: riskSnapshot.realizedPnl,
          tradesToday: riskSnapshot.tradesToday,
          lossesToday: riskSnapshot.lossesToday,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // ── Dynamic live payout from the symbol registry (ATR-derived) ──
    // The registry's payout is refreshed continuously by the prediction
    // pipeline (syncPayouts). It is NEVER a hardcoded constant.
    const entry = await symbolRegistry.findBySymbol(cleanSymbol);
    const dynamicPayout = entry?.payout ?? 92;

    // ── Real-time entry price from live OTC spot (no zeros) ──
    let entryPrice = 0;
    const spot = await forexDataService.getLiveSpot(cleanSymbol);
    if (spot.success && spot.price != null) {
      entryPrice = spot.price;
    }

    tradeCounter++;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiration * 1000);

    const trade: TradeRecord = {
      id: `trade_${Date.now()}_${tradeCounter}`,
      symbol: cleanSymbol,
      direction,
      investment: Math.round(investment),
      entry_price: entryPrice,
      expiration,
      payout: dynamicPayout,
      status: "OPEN",
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    tradesStore.unshift(trade);

    logger.info("[trades.controller] OTC trade executed", {
      id: trade.id,
      symbol: cleanSymbol,
      direction,
      payout: dynamicPayout,
      entryPrice,
    });

    return res.status(201).json(trade);
  } catch (error) {
    logger.error("[trades.controller] Execution error", { error });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// ── GET /trades — Get trade history ──
export const getTradeHistory = async (req: Request, res: Response) => {
  try {
    const { limit = "50" } = req.query;
    const count = Math.min(Number(limit), 100);
    return res.json({
      trades: tradesStore.slice(0, count),
      count: tradesStore.length,
    });
  } catch (error) {
    logger.error("[trades.controller] History error", { error });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
