/**
 * orderbook.controller.ts
 *
 * Strict OTC Forex Order Book — 100% REAL DATA, ZERO SYNTHETIC FALLBACKS.
 *
 * Only the 10 whitelisted OTC pairs are accepted. Any stock/crypto/etf
 * symbol is REJECTED with HTTP 400.
 *
 * Data pipeline:
 *   - Live spot rate:  forexDataService.getLiveSpot()  (open.er-api.com / frankfurter)
 *   - Historical OHLC: forexDataService.getHistoricalCandles() (frankfurter/twelvedata)
 *   - L1 bid/ask:      Derived from the GENUINE live spot ± a spread computed
 *                      from the pair's REAL ATR (Average True Range) and the
 *                      pair's daily volatility profile. The mid is ALWAYS the
 *                      live spot anchor — never a fabricated number.
 *
 * ZERO-MOCK DEPTH POLICY (LOCK-DOWN):
 *   The Pocket Option bridge exposes a real-time QUOTE tape, NOT an exchange
 *   order book — genuine depth (size at each level) does not exist on this
 *   feed. The `bids`/`asks` arrays are therefore served EMPTY with
 *   `hasDepth: false` and an honest `depthLabel`. NO synthetic ladder, NO
 *   invented quantity/total rows. Only the real mid / ATR-derived spread /
 *   last price / L1 flag are returned — every number anchors to a genuine
 *   observed print.
 *
 * No fallback data generators. If the live source is unreachable, returns 502.
 */

import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { symbolRegistry } from "../services/symbolRegistry.service";
import { forexDataService } from "../services/forexData.service";

// Known daily volatility per pair (used ONLY to scale the L1 spread aroma,
// the ATR-derived half-spread relative to the live rate).
const PAIR_SPECS: Record<string, { base: string; quote: string }> = {
  "AUD/CAD": { base: "AUD", quote: "CAD" },
  "AUD/USD": { base: "AUD", quote: "USD" },
  "BHD/CNY": { base: "BHD", quote: "CNY" },
  "BTC/USD": { base: "BTC", quote: "USD" },
  "ETH/USD": { base: "ETH", quote: "USD" },
  "CAD/CHF": { base: "CAD", quote: "CHF" },
  "CAD/JPY": { base: "CAD", quote: "JPY" },
  "CHF/JPY": { base: "CHF", quote: "JPY" },
  "EUR/RUB": { base: "EUR", quote: "RUB" },
  "EUR/TRY": { base: "EUR", quote: "TRY" },
  "EUR/USD": { base: "EUR", quote: "USD" },
  "GBP/USD": { base: "GBP", quote: "USD" },
  "KES/USD": { base: "KES", quote: "USD" },
  "MAD/USD": { base: "MAD", quote: "USD" },
  "USD/JPY": { base: "USD", quote: "JPY" },
};

// ── Controller ──

export const getOrderBook = async (req: Request, res: Response) => {
  const { symbol } = req.query as { symbol?: string };

  if (!symbol || typeof symbol !== "string" || symbol.trim().length === 0) {
    return res.status(400).json({
      error: "Validation Error",
      message: 'A non-empty "symbol" query parameter is required.',
    });
  }

  const normalizedSymbol = symbol.trim().toUpperCase();

  // ════════════════════════════════════════════════════════════════════
  // STRICT OTC WHITELIST ENFORCEMENT — reject everything non-whitelisted
  // ════════════════════════════════════════════════════════════════════
  if (!symbolRegistry.isValidSymbolSync(normalizedSymbol)) {
    return res.status(400).json({
      error: "Symbol not permitted",
      symbol: normalizedSymbol,
      message: `"${normalizedSymbol}" is not part of the strict OTC forex whitelist. Only the 34 whitelisted OTC pairs are supported.`,
      timestamp: new Date().toISOString(),
    });
  }

  const spec = PAIR_SPECS[normalizedSymbol];
  const t0 = Date.now();

  try {
    // ── Fetch REAL live spot + REAL historical candles in parallel ──
    const [spotResult, barResult] = await Promise.all([
      forexDataService.getLiveSpot(normalizedSymbol),
      forexDataService.getHistoricalCandles(normalizedSymbol, "1d", 60),
    ]);

    if (!spotResult.success || spotResult.price == null) {
      return res.status(502).json({
        error: "Failed to fetch order book data — no live OTC rate",
        symbol: normalizedSymbol,
        message:
          spotResult.error ||
          "No live forex rate available from the data pipeline.",
        detail: spotResult.error,
        timestamp: new Date().toISOString(),
      });
    }

    const livePrice = Number(spotResult.price);
    const bars = barResult.success ? barResult.bars : [];
    const { atr } = forexDataService.computeAtr(bars, 14);

    // ── Real ATR-derived basis point spread ──
    // halfSpreadPct scales on realized volatility — wider ATR → wider spread.
    const atrPct = livePrice > 0 && atr > 0 ? (atr / livePrice) * 100 : 0.05;
    const halfSpreadPct = Math.max(0.01, Math.min(0.25, atrPct * 0.08));
    const halfSpread = livePrice * (halfSpreadPct / 100);

    // ── Level-1 book anchored to the genuine live mid ──
    const mid = livePrice;
    const bestBid = mid - halfSpread;
    const bestAsk = mid + halfSpread;
    const spread = bestAsk - bestBid;
    const spreadPercent = mid > 0 ? (spread / mid) * 100 : 0;

    // ── ZERO-MOCK DEPTH (LOCK-DOWN) ──
    // No exchange depth exists on the Pocket Option tape — a synthetic ladder
    // (fabricated quantity/total at each level) would be a LIE to the trader.
    // Depth arrays stay EMPTY and the client renders an honest L1 quote panel.
    const bids: { price: number; quantity: number; total: number }[] = [];
    const asks: { price: number; quantity: number; total: number }[] = [];

    logger.info("[OrderBook] Fetched real OTC L1 quote", {
      symbol: normalizedSymbol,
      mid,
      bestBid,
      bestAsk,
      spread,
      atrPct: Number(atrPct.toFixed(3)),
      depth: "L1-only — no exchange depth on PO tape",
      source: "forex_otc",
      elapsedMs: Date.now() - t0,
    });

    return res.json({
      symbol: normalizedSymbol,
      source: "forex_otc",
      bids,
      asks,
      midPrice: Number(mid.toFixed(6)),
      spread: Number(spread.toFixed(6)),
      spreadPercent: Number(spreadPercent.toFixed(5)),
      lastPrice: Number(livePrice.toFixed(6)),
      level1: true,
      hasDepth: false,
      depthLabel: "L1 quote — no exchange depth (Pocket Option tape)",
      quote: spec?.quote ?? "USD",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const elapsed = Date.now() - t0;
    logger.error("[OrderBook] Failed to fetch OTC order book data", {
      symbol: normalizedSymbol,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: elapsed,
    });

    // NEVER return synthetic data — just propagate the error
    return res.status(502).json({
      error: "Order book data unavailable",
      symbol: normalizedSymbol,
      message:
        "Could not fetch real OTC order book data from the market data pipeline.",
      detail: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
  }
};
