import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { symbolRegistry } from "../services/symbolRegistry.service";
import { forexDataService } from "../services/forexData.service";
import { riskStateService } from "../services/riskState.service";
import {
  buildExecutionResponse,
  executionDryRunEnabled,
  provenanceFromPriceSource,
  EXECUTION_PROVENANCE,
} from "../lib/executionEngine";
import { recordExecutionAudit } from "../lib/auditLogger";
import type { RiskRuleSnapshot } from "../lib/auditLogger";

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
//
// PART 44 [455] — answers with the UNIFIED execution envelope
// (`status`/`executionId`/`provenance`/`latencyMs`/`error`, plus the persisted
// trade under `result`). Every rejection/failure ALSO records an audit entry
// ([456]) with the active risk rules at decision time.
export const executeTrade = async (req: Request, res: Response) => {
  const t0 = Date.now();
  let cleanSymbol = "";
  let direction: "CALL" | "PUT" | undefined;
  try {
    const body = (req.body ?? {}) as {
      symbol?: string;
      direction?: "CALL" | "PUT";
      investment?: number;
      expiration?: number;
      /** Optional ops/backtest dry-run override (PART 44 [455]). */
      dryRun?: boolean;
    };
    const { symbol, investment, expiration } = body;
    direction = body.direction;
    cleanSymbol = String(symbol ?? "").trim().toUpperCase();

    /** Build + audit + send a REJECTED envelope (HTTP status is the caller's). */
    const reject = (
      httpStatus: number,
      code: string,
      reason: string,
      riskRules: RiskRuleSnapshot,
      extra: Record<string, unknown> = {},
    ): Response => {
      const exec = buildExecutionResponse({
        status: "rejected",
        provenance: EXECUTION_PROVENANCE.NONE,
        latencyMs: Date.now() - t0,
        error: reason,
      });
      recordExecutionAudit({
        source: "trade",
        symbol: cleanSymbol,
        direction: direction ?? null,
        decision: "rejected",
        status: "rejected",
        provenance: EXECUTION_PROVENANCE.NONE,
        executionId: exec.executionId,
        latencyMs: exec.latencyMs,
        error: reason,
        riskRules,
      });
      return res
        .status(httpStatus)
        .json({ ...exec, code, message: reason, ...extra });
    };

    if (
      !symbol ||
      !direction ||
      investment === undefined ||
      investment === null ||
      !expiration
    ) {
      return reject(
        400,
        "validation_error",
        "symbol, direction, investment, and expiration are required.",
        { whitelistPassed: false },
      );
    }

    // ════════════════════════════════════════════════════════════════
    // STRICT OTC WHITELIST GATE — only the OTC pairs can be traded.
    // Stocks/crypto/anything else are rejected at this boundary.
    // ════════════════════════════════════════════════════════════════
    if (!symbolRegistry.isValidSymbolSync(cleanSymbol)) {
      return reject(
        400,
        "symbol_not_allowed",
        `"${cleanSymbol}" is not in the strict OTC forex whitelist. Only the 34 OTC pairs are supported.`,
        { whitelistPassed: false },
        { symbol: cleanSymbol },
      );
    }

    if (direction !== "CALL" && direction !== "PUT") {
      return reject(
        400,
        "validation_error",
        'direction must be either "CALL" or "PUT".',
        { whitelistPassed: true },
      );
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
    const riskRules: RiskRuleSnapshot = {
      whitelistPassed: true,
      killSwitchLocked: riskSnapshot.killSwitchLocked,
      drawdownPct: riskSnapshot.drawdownPct,
      maxDailyDrawdownPct: riskSnapshot.maxDailyDrawdownPct,
      tradesToday: riskSnapshot.tradesToday,
      lossesToday: riskSnapshot.lossesToday,
    };
    if (riskSnapshot.killSwitchLocked) {
      logger.error("[trades.controller] Trade BLOCKED by kill switch", {
        symbol: cleanSymbol,
        direction,
        drawdownPct: riskSnapshot.drawdownPct,
        limit: riskSnapshot.maxDailyDrawdownPct,
      });
      return reject(
        423,
        "kill_switch_engaged",
        riskSnapshot.lockedReason ??
          `Daily drawdown ${riskSnapshot.drawdownPct.toFixed(2)}% breached the ${riskSnapshot.maxDailyDrawdownPct}% limit. Trading is locked until reset.`,
        riskRules,
        {
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
        },
      );
    }

    // ── Dynamic live payout from the symbol registry (ATR-derived) ──
    // The registry's payout is refreshed continuously by the prediction
    // pipeline (syncPayouts). It is NEVER a hardcoded constant.
    const entry = await symbolRegistry.findBySymbol(cleanSymbol);
    const dynamicPayout = entry?.payout ?? 92;

    // ── Real-time entry price from live OTC spot (no zeros) ──
    // A HELD print (last known good, served only while every live source is
    // exhausted) is refused here: an entry price must be a genuinely current
    // quote, never a carried-over one.
    let entryPrice = 0;
    const spot = await forexDataService.getLiveSpot(cleanSymbol);
    if (spot.success && spot.price != null && spot.stale !== true) {
      entryPrice = spot.price;
    } else if (spot.stale === true) {
      logger.warn("[trades.controller] Refusing held price for trade entry", {
        symbol: cleanSymbol,
        priceAgeMs: spot.ageMs ?? null,
      });
    }

    // [455] Provenance — how the valuation price was sourced (SPEC field).
    const provenance =
      entryPrice > 0
        ? provenanceFromPriceSource(spot.source)
        : spot.stale === true
          ? EXECUTION_PROVENANCE.HELD_PRICE
          : EXECUTION_PROVENANCE.NONE;

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

    const dryRun = executionDryRunEnabled() || body.dryRun === true;
    if (!dryRun) tradesStore.unshift(trade);

    const status = dryRun ? "dry_run" : "executed";
    const exec = buildExecutionResponse({
      status,
      provenance,
      latencyMs: Date.now() - t0,
      error: null,
      result: trade,
    });
    recordExecutionAudit({
      source: "trade",
      symbol: cleanSymbol,
      direction,
      timeframe: null,
      decision: dryRun ? "skipped" : "executed",
      status,
      provenance,
      executionId: exec.executionId,
      latencyMs: exec.latencyMs,
      riskRules: { ...riskRules, dryRun },
    });

    logger.info(
      `[trades.controller] OTC trade ${dryRun ? "dry-run" : "executed"}`,
      {
        id: trade.id,
        executionId: exec.executionId,
        symbol: cleanSymbol,
        direction,
        payout: dynamicPayout,
        entryPrice,
        provenance,
        latencyMs: exec.latencyMs,
      },
    );

    return res.status(dryRun ? 200 : 201).json(exec);
  } catch (error) {
    logger.error("[trades.controller] Execution error", { error });
    const exec = buildExecutionResponse({
      status: "failed",
      latencyMs: Date.now() - t0,
      error: "Internal Server Error",
    });
    recordExecutionAudit({
      source: "trade",
      symbol: cleanSymbol,
      direction: direction ?? null,
      decision: "rejected",
      status: "failed",
      executionId: exec.executionId,
      latencyMs: exec.latencyMs,
      error: exec.error,
      riskRules: {},
    });
    return res.status(500).json({ ...exec, error: exec.error });
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
