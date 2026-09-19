import { create } from "zustand";
import { OTC_FOREX_PAIRS, REAL_FOREX_PAIRS } from "@/constants/symbols";
import type { PredictionResponse, MarketQuote } from "@/services/api";

/**
 * MARKET TERMINAL STORE — Alpha.5 Pro all-pairs grid.
 *
 * Owns the full 44-instrument universe card state:
 *   • quotes      — live price / bid / ask / spread / tick count / freshness
 *                   (fed by the 1Hz `market_quotes` WS snapshots + REST bootstrap)
 *   • verdicts    — the AI engine's 1Hz micro-quant verdicts (`live_quant_signal`)
 *   • predictions — heavier per-horizon `/multi-predict` results
 *   • horizon     — GLOBAL target horizon (1/2/3/5/10 min) with per-card overrides
 *   • filter      — asset-class filter (all | otc | real | crypto)
 *
 * Verdicts and predictions are kept SEPARATE so the grid always renders the
 * freshest live 1Hz CALL/PUT instantly while the heavier horizon refresh lands.
 * The card merges: live verdict wins for "LIVE" label + confidence, the horizon
 * prediction wins for "HORIZON" label + CALL/PUT badge once it resolves.
 */

export const HORIZON_MINUTES = [1, 2, 3, 5, 10] as const;
export type HorizonMinutes = (typeof HORIZON_MINUTES)[number];

export type AssetClassFilter = "all" | "otc" | "real" | "crypto";

/** Market-quote snapshot (GET /api/v1/quotes + `market_quotes` WS). */
// MarketQuote is defined in services/api.ts (single source of truth shared
// with the REST client); re-exported here for store-local ergonomics.
export type { MarketQuote } from "@/services/api";

/** Micro-quant live verdict (`live_quant_signal` event, 60% gate). */
export interface LiveVerdict {
  direction: "BUY" | "SELL" | null;
  confidence: number;
  current_price?: number;
  target_price?: number;
  market_waiting: boolean;
  waiting_reason: string | null;
  waiting_detail: string | null;
  book_confluence?: number | null;
  timestamp: string;
}

/** Per-card heavier horizon refresh state. */
export interface CardHorizonPrediction {
  status: "pending" | "ok" | "error";
  direction: "BUY" | "SELL" | null;
  confidence: number | null;
  market_waiting: boolean;
  waiting_reason: string | null;
  waiting_detail: string | null;
  data?: PredictionResponse | null;
}

interface MarketTerminalState {
  quotes: Record<string, MarketQuote>;
  verdicts: Record<string, LiveVerdict>;
  predictions: Record<string, CardHorizonPrediction>;
  globalHorizon: HorizonMinutes;
  cardHorizons: Record<string, HorizonMinutes>;
  filter: AssetClassFilter;
  connected: boolean;
  feedStatus: string;
  /** Monotonic version counters so cards re-render on quote/verdict change. */
  _quoteVersion: number;
  _verdictVersion: number;
  setQuotes: (quotes: MarketQuote[]) => void;
  addQuote: (quote: MarketQuote) => void;
  ingestVerdict: (payload: LiveVerdict & { symbol: string }) => void;
  setPrediction: (symbol: string, pred: CardHorizonPrediction) => void;
  setPredictionsFromBatch: (
    results: Record<string, { ok: boolean; status: number; data?: unknown; error?: unknown }>,
  ) => void;
  setGlobalHorizon: (h: HorizonMinutes) => void;
  setCardHorizon: (symbol: string, h: HorizonMinutes) => void;
  resolveHorizon: (symbol: string) => HorizonMinutes;
  setFilter: (f: AssetClassFilter) => void;
  setConnected: (v: boolean) => void;
  setFeedStatus: (s: string) => void;
}

export const ALL_MARKET_SYMBOLS: string[] = [
  ...new Set([
    ...OTC_FOREX_PAIRS.map((p) => p.symbol),
    ...REAL_FOREX_PAIRS.map((p) => p.symbol),
  ]),
];

/**
 * The 10 REAL_FOREX_PAIRS symbols only (assetSubType "forex") — used by the
 * grid to render the REAL badge and the PART 14/15 regime-gate ("scored_only")
 * non-tradable display for real-market pairs.
 */
export const REAL_MARKET_SYMBOLS: Set<string> = new Set(
  REAL_FOREX_PAIRS.map((p) => p.symbol),
);

