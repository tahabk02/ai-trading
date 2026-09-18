/**
 * quotes.controller.ts — GET /api/v1/quotes
 *
 * REST twin of the WebSocket `market_quotes` stream: returns the enriched
 * all-symbol live quotation snapshot (price / bid / ask / spread / tick count /
 * freshness + instrument metadata) for the market terminal's initial paint and
 * any REST-only fallback. Strictly real data — a pair with no genuine ticks
 * yet is simply absent, never fabricated.
 */

import { Request, Response } from "express";
import { buildMarketQuotesSnapshot } from "../services/marketQuotes.service";
import { logger } from "../utils/logger";

export const getQuotes = async (_req: Request, res: Response) => {
  try {
    const quotes = await buildMarketQuotesSnapshot();
    return res.json({
      success: true,
      count: quotes.length,
      quotes,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("[QuotesController] Failed to build market quotes", { error });
    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
      quotes: [],
      count: 0,
    });
  }
};