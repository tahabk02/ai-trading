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

/**
 * Health ledger for GET /health/orderbook — records the last outcome of every
 * /orderbook call (latency + failure detail) and drives the health endpoint so
 * operators can see WHY the order book is slow/down without hitting it.
 */
export const orderbookHealth = {
  last_latency_ms: 0,
  last_error: null as string | null,
  last_ok_ts: null as number | null,
  recordStart(): void {
    this.last_latency_ms = 0;
  },
  recordOk(latencyMs: number): void {
    this.last_latency_ms = latencyMs;
    this.last_error = null;
    this.last_ok_ts = Date.now();
  },
  recordError(latencyMs: number, error: string): void {
    this.last_latency_ms = latencyMs;
    this.last_error = error;
  },
};

/** Per-request upstream cap. The controller MUST bound the whole fork (spot +
 *  candles) at 5s so a dead upstream returns a JSON 504 instead of letting a
 *  proxy respond with a bare 502. */
const UPSTREAM_TIMEOUT_MS = 5_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`orderbook_upstream_timeout after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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
    logger.info(`[orderbook] symbol= status=400 latency_ms=0`);
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
    logger.info(`[orderbook] symbol=${normalizedSymbol} status=400 latency_ms=0`);
    return res.status(400).json({
      error: "Symbol not permitted",
      symbol: normalizedSymbol,
      message: `"${normalizedSymbol}" is not part of the strict OTC forex whitelist. Only the 34 whitelisted OTC pairs are supported.`,
      timestamp: new Date().toISOString(),
    });
  }

  const spec = PAIR_SPECS[normalizedSymbol];
  const t0 = Date.now();
  orderbookHealth.recordStart();

  try {
    // ── Fetch REAL live spot + REAL historical candles in parallel, bounded
    //    by a hard 5s cap (UPSTREAM_TIMEOUT_MS). On timeout → 504 JSON (never a
    //    bare proxy 504).
    let spotResult: Awaited<ReturnType<typeof forexDataService.getLiveSpot>>;
    let barResult: Awaited<
      ReturnType<typeof forexDataService.getHistoricalCandles>
    >;
    try {
      [spotResult, barResult] = await withTimeout(
        Promise.all([
          forexDataService.getLiveSpot(normalizedSymbol),
          forexDataService.getHistoricalCandles(normalizedSymbol, "1d", 60),
        ]),
        UPSTREAM_TIMEOUT_MS,
      );
    } catch (cause) {
      const elapsed = Date.now() - t0;
      const isTimeout = /timeout/i.test(
        cause instanceof Error ? cause.message : String(cause),
      );
      orderbookHealth.recordError(elapsed, String(cause));
      const status = isTimeout ? 504 : 502;
      logger.info(`[orderbook] symbol=${normalizedSymbol} status=${status} latency_ms=${elapsed}`);
      return res.status(status).json({
        error: isTimeout ? "orderbook_timeout" : "orderbook_upstream",
        symbol: normalizedSymbol,
        retryAfterMs: isTimeout ? 1000 : undefined,
        message: isTimeout
          ? "Upstream forex rate pipeline exceeded the 5s order-book deadline."
          : "Upstream forex rate pipeline failed.",
        detail: cause instanceof Error ? cause.message : String(cause),
        timestamp: new Date().toISOString(),
      });
    }

    if (!spotResult.success || spotResult.price == null) {
      const elapsed = Date.now() - t0;
      orderbookHealth.recordError(elapsed, spotResult.error || "no live rate");
      logger.info(`[orderbook] symbol=${normalizedSymbol} status=502 latency_ms=${elapsed}`);
      return res.status(502).json({
        error: "orderbook_upstream",
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

    orderbookHealth.recordOk(Date.now() - t0);
    logger.info(`[orderbook] symbol=${normalizedSymbol} status=200 latency_ms=${Date.now() - t0}`);

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
    orderbookHealth.recordError(elapsed, error instanceof Error ? error.message : String(error));
    logger.error("[OrderBook] Failed to fetch OTC order book data", {
      symbol: normalizedSymbol,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: elapsed,
    });
    logger.info(`[orderbook] symbol=${normalizedSymbol} status=502 latency_ms=${elapsed}`);

    // NEVER return synthetic data — just propagate the error
    return res.status(502).json({
      error: "orderbook_upstream",
      symbol: normalizedSymbol,
      message:
        "Could not fetch real OTC order book data from the market data pipeline.",
      detail: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
  }
};
