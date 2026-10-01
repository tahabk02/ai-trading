import { create } from "zustand";
import { OTC_FOREX_PAIRS, REAL_FOREX_PAIRS } from "@/constants/symbols";
import type { PredictionResponse, MarketQuote } from "@/services/api";
import {
  clampMinConfidencePct,
  MIN_CONFIDENCE_DEFAULT_PCT,
  persistHideBelowThreshold,
  persistMinConfidencePct,
  readPersistedHideBelowThreshold,
  readPersistedMinConfidencePct,
} from "@/lib/minConfidenceFilter";
import {
  clampTierSelection,
  persistTierSelection,
  readPersistedTierSelection,
} from "@/lib/tierFilter";
import { DEFAULT_EXECUTION_TIER, type SignalTier, type TierSelection } from "@/lib/signalTiers";
import {
  type AssetClass,
  type AssetClassFilter,
  persistAssetClasses,
  persistFavorites,
  persistHidden,
  persistSymbolQuery,
  readPersistedAssetClasses,
  readPersistedFavorites,
  readPersistedHidden,
  readPersistedSymbolQuery,
  sanitizeAssetClasses,
  sanitizeSymbolList,
  toggleClass,
  toggleSymbol,
} from "@/lib/assetFilter";

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

// "all" means "no isolation" and is expressed as the EMPTY class set — see
// `lib/assetFilter` for why it is a view rather than a stored class.
export type { AssetClassFilter } from "@/lib/assetFilter";

/** Market-quote snapshot (GET /api/v1/quotes + `market_quotes` WS). */
// MarketQuote is defined in services/api.ts (single source of truth shared
// with the REST client); re-exported here for store-local ergonomics.
export type { MarketQuote } from "@/services/api";

/**
 * Fields a quote CARD actually renders. `ageMs` is deliberately excluded: it
 * advances on every frame by construction and is only consumed by the latency
 * probe, so including it would defeat reference sharing entirely.
 */
const QUOTE_RENDER_FIELDS = [
  "price",
  "bid",
  "ask",
  "spread",
  "tickCount",
  "payout",
  "digits",
] as const satisfies readonly (keyof MarketQuote)[];

/**
 * True when two quote snapshots would render identically. Drives the
 * structural-sharing bail-out in `setQuotes` so an idle symbol keeps its
 * object identity (and therefore does not re-render) across 1Hz frames.
 */
