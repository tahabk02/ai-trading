import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { queryExecutionLogs } from "../lib/auditLogger";
import type { ExecutionDecision } from "../lib/auditLogger";

/**
 * PART 44 [456] — GET /api/v1/audit/execution-logs
 *
 * Read-only view over the signal/trade execution audit log. Supports the
 * verification + backtest-comparison workflow: filter by `symbol`, `decision`
 * (executed | skipped | rejected), and an ISO `since` lower bound; `limit`
 * bounds the page (default 50, max 500). Newest-first.
 */
export const getExecutionLogs = async (req: Request, res: Response) => {
  try {
    const { symbol, decision, since, limit } = req.query;
    const result = queryExecutionLogs({
      symbol: symbol ? String(symbol) : undefined,
      decision: decision ? (String(decision) as ExecutionDecision) : undefined,
      since: since ? String(since) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return res.json({
      logs: result.logs,
      count: result.count,
      total: result.total,
      filters: {
        symbol: symbol ? String(symbol).toUpperCase() : null,
        decision: decision ? String(decision) : null,
        since: since ? String(since) : null,
        limit: limit ? Number(limit) : null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("[audit.controller] execution-logs query failed", { error });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
