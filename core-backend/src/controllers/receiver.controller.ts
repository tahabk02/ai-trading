import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";
import { WebSocketService } from "../services/websocket.service";
import { symbolRegistry } from "../services/symbolRegistry.service";
import {
  buildExecutionResponse,
  provenanceFromPriceSource,
  EXECUTION_PROVENANCE,
} from "../lib/executionEngine";
import { recordExecutionAudit } from "../lib/auditLogger";

const prisma = new PrismaClient();
const wsService = WebSocketService.getInstance();

/**
 * POST /signals/receive — Signal EVALUATION endpoint (AI Engine HTTP fallback).
 *
 * PART 44 [455] — answers with the unified execution envelope. The AI Engine's
 * publisher only checks the HTTP status code, so the body change is safe; the
 * persisted signal is nested under `result`. Every decision (executed/rejected)
 * is recorded to the audit log ([456]).
 */
export const receiveSignal = async (req: Request, res: Response) => {
  const t0 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signalData: any = req.body ?? {};
  const auditDirection =
    typeof signalData.signal_type === "string" ? signalData.signal_type : null;
  try {
    logger.info("Received signal via HTTP Fallback", {
      symbol: signalData.symbol,
    });

    const incomingSymbol = String(signalData?.symbol || "")
      .trim()
      .toUpperCase();

    const reject = (
      httpStatus: number,
      code: string,
      reason: string,
      riskRules: Record<string, unknown>,
    ): Response => {
      const exec = buildExecutionResponse({
        status: "rejected",
        provenance: EXECUTION_PROVENANCE.NONE,
        latencyMs: Date.now() - t0,
        error: reason,
      });
      recordExecutionAudit({
        source: "signal",
        symbol: incomingSymbol,
        direction: auditDirection,
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
        .json({ ...exec, code, message: reason });
    };

    // ════════════════════════════════════════════════════════════════
    // STRICT OTC WHITELIST GATE — reject ANY non-OTC ticker at the
    // persistence boundary. No stock/crypto signal can be stored.
    // ════════════════════════════════════════════════════════════════
    if (!incomingSymbol) {
      return reject(
        400,
        "validation_error",
        'A non-empty "symbol" field is required.',
        { whitelistPassed: false },
      );
    }
    if (!symbolRegistry.isValidSymbolSync(incomingSymbol)) {
      logger.warn("[receiver.controller] Non-whitelisted signal rejected", {
        symbol: incomingSymbol,
      });
      return reject(
        400,
        "symbol_not_allowed",
        `'${incomingSymbol}' is NOT tradable. Only the 10 OTC pairs are allowed.`,
        { whitelistPassed: false },
      );
    }

    // ════════════════════════════════════════════════════════════════
    // ABSOLUTE CONFIDENCE SANITIZER — KILLS OVERFLOW AT PERSISTENCE BOUNDARY
    // The ML predictor returns confidence in [0,100] scale (e.g. 65.90).
    // The SignalGenerator fallback returns confidence in [0,1] scale (e.g. 0.75).
    // This sanitizer normalizes to [0,100] before DB storage, ensuring
    // downstream consumers (WebSocket, SignalWidget) always get consistent scale.
    // ════════════════════════════════════════════════════════════════
    const rawConf = Number(signalData.confidence) || 0;
    const normalizedConf = rawConf > 100 ? rawConf / 100 : rawConf;
    const sanitizedConfidence = Math.min(
      Math.max(normalizedConf > 1 ? normalizedConf : normalizedConf * 100, 0),
      100,
    );

    // 1. Persist
    const savedSignal = await prisma.signal.create({
      data: {
        symbol: signalData.symbol,
        signalType: signalData.signal_type,
        price: signalData.price,
        confidence: sanitizedConfidence,
        indicators: signalData.indicators || {},
        status: "ACTIVE",
      },
    });

    // 2. Broadcast via WebSocket
    wsService.broadcastSignal(savedSignal);

    // [455] Provenance — the price source the signal was evaluated on, when the
    // producer declares one; otherwise honest `none`.
    const declaredSource =
      (typeof signalData.dataSource === "string" && signalData.dataSource) ||
      (typeof signalData.source === "string" && signalData.source) ||
      (typeof signalData.provenance === "string" && signalData.provenance) ||
      "";
    const provenance = declaredSource
      ? provenanceFromPriceSource(declaredSource)
      : EXECUTION_PROVENANCE.NONE;

    const exec = buildExecutionResponse({
      status: "executed",
      provenance,
      latencyMs: Date.now() - t0,
      error: null,
      result: savedSignal,
    });
    recordExecutionAudit({
      source: "signal",
      symbol: incomingSymbol,
      timeframe:
        typeof signalData.timeframe === "string" ? signalData.timeframe : null,
      direction:
        typeof signalData.signal_type === "string"
          ? signalData.signal_type
          : null,
      confidence: sanitizedConfidence,
      decision: "executed",
      status: "executed",
      provenance,
      executionId: exec.executionId,
      latencyMs: exec.latencyMs,
      riskRules: { whitelistPassed: true },
    });

    return res.status(200).json(exec);
  } catch (error) {
    logger.error("HTTP Signal receive error", { error });
    const exec = buildExecutionResponse({
      status: "failed",
      latencyMs: Date.now() - t0,
      error: "Failed to process signal",
    });
    recordExecutionAudit({
      source: "signal",
      symbol: String(signalData?.symbol ?? ""),
      direction: auditDirection,
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