export function quoteFieldsDiffer(prev: MarketQuote, next: MarketQuote): boolean {
  for (const field of QUOTE_RENDER_FIELDS) {
    if (prev[field] !== next[field]) return true;
  }
  return false;
}

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
  /**
   * Honest signal band for THIS verdict (T1..T5). Present for every tier,
   * including scored-only ones — the engine never rewrites it. `null` only
   * while an older/partial payload has not been normalised.
   */
  tier?: SignalTier | null;
  tier_label?: string | null;
  /** A real directional call exists (may still be scored-only). */
  dispatchable?: boolean;
  /** Directional but NOT executable at the operator's selected floor. */
  scored_only?: boolean;
  /** Engine authority on tradability for this request. */
  executable?: boolean;
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
  /**
   * Confidence Filter — minimum executable confidence (50..99%, default 96.5%).
   * Forwarded as `min_confidence` on every predict dispatch and applied as an
   * instant grid rule: pairs with a measurable confidence strictly below this
   * bar render SCORED-ONLY (and can be hidden via `hideBelowThreshold`).
   */
  minConfidencePct: number;
  /**
   * TIER SELECTOR — which signal bands the operator wants to trade
   * (T1..T5, default T1). Forwarded as `min_tier` on every predict dispatch so
   * the engine marks lower bands scored-only AT THE SOURCE. This never hides
   * data: the engine emits every computed tier with its true confidence, and
   * the selection only decides which of them are `executable`. Selecting T5
   * displays WEAK verdicts but the bar never drops below T4, so a WEAK verdict
   * can never trade.
   */
  minTier: TierSelection;
  /** Physically remove below-the-bar cards from the grid (default off — they
   *  render demoted so the blotter stays complete until the user opt-in). */
  hideBelowThreshold: boolean;
  connected: boolean;
  feedStatus: string;
  /** Monotonic version counters so cards re-render on quote/verdict change. */
  _quoteVersion: number;
  _verdictVersion: number;
  setQuotes: (quotes: MarketQuote[]) => void;
  addQuote: (quote: MarketQuote) => void;
  ingestVerdict: (payload: LiveVerdict & { symbol: string }) => void;
  setPrediction: (symbol: string, pred: CardHorizonPrediction) => void;
  /** Batch the per-symbol "pending" reset for a refresh into a single update. */
  markPredictionsPending: (symbols: string[]) => void;
  setPredictionsFromBatch: (
    results: Record<string, { ok: boolean; status: number; data?: unknown; error?: unknown }>,
  ) => void;
  setGlobalHorizon: (h: HorizonMinutes) => void;
  setCardHorizon: (symbol: string, h: HorizonMinutes) => void;
  resolveHorizon: (symbol: string) => HorizonMinutes;
  setFilter: (f: AssetClassFilter) => void;
  /**
   * ASSET FILTER (multi-select). See `lib/assetFilter` for the full contract.
   * `assetClasses` is a SET of venue classes; EMPTY means "show everything",
   * which is the default. Favorites/hidden/query are operator curation and
   * all persist to localStorage.
   */
  assetClasses: AssetClass[];
  favorites: string[];
  hiddenSymbols: string[];
  symbolQuery: string;
  favoritesOnly: boolean;
  toggleAssetClass: (c: AssetClass) => void;
  setAssetClasses: (c: AssetClass[]) => void;
  toggleFavorite: (symbol: string) => void;
  toggleHidden: (symbol: string) => void;
  setSymbolQuery: (q: string) => void;
  setFavoritesOnly: (v: boolean) => void;
  /** Reset every asset-filter field back to the "show everything" default. */
  resetAssetFilter: () => void;
  setMinConfidencePct: (v: number) => void;
  /** Choose which band (T1..T5) the operator wants to trade. */
  setMinTier: (v: TierSelection) => void;
  setHideBelowThreshold: (v: boolean) => void;
  /**
   * Hydrate localStorage-derived preferences (confidence bar + hide-below
   * toggle) AFTER first paint — never during module init. The store is
   * initialized DETERMINISTICALLY to the engine default on both server and
   * client, so React hydration always sees matching values (a persisted 87.0
   * is never rendered into the SSR tree, → no text-content mismatch, no
   * locked UI). Call once from a client-only useEffect.
   */
  hydrateClientPreferences: () => void;
  setConnected: (v: boolean) => void;
  setFeedStatus: (s: string) => void;
}