export const useMarketTerminalStore = create<MarketTerminalState>()((set, get) => ({
  quotes: {},
  verdicts: {},
  predictions: {},
  globalHorizon: 1,
  cardHorizons: {},
  filter: "all",
  connected: false,
  feedStatus: "disconnected",
  _quoteVersion: 0,
  _verdictVersion: 0,

  setQuotes: (quotes) =>
    set((state) => {
      const next: Record<string, MarketQuote> = {};
      for (const q of quotes) {
        if (q?.symbol) next[q.symbol] = q;
      }
      const merged = { ...state.quotes, ...next };
      const changed =
        Object.entries(next).some(([sym, q]) => {
          const prev = state.quotes[sym];
          return (
            !prev ||
            prev.price !== q.price ||
            prev.spread !== q.spread ||
            prev.tickCount !== q.tickCount
          );
        }) || Object.keys(next).length !== Object.keys(state.quotes).length;
      return {
        quotes: merged,
        _quoteVersion: state._quoteVersion + (changed ? 1 : 0),
      };
    }),

  addQuote: (quote) =>
    set((state) => ({
      quotes: quote?.symbol ? { ...state.quotes, [quote.symbol]: quote } : state.quotes,
      _quoteVersion: state._quoteVersion + (quote?.symbol ? 1 : 0),
    })),

  ingestVerdict: (payload) =>
    set((state) => {
      if (!payload?.symbol) return state;
      const sym = payload.symbol.trim().toUpperCase();
      return {
        verdicts: {
          ...state.verdicts,
          [sym]: {
            direction: payload.direction,
            confidence: payload.confidence,
            current_price: payload.current_price,
            target_price: payload.target_price,
            market_waiting: payload.market_waiting,
            waiting_reason: payload.waiting_reason ?? null,
            waiting_detail: payload.waiting_detail ?? null,
            book_confluence: payload.book_confluence,
            timestamp: payload.timestamp ?? new Date().toISOString(),
          },
        },
        _verdictVersion: state._verdictVersion + 1,
      };
    }),

  setPrediction: (symbol, pred) =>
    set((state) => ({
      predictions: { ...state.predictions, [symbol]: pred },
    })),

  setPredictionsFromBatch: (results) =>
    set((state) => {
      const next = { ...state.predictions };
      for (const [sym, result] of Object.entries(results)) {
        const key = sym.trim().toUpperCase();
        if (!result) continue;
        const body = result.data as
          | (PredictionResponse & { market_waiting?: boolean; waiting_reason?: string | null; waiting_detail?: string | null })
          | undefined;
        next[key] = result.ok && body
          ? {
              status: "ok",
              direction: body.signal ?? null,
              confidence: body.confidence ?? null,
              market_waiting: body.market_waiting === true,
              waiting_reason: body.waiting_reason ?? null,
              waiting_detail: body.waiting_detail ?? null,
              data: body,
            }
          : {
              status: "error",
              direction: null,
              confidence: null,
              market_waiting: true,
              waiting_reason: result.error && typeof result.error === "object" && "error" in (result.error as object)
                ? String((result.error as { error?: string }).error ?? "unavailable")
                : "unavailable",
              waiting_detail: null,
              data: null,
            };
      }
      return { predictions: next };
    }),

  setGlobalHorizon: (horizon) =>
    set((state) => ({
      globalHorizon: horizon,
      // A global change clears per-card overrides so every card snaps to the
      // selected global horizon (the per-card override is a temporary zoom).
      cardHorizons: {},
    })),

  setCardHorizon: (symbol, horizon) =>
    set((state) => ({
      cardHorizons: { ...state.cardHorizons, [symbol]: horizon },
    })),

  resolveHorizon: (symbol) =>
    get().cardHorizons[symbol] ?? get().globalHorizon,

  setFilter: (filter) => set({ filter }),

  setConnected: (connected) => set({ connected }),

  setFeedStatus: (feedStatus) => set({ feedStatus }),
}));

export const selectTerminalConnected = (s: MarketTerminalState) => s.connected;
export const selectTerminalQuotes = (s: MarketTerminalState) => s.quotes;
export const selectTerminalVerdicts = (s: MarketTerminalState) => s.verdicts;
export const selectTerminalPredictions = (s: MarketTerminalState) => s.predictions;
export const selectGlobalHorizon = (s: MarketTerminalState) => s.globalHorizon;
export const selectTerminalFilter = (s: MarketTerminalState) => s.filter;