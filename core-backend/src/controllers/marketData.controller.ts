import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { WebSocketService } from "../services/websocket.service";
import { forexDataService } from "../services/forexData.service";
import { MarketDataValidator } from "../utils/marketDataValidator";

const wsService = WebSocketService.getInstance();

/**
 * MarketDataController — Authoritative pipeline for market data distribution.
 */
export class MarketDataController {
  /**
   * Broadcasts a live market tick update to all connected clients.
   * Validates data integrity before emission to prevent frontend crashes.
   */
  public static async broadcastLiveTick(symbol: string, rawData: any) {
    try {
      const validatedTick = MarketDataValidator.validateTick(rawData);
      
      if (!validatedTick) {
        logger.warn("[MarketDataController] Dropping malformed tick update", { symbol, rawData });
        return;
      }

      const payload = {
        symbol: symbol.toUpperCase(),
        ...validatedTick,
        timestamp: new Date(validatedTick.time * 1000).toISOString(),
      };

      wsService.broadcastSignal(payload);
    } catch (error) {
      logger.error("[MarketDataController] Broadcast failed", { error: (error as Error).message });
    }
  }

  /**
   * API Endpoint to fetch historical candles with strict validation.
   */
  public static async getHistory(req: Request, res: Response) {
    const { symbol, timeframe = "1h", limit = "200" } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "Symbol is required" });
    }

    try {
      const result = await forexDataService.getHistoricalCandles(
        String(symbol),
        String(timeframe),
        Number(limit)
      );

      if (!result.success) {
        return res.status(502).json({ error: "Failed to fetch historical data", detail: result.error });
      }

      // ── THE CRITICAL PIPELINE BOUNDARY ──
      // Validate and normalize data before it leaves the backend.
      const validatedHistory = MarketDataValidator.validateOHLCVArray(result.bars);

      return res.json({
        symbol: String(symbol).toUpperCase(),
        timeframe,
        data: validatedHistory,
      });
    } catch (error) {
      logger.error("[MarketDataController] History fetch error", { error: (error as Error).message });
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
}