// The universe itself is owned by `constants/symbols` (single source of truth,
// shared with the pure filter module). Re-exported here because store
// consumers already import it from this path.
export { ALL_MARKET_SYMBOLS } from "@/constants/symbols";

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
  // HYDRATION SAFETY: the Confidence Filter bar initializes DETERMINISTICALLY
  // to the app default (96.5%) on BOTH the server and the client. Persisted
  // localStorage values (e.g. 87.0) are applied only via
  // `hydrateClientPreferences()` after first paint — never at module scope —
  // so SSR/client HTML can never diverge (the hydration-crash root cause).
  minConfidencePct: MIN_CONFIDENCE_DEFAULT_PCT,
  // Deterministic default on both server and client (mirrors
  // minConfidencePct). The persisted selection is applied only by
  // hydrateClientPreferences() after first paint, so SSR/client HTML can
  // never diverge.
  minTier: DEFAULT_EXECUTION_TIER,
  hideBelowThreshold: false,
  connected: false,
  feedStatus: "disconnected",
  _quoteVersion: 0,
  _verdictVersion: 0,

  setQuotes: (quotes) =>
    set((state) => {
      let merged: Record<string, MarketQuote> | null = null;
      let changed = false;
      // Structural sharing: reuse the previous object whenever a symbol's
      // RENDERED fields are identical. Card selectors subscribe per-symbol
      // (`s.quotes[symbol]`), so an unchanged reference makes zustand's
      // Object.is bail-out skip that card entirely. Without this every 1Hz
      // frame allocates 44 fresh quote objects and re-renders all 44 cards
      // even when nothing moved.
      for (const q of quotes) {
        if (!q?.symbol) continue;
        const prev = state.quotes[q.symbol];
        if (prev && !quoteFieldsDiffer(prev, q)) continue;
        if (!merged) merged = { ...state.quotes };
        merged[q.symbol] = q;
        changed = true;
      }
      if (Object.keys(state.quotes).length !== (merged ? Object.keys(merged).length : Object.keys(state.quotes).length)) {
        changed = true;
      }
      if (!changed) return state;
      return {
        quotes: merged ?? state.quotes,
        _quoteVersion: state._quoteVersion + 1,
      };
    }),

  addQuote: (quote) =>
    set((state) => {
      if (!quote?.symbol) return state;
      const prev = state.quotes[quote.symbol];
      if (prev && !quoteFieldsDiffer(prev, quote)) return state;
      return {
        quotes: { ...state.quotes, [quote.symbol]: quote },
        _quoteVersion: state._quoteVersion + 1,
      };
    }),

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

  markPredictionsPending: (symbols) =>
    set((state) => {
      // ONE set() for the whole batch. Calling setPrediction per symbol spread
      // the full predictions record 44 times per refresh and emitted 44 store
      // notifications, re-rendering every card 44x for a single frame change.
      let next: Record<string, CardHorizonPrediction> | null = null;
      for (const symbol of symbols) {
        const key = symbol?.trim?.().toUpperCase?.();
        if (!key) continue;
        const current = state.predictions[key];
        if (current?.status === "pending" && current.data === null) continue;
        if (!next) next = { ...state.predictions };
        next[key] = {
          status: "pending",
          direction: null,
          confidence: null,
          market_waiting: false,
          waiting_reason: null,
          waiting_detail: null,
          data: null,
        };
      }
      if (!next) return state;
      return { predictions: next };
    }),

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

  // The legacy single-select enum is now a VIEW over the multi-select set:
  // "all" clears isolation, anything else isolates exactly that one class.
  // Keeping `filter` in sync means older call sites (and the pill `aria-pressed`
  // wiring) keep working without a second source of truth.
  setFilter: (filter) => {
    const next = filter === "all" ? [] : sanitizeAssetClasses([filter as AssetClass]);
    persistAssetClasses(next);
    set({ filter, assetClasses: next });
  },

  assetClasses: [],
  favorites: [],
  hiddenSymbols: [],
  symbolQuery: "",
  favoritesOnly: false,

  toggleAssetClass: (target) => {
    const next = toggleClass(get().assetClasses, target);
    persistAssetClasses(next);
    set({ assetClasses: next });
  },

  setAssetClasses: (classes) => {
    const next = sanitizeAssetClasses(classes);
    persistAssetClasses(next);
    set({ assetClasses: next });
  },

  toggleFavorite: (symbol) => {
    const next = toggleSymbol(get().favorites, symbol);
    persistFavorites(next);
    set({ favorites: next });
  },

  toggleHidden: (symbol) => {
    const next = toggleSymbol(get().hiddenSymbols, symbol);
    persistHidden(next);
    set({ hiddenSymbols: next });
  },

  setSymbolQuery: (query) => {
    persistSymbolQuery(query);
    set({ symbolQuery: query });
  },

  setFavoritesOnly: (favoritesOnly) => set({ favoritesOnly }),

  resetAssetFilter: () => {
    persistAssetClasses([]);
    persistFavorites([]);
    persistHidden([]);
    persistSymbolQuery("");
    set({
      filter: "all",
      assetClasses: [],
      favorites: [],
      hiddenSymbols: [],
      symbolQuery: "",
      favoritesOnly: false,
    });
  },

  // NOTE: persistence is deliberately OUTSIDE the `set()` updater.
  // Zustand updaters are pure and React StrictMode double-invokes them, so a
  // `localStorage.setItem` inside the updater can fire twice per change. Keeping
  // the write before `set()` also means the store update itself stays a pure
  // state transition, which is what keeps a slider drag off the main thread's
  // slow path.
  setMinConfidencePct: (value) => {
    const clamped = clampMinConfidencePct(value);
    persistMinConfidencePct(clamped);
    set({ minConfidencePct: clamped });
  },

  setMinTier: (value) => {
    const clamped = clampTierSelection(value);
    persistTierSelection(clamped);
    set({ minTier: clamped });
  },

  setHideBelowThreshold: (value) => {
    persistHideBelowThreshold(value);
    set({ hideBelowThreshold: value });
  },

  // Client-only (safe in node/SSR: no-ops). Reads the persisted preferences
  // and applies them post-hydration so the first painted frame always matches.
  hydrateClientPreferences: () => {
    if (typeof window === "undefined") return;
    const classes = readPersistedAssetClasses();
    set((state) => ({
      ...(readPersistedMinConfidencePct() !== state.minConfidencePct
        ? { minConfidencePct: readPersistedMinConfidencePct() }
        : {}),
      ...(readPersistedTierSelection() !== state.minTier
        ? { minTier: readPersistedTierSelection() }
        : {}),
      ...(readPersistedHideBelowThreshold() !== state.hideBelowThreshold
        ? { hideBelowThreshold: readPersistedHideBelowThreshold() }
        : {}),
      // Asset filter hydration is client-only for the SAME reason: the store
      // initializes deterministically to "show everything" on both server and
      // client, so a persisted isolation can never diverge the SSR tree. The
      // `filter` enum is derived from the restored class set so the legacy
      // single-select mirror stays consistent from the very first frame.
      ...(classes.length !== state.assetClasses.length ||
      classes.some((c, i) => c !== state.assetClasses[i])
        ? {
            assetClasses: classes,
            filter:
              classes.length === 0
                ? ("all" as AssetClassFilter)
                : classes.length === 1
                  ? (classes[0] as AssetClassFilter)
                  : ("all" as AssetClassFilter),
          }
        : {}),
      ...(readPersistedFavorites().length !== state.favorites.length
        ? { favorites: sanitizeSymbolList(readPersistedFavorites()) }
        : {}),
      ...(readPersistedHidden().length !== state.hiddenSymbols.length
        ? { hiddenSymbols: sanitizeSymbolList(readPersistedHidden()) }
        : {}),
      ...(readPersistedSymbolQuery() !== state.symbolQuery
        ? { symbolQuery: readPersistedSymbolQuery() }
        : {}),
    }));
  },

  setConnected: (connected) => set({ connected }),

  setFeedStatus: (feedStatus) => set({ feedStatus }),
}));

export const selectTerminalConnected = (s: MarketTerminalState) => s.connected;
export const selectTerminalQuotes = (s: MarketTerminalState) => s.quotes;
export const selectTerminalVerdicts = (s: MarketTerminalState) => s.verdicts;
export const selectTerminalPredictions = (s: MarketTerminalState) => s.predictions;
export const selectGlobalHorizon = (s: MarketTerminalState) => s.globalHorizon;
export const selectTerminalFilter = (s: MarketTerminalState) => s.filter;
export const selectAssetClasses = (s: MarketTerminalState) => s.assetClasses;
export const selectFavorites = (s: MarketTerminalState) => s.favorites;
export const selectHiddenSymbols = (s: MarketTerminalState) => s.hiddenSymbols;
export const selectSymbolQuery = (s: MarketTerminalState) => s.symbolQuery;
export const selectFavoritesOnly = (s: MarketTerminalState) => s.favoritesOnly;
export const selectMinConfidencePct = (s: MarketTerminalState) => s.minConfidencePct;
export const selectMinTier = (s: MarketTerminalState) => s.minTier;
export const selectHideBelowThreshold = (s: MarketTerminalState) => s.hideBelowThreshold;