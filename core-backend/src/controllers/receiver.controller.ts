import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";
import { WebSocketService } from "../services/websocket.service";
import { symbolRegistry } from "../services/symbolRegistry.service";

const prisma = new PrismaClient();
const wsService = WebSocketService.getInstance();

export const receiveSignal = async (req: Request, res: Response) => {
  try {
    const signalData = req.body;
    logger.info("Received signal via HTTP Fallback", {
      symbol: signalData.symbol,
    });

    // ════════════════════════════════════════════════════════════════
    // STRICT OTC WHITELIST GATE — reject ANY non-OTC ticker at the
    // persistence boundary. No stock/crypto signal can be stored.
    // ════════════════════════════════════════════════════════════════
    const incomingSymbol = String(signalData?.symbol || "")
      .trim()
      .toUpperCase();
    if (!incomingSymbol) {
      return res.status(400).json({
        error: "Validation Error",
        message: 'A non-empty "symbol" field is required.',
      });
    }
    if (!symbolRegistry.isValidSymbolSync(incomingSymbol)) {
      logger.warn("[receiver.controller] Non-whitelisted signal rejected", {
        symbol: incomingSymbol,
      });
      return res.status(400).json({
        error: "Symbol not in strict OTC forex whitelist",
        symbol: incomingSymbol,
        message: `'${incomingSymbol}' is NOT tradable. Only the 10 OTC pairs are allowed.`,
      });
    }

    // ════════════════════════════════════════════════════════════════
    // ABSOLUTE CONFIDENCE SANITIZER — KILLS OVERFLOW AT PERSISTENCE BOUNDARY
    // The ML predictor returns confidence in [0,100] scale (e.g. 65.90).
    // The SignalGenerator fallback returns confidence in [0,1] scale (e.g. 0.75).
    // This sanitizer normalizes to [0,100] before DB storage, ensuring
    // downstream consumers (WebSocket, SignalWidget) always get consistent scale.
    //
    // Formula:
    //   1. rawConf > 100 → divide by 100 (fixes overflow like 6590 → 65.90)
    //   2. normalizedConf ≤ 1 → multiply by 100 (fixes [0,1] scale → 75.0)
    //   3. Hard clamp [0, 100]
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

    return res.status(200).json({ status: "success", id: savedSignal.id });
  } catch (error) {
    logger.error("HTTP Signal receive error", { error });
    return res.status(500).json({ error: "Failed to process signal" });
  }
};
