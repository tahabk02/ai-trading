/**
 * symbol.controller.ts
 *
 * Controller for the Symbol Registry API endpoint.
 * Exposes the strict OTC forex whitelist for frontend autocomplete,
 * dropdown badges, and validation.
 *
 * PRODUCTION ENFORCEMENT:
 *  - Only the 10 OTC pairs are ever returned.
 *  - Each symbol carries its DYNAMIC ATR-derived payout so the UI can render
 *    real return badges (e.g. "+92%") — never a static hardcoded value.
 */

import { Request, Response } from "express";
import {
  symbolRegistry,
  SymbolEntry,
} from "../services/symbolRegistry.service";
import { logger } from "../utils/logger";

// ── GET /api/v1/symbols ──
// Query params:
//   search (string, optional) — Partial search term
//   type (string, optional) — Filter by "otc" (stocks/crypto/etf always return [])
//   limit (number, optional) — Max results (default 50, max 100)

export const getSymbols = async (req: Request, res: Response) => {
  try {
    const searchParam = req.query.search as string | undefined;
    const typeParam = req.query.type as string | undefined;
    const limitParam = req.query.limit as string | undefined;

    // Validate type filter — only "otc" is valid.
    // "stock" | "crypto" | "etf" are accepted for API compatibility but
    // the registry returns [] for them (no stocks/crypto exist anymore).
    const validTypes = ["stock", "crypto", "etf", "otc", "commodity"] as const;
    const typeFilter = typeParam
      ? (typeParam as (typeof validTypes)[number])
      : undefined;

    // Validate limit
    const limit = Math.min(
      Math.max(parseInt(limitParam || "50", 10) || 50, 1),
      100,
    );

    let symbols: SymbolEntry[];
    if (searchParam && searchParam.trim().length > 0) {
      symbols = await symbolRegistry.search(searchParam, typeFilter, limit);
    } else if (typeFilter) {
      const allByType = await symbolRegistry.getAll(typeFilter);
      symbols = allByType.slice(0, limit);
    } else {
      const all = await symbolRegistry.getAll();
      symbols = all.slice(0, limit);
    }

    return res.json({
      success: true,
      count: symbols.length,
      symbols: symbols.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        type: s.type,
        assetSubType: s.assetSubType,
        exchange: s.exchange,
        currency: s.currency,
        payout: s.payout,
        digits: s.digits,
        label: s.label,
      })),
    });
  } catch (error) {
    logger.error("[SymbolController] Error fetching symbols", { error });
    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
};
