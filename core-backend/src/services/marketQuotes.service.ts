/**
 * marketQuotes.service.ts — MARKET TERMINAL QUOTES SNAPSHOT
 *
 * The single builder for the all-pairs live quotation feed. Merges the REAL
 * per-symbol tick-buffer snapshot (price / bid / ask / spread / tick count /
 * freshness) with the registry's instrument metadata (digits, label, subtype,
 * dynamic ATR-derived payout) so BOTH the REST `GET /api/v1/quotes` endpoint
 * and the WebSocket `market_quotes` broadcast stream the identical payload —
 * one eager source of truth, zero drift between HTTP and WS.
 *
 * Strictly real data: a symbol with no genuine ticks yet is simply absent.
 */

import { symbolRegistry } from "./symbolRegistry.service";
import { realtimeTickBuffer } from "./realtimeTickBuffer.service";
import { logger } from "../utils/logger";

export interface MarketQuote {
  symbol: string;
  name: string;
  type: string;
  assetSubType: string;
  label: string;
  digits: number;
  payout: number;
  price: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  tickCount: number;
  lastTickAt: string | null;
  ageMs: number | null;
}

const MAX_QUOTES = 40;

/**
 * Build the enriched all-pairs quotes snapshot. Never throws — a registry or
 * buffer fault returns an empty list (the broadcaster falls back to silence
 * instead of spamming errors on the hot path).
 */
export async function buildMarketQuotesSnapshot(): Promise<MarketQuote[]> {
  try {
    const entries = await symbolRegistry.getAll();
    const quotes = realtimeTickBuffer.getQuotesSnapshot(
      entries.map((e) => e.symbol),
    );
    const out: MarketQuote[] = [];
    for (const q of quotes.slice(0, MAX_QUOTES)) {
      const meta = entries.find((e) => e.symbol === q.symbol);
      out.push({
        symbol: q.symbol,
        name: meta?.name ?? q.symbol,
        type: meta?.type ?? "otc",
        assetSubType: meta?.assetSubType ?? "otc",
        label: meta?.label ?? q.symbol,
        digits: meta?.digits ?? 5,
        payout: meta?.payout ?? 92,
        price: q.price,
        bid: q.bid,
        ask: q.ask,
        spread: q.spread,
        tickCount: q.tickCount,
        lastTickAt: q.lastTickAt,
        ageMs: q.ageMs,
      });
    }
    return out;
  } catch (err) {
    logger.error("[MarketQuotes] Snapshot build failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}