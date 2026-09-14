import axios from "axios";
import { create } from "zustand";
import apiClient, {
  type PredictionResponse,
  type PredictionError,
  type SignalData,
  type CandleDataPoint,
  type RiskStateSnapshot,
} from "@/services/api";
import {
  DEFAULT_SYMBOL,
  OTC_FOREX_PAIRS,
  isWhitelistedOtcpair,
} from "@/constants/symbols";
import {
  RealtimeCandleAggregator,
  type Candle,
  type Timeframe,
  isTimeframe,
  normalizeTimeframe,
  TIMEFRAME_MS,
} from "@/lib/realtimeCandleAggregator";
import tradingAccuracyVerifier, {
  ERROR_RATE_LIMIT,
} from "@/lib/accuracyVerifier";

// ── localStorage key ──
const LS_TIMEFRAME_KEY = "selected_timeframe";
const LS_LEAD_OFFSET_KEY = "selected_lead_offset_ms";

// ── SUB-MINUTE CHART GRID ↔ AI THERMAL HORIZON BRIDGE ──
// PO canonical sub-minute timeframes (S5..S30). The ai-engine thermal
// quant matrix evaluates at >= 1m horizons only (schemas.py whitelist).
// A raw "S5" /predict would 422 — the failure surface that used to lock
// the engine into a HOLD state. The CHART keeps its own sub-minute bucket;
// the /predict REQUEST is coerced to "1m" (the nearest supported thermal
// channel), so a healthy live stream always resolves a genuine directional
// signal instead of a whitelist-dead 422.
const PO_TO_BACKEND_TF: Record<string, string> = {
  S5: "1m", S10: "1m", S15: "1m", S30: "1m",
  M1: "1m", M2: "2m", M3: "3m", M5: "5m",
  M10: "10m", M15: "15m", M30: "30m",
  H1: "1h", H4: "4h", D1: "1d",
};
export function aiTimeframeFor(timeframe: string): string {
  const upper = (timeframe || "").trim().toUpperCase();
  if (PO_TO_BACKEND_TF[upper]) return PO_TO_BACKEND_TF[upper];
  return (timeframe || "").trim().toLowerCase() || "1m";
}

// ── SERVER-AUTHORITATIVE CLOSED CANDLE CONTRACT ──
// The backend's realtime candle aggregator pushes closed candles over the
// WebSocket `candle` event and replays accumulated history via
// `history_candles`. These are the single source of truth for CLOSED bars on
// the chart; the client's own aggregator only builds the current forming bar.
export interface ServerSettledCandle {
  symbol: string;
  timeframe: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  closed?: boolean;
}

// ── LIVE-SIGNAL ID UNIQUENESS (React key-collision fix) ──
// `live-${Date.now()}` alone collided when two WS events (e.g. a live_quant
// signal + a new_signal broadcast) were processed within the same millisecond
// — both entries shared one `id`, producing duplicate React keys in the
// liveSignals list (Alpha Stream). A SINGLE monotonic session counter now
// suffixes EVERY live-signal id — `live-` WS feeds (`new_signal`,
// `live_quant_signal`, `symbol_update`) AND `pred-` /predict responses — so
// ids stay strictly unique per insert even when the wall-clock millisecond
// repeats across producers.
let liveSignalIdCounter = 0;
function nextLiveSignalId(prefix: "live" | "pred" | "verify"): string {
  liveSignalIdCounter += 1;
  return `${prefix}-${Date.now()}-${liveSignalIdCounter}`;
}

// ── Risk-state polling ──
// A SINGLE shared setInterval owned by ONE consumer (the first component that
// subscribes). Previously each of KillSwitchBanner, TradingPanel and the
// risk-rules page spawned its OWN 30s timer, firing /risk-state on average
// every 10s across a page. This consolidates that to ONE 30s loop.
const RISK_POLL_MS = 30_000;
let riskPollInterval: ReturnType<typeof setInterval> | null = null;
let riskPollRefCount = 0;

/** Start the shared /risk-state poller (idempotent, ref-counted). */
export function startRiskPolling(refresh: () => Promise<void>): void {
  riskPollRefCount += 1;
  if (riskPollInterval) return;
  void refresh();
  riskPollInterval = setInterval(() => void refresh(), RISK_POLL_MS);
}

/** Stop / decrement the shared /risk-state poller. */
export function stopRiskPolling(): void {
  riskPollRefCount = Math.max(0, riskPollRefCount - 1);
  if (riskPollRefCount === 0 && riskPollInterval) {
    clearInterval(riskPollInterval);
    riskPollInterval = null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// /predict REQUEST COALESCING + DEBOUNCE (client-side rate shield)
//
// Root cause of the HTTP 429 / ERR_INSUFFICIENT_RESOURCES storm: the candle
// aggregator's wall-clock sync emitted onCandleClose during history seeding;
// each close fired getPrediction, which re-seeded, which re-emitted close…
// an infinite /predict loop that accumulated queued duplicates and exhausted
// the browser's connection pool. Two module-level guards now bound /predict:
//
//   1) identity coalescing — only ONE in-flight fetch per (symbol, timeframe).
//      Every duplicate caller (mount effects, symbol selector, candle-close
//      dispatch, timeframe switch) awaits the SAME promise instead of opening
//      another socket.
//   2) debounce — skip starting a new fetch if one for the SAME key began
//      within PREDICT_MIN_INTERVAL_MS, so /predict tops out at ~1 request /
//      5s per symbol+timeframe no matter what triggers it.
// ────────────────────────────────────────────────────────────────────────
const PREDICT_MIN_INTERVAL_MS = 5000;
const predictionInFlight = new Map<string, Promise<void>>();
const lastPredictionStartedAt = new Map<string, number>();

// ── AUTO-RECOVERY / RE-POLL ON 503 · LIVE-QUOTE TIMEOUT ──
// A 503 Service Unavailable or an axios ECONNABORTED (>15s live-quote timeout)
// is a TRANSIENT condition, not an application error. Instead of painting a red
// error the store flips `quoteStreamWaiting` (calm "Waiting for live asset
// stream..." banner, previous good prediction stays on screen) and schedules an
// EXPONENTIAL BACKOFF re-poll for the SAME (symbol, timeframe). The instant the
// backend / quote stream recovers, the retry lands, predictionData refreshes
// and signal generation resumes — no manual refresh, no error spam.
//
//   delay = min(30s, 1s · 2^(attempt-1))  →  1s, 2s, 4s, 8s, 16s, 30s…
const PREDICT_RETRY_BASE_MS = 1_000;
const PREDICT_RETRY_MAX_MS = 30_000;
const predictionRetryTimers = new Map<string, unknown>();
const predictionRetryAttempts = new Map<string, number>();

/** Cancel a PENDING backoff timer for a key (attempt counter preserved). */
function clearPredictionRetryTimer(key: string): void {
  const handle = predictionRetryTimers.get(key);
  if (handle != null) {
    if (typeof window !== "undefined") {
      window.clearTimeout(handle as number);
    } else {
      (globalThis as { clearTimeout?: (h: unknown) => void }).clearTimeout?.(
        handle,
      );
    }
    predictionRetryTimers.delete(key);
  }
}

/** Full reset — cancel timer AND the attempt counter (success / hard error / symbol switch). */
function clearPredictionRetry(key: string): void {
  clearPredictionRetryTimer(key);
  predictionRetryAttempts.delete(key);
}

function schedulePredictionRetry(key: string): void {
  if (typeof window === "undefined") return;
  const attempt = (predictionRetryAttempts.get(key) ?? 0) + 1;
  predictionRetryAttempts.set(key, attempt);
  const delayMs = Math.min(
    PREDICT_RETRY_MAX_MS,
    PREDICT_RETRY_BASE_MS * 2 ** (attempt - 1),
  );
  clearPredictionRetryTimer(key);
  predictionRetryTimers.set(
    key,
    setTimeout(() => {
      predictionRetryTimers.delete(key);
      // Never re-poll a pair the user has navigated away from.
      const state = useTradingStore.getState();
      const [sym] = key.split("|");
      if (state.activeSymbol.toUpperCase() !== (sym || "")) return;
      // Bypass the 5s debounce — the whole point is an immediate recovery probe.
      lastPredictionStartedAt.delete(key);
      void state.getPrediction(sym, state.selectedTimeframe);
    }, delayMs),
  );
}

function predictionKey(symbol: string, timeframe: string): string {
  return `${(symbol || "").trim().toUpperCase()}|${(timeframe || "")
    .trim()
    .toLowerCase()}`;
}

/**
 * Read persisted timeframe from localStorage, returning canonical PO form.
 * Falls back to "S5" if stored value is invalid.
 */
function getPersistedTimeframe(): string {
  if (typeof window === "undefined") return "S5";
  try {
    const stored = localStorage.getItem(LS_TIMEFRAME_KEY);
    if (stored && isTimeframe(stored)) {
      return normalizeTimeframe(stored) ?? "S5";
    }
  } catch {
    // localStorage may be unavailable (SSR, privacy mode, etc.)
  }
  return "S5";
}

/**
 * Read the persisted predictive lead-time offset (ms) from localStorage.
 * NULL means "aggregator default" = lead 0, the exact PO floor grid — candles
 * line up 1:1 with the backend's `floor(ts / interval) * interval`. Any stored
 * value that is not a finite non-negative number is ignored (defaults to NULL).
 */
function getPersistedLeadOffset(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(LS_LEAD_OFFSET_KEY);
    if (stored == null || stored === "") return null;
    const ms = Number(stored);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  } catch {
    // localStorage may be unavailable (SSR, privacy mode, etc.)
  }
  return null;
}

// ── Types ──

export interface SymbolEntry {
  symbol: string;
  name: string;
  type: "stock" | "crypto" | "etf" | "otc";
  exchange: string;
  currency: string;
  /** Dynamic return percentage (e.g. 92) — served by /symbols from live ATR */
  payout: number;
  /** UI label (e.g. "AUD/CAD OTC") */
  label: string;
  /** Decimal precision for price display */
  digits: number;
}

export interface QuantTickSnapshot {
  symbol: string;
  price: number;
  timestamp: number;
  receivedAt: number;
}

export type POExpiration = 1 | 5 | 10 | 15 | 20 | 30 | 60 | 120 | 180 | 300 | 600 | 900 | 1800 | 3600 | 14400 | 43200 | 86400;
export const PO_EXPIRATION_SECONDS_SET = new Set<number>([1,5,10,15,20,30,60,120,180,300,600,900,1800,3600,14400,43200,86400]);
function snapToNearestExpiration(seconds: number): POExpiration {
  if (!Number.isFinite(seconds) || seconds <= 0) return 60;
  const arr = [1,5,10,15,20,30,60,120,180,300,600,900,1800,3600,14400,43200,86400];
  let best = arr[0];
  for (const v of arr) { if (Math.abs(seconds - v) < Math.abs(seconds - best)) best = v; }
  return best as POExpiration;
}

export interface TradingState {
  feedStatus: "awaiting_ssid" | "auth_failed" | "degraded" | "live" | "stalled" | "disconnected";
  /** Currently selected trading symbol */
  activeSymbol: string;

  /**
   * UNIFIED live market price — single source of truth for ALL views.
   */
  currentPrice: number;

  /** Timestamp of the last price update (ISO string) */
  lastPriceUpdate: string | null;

  /** Latest AI prediction data */
  predictionData: PredictionResponse | null;

  /**
   * PER-SYMBOL PREDICTION SNAPSHOT CACHE — last real evaluation per symbol,
   * keyed by NORMALIZED symbol (e.g. "EUR/USD"). On symbol switch, the panel
   * instantly restores the last REAL evaluation (honest, timestamped, labeled)
   * while a fresh forced /predict resolves. Only timeframe-matched snapshots
   * are restored (mismatched → null → brief blank until fresh eval arrives).
   */
  predictionBySymbol: Record<string, PredictionResponse | null>;

  /**
   * PER-SYMBOL CANDLE SCOPING — the single source of truth for raw candles.
   * Keyed by the NORMALIZED symbol (e.g. "KES/USD", "MAD/USD", "AUD/CAD").
   * Each key holds ONLY that symbol's unique raw OHLC stream from the backend,
   * so switching pairs never bleeds one pair's candles into another.
   */
  candlesCache: Record<string, CandleDataPoint[]>;

  /**
   * REAL-TIME AGGREGATED OHLCV SERIES — produced by the RealtimeCandleAggregator
   * from live WebSocket ticks. Keyed by normalized symbol. This is the live
   * chart series that updates on every tick and re-buckets on timeframe switch.
   */
  realtimeCandles: Record<string, Candle[]>;

  /**
   * SERVER-AUTHORITATIVE CLOSED CANDLES — pushed by the backend's realtime
   * candle aggregator over the WebSocket (`candle` event on close, plus the
   * `history_candles` replay on subscribe). Keyed by normalized symbol then
   * timeframe ("S5" | "S10" | "S15" | "S30" | "M1"). The chart renders these as the
   * authoritative CLOSED base and overlays the client aggregator's CURRENT
   * forming bar only (zero server bars → fall back to the resident
   * prediction/aggregator history).
   */
  serverCandles: Record<string, Record<string, Candle[]>>;

  /** Monotonic counter bumped on every server candle upsert / seed — drives
   *  the chart's swapKey so a newly closed authoritative bar repaints. */
  serverCandleVersion: number;

  /** Monotonic generation counter — incremented on every hard feed reset. */
  dataEpoch: number;

  lastQuantDispatch: QuantTickSnapshot | null;

  /** Loading state for prediction */
  isLoading: boolean;

  /**
   * TRANSIENT "quote stream / backend temporarily unavailable" flag. True only
   * while a recoverable prediction failure (HTTP 503 or >15s live-quote
   * timeout) is being re-polled with exponential backoff. The UI shows a calm
   * "Waiting for live asset stream..." banner; the last good prediction stays
   * visible until a retry lands.
   */
  quoteStreamWaiting: boolean;

  /** Error message from prediction request (HARD failures only — never 503/timeout) */
  error: string | null;

  /** Live signals from HTTP polling (historical list for Alpha Stream) */
  liveSignals: SignalData[];

  /** Order book levels (simplified) */
  orderBook: {
    bids: Array<{ price: number; volume: number }>;
    asks: Array<{ price: number; volume: number }>;
  };

  /** Price version counter for forcing re-renders */
  _priceVersion: number;

  /** Internal request tracking ID to prevent race conditions */
  _lastRequestId: number;

  selectedTimeframe: "S5" | "S10" | "S15" | "S30" | "M1" | "M2" | "M3" | "M5" |
    "M10" | "M15" | "M30" | "H1" | "H4" | "D1";
  /** Derived timeframe in seconds (e.g. "M5" → 300). Auto-synced with selectedTimeframe. */
  selectedTimeframeSeconds: number;

  /**
   * PREDICTION EXPIRATION (seconds) — Pocket-Option canonical set.
   * Fully decoupled from `selectedTimeframe`: changing this NEVER touches
   * the candle build bucket. The chart computes target-candle count as
   * max(1, min(30, round(selectedExpirationSeconds / selectedTimeframeSeconds))).
   */
  selectedExpirationSeconds: number;

  /** Predictive lead-time offset (ms) — how far ahead of the external feed the
   *  forming candle is projected. NULL selects the aggregator default (exactly
   *  one selected timeframe). SSR-safe: always NULL on first render; the
   *  persisted value is re-applied post-mount via hydrateLeadOffset(). */
  selectedLeadOffsetMs: number | null;

  /** Full list of available symbols for autocomplete search */
  symbolsList: SymbolEntry[];

  // ── Pocket Option Trading State (NO FAKE MONEY) ──
  /** Expiration time in seconds (60=1m, 120=2m, 300=5m, etc.) */
  expirationSeconds: number;
  /** Countdown remaining seconds for active trade */
  countdownSeconds: number;
  /** Whether a trade is currently active/executing */
  isTradeActive: boolean;
  /** Last trade result notification */
  lastTradeResult: string | null;
  /** Trade history */
  tradeHistory: import("@/services/api").TradeResponse[];

  // ── ADVANCED RISK MANAGEMENT & KILL SWITCH ──
  /** Live daily-risk snapshot (drawdown %, equity curve, lock status). */
  riskState: RiskStateSnapshot | null;
  /** True when the automated kill switch has locked trade execution. */
  isKillSwitchLocked: boolean;
  /** Human-readable reason the kill switch engaged. */
  killSwitchReason: string | null;

  /** Refresh the risk snapshot from the backend. */
  refreshRiskState: () => Promise<void>;
  /** Manual kill-switch reset (clears the execution lock). */
  resetKillSwitch: () => Promise<void>;
  /** EMERGENCY LOCK — manually engage the kill switch (locks live trading). */
  engageKillSwitch: (reason?: string) => Promise<void>;

  // ── Actions ──
  setActiveSymbol: (symbol: string) => void;
  setFeedStatus: (status: TradingState["feedStatus"]) => void;
  setSelectedTimeframe: (timeframe: string) => void;
  /**
   * HYDRATION-SAFE persisted-timeframe restore. The store initializes
   * `selectedTimeframe` deterministically ("S5") so server-rendered markup
   * matches the client's first paint; call this once from a mount effect to
   * re-apply the user's localStorage choice with zero hydration drift.
   */
  hydrateSelectedTimeframe: () => void;
  /**
   * HYDRATION-SAFE persisted lead-offset restore (NULL → aggregator default of
   * one full selected timeframe). Applied from the same post-mount hydration
   * path as hydrateSelectedTimeframe so the predictive grid re-projects ahead
   * of the feed on first paint with zero hydration drift.
   */
  hydrateLeadOffset: () => void;
  /**
   * Configure the chart's PREDICTIVE LEAD-TIME OFFSET — the wall-clock amount
   * of time the forming candle is projected ahead of the external platform
   * (e.g. 20s / 1m). NULL restores the aggregator default (exactly one
   * selected timeframe). Persisted to localStorage and the live series is
   * re-projected onto the new lead grid immediately (no seams, no blanks).
   */
  setLeadOffset: (offsetMs: number | null) => void;
  getPrediction: (
    symbol: string,
    timeframe?: string,
    signal?: AbortSignal,
    force?: boolean,
  ) => Promise<void>;
  addLiveSignal: (signal: SignalData) => void;
  setLiveSignals: (signals: SignalData[]) => void;
  clearError: () => void;
  flushPriceCache: () => void;
  fetchSymbols: () => Promise<void>;
  fetchRecentSignals: () => Promise<void>;
  // ── Real-time aggregator actions ──
  ingestLiveTick: (rawTick: unknown) => void;
  setAggregatorTimeframe: (timeframe: string) => void;
  hardResetLiveData: () => void;
  replayTicks: (symbol: string, ticks: unknown[]) => void;
  seedAggregatorHistory: (symbol: string, candles: CandleDataPoint[]) => void;
  seedAggregatorPrice: (symbol: string, price: number) => void;
  // ── Server-authoritative candle actions ──
  /** Upsert a SINGLE closed candle pushed by the backend (`candle` event). */
  applyServerCandle: (payload: ServerSettledCandle) => void;
  /** Seed ONE timeframe's authoritative CLOSED history (`history_candles`). */
  seedServerCandles: (
    symbol: string,
    timeframe: string,
    candles: Candle[],
  ) => void;
  getRealtimeSeries: (symbol: string) => Candle[];
  syncAggregatorWallClock: () => void;
  ingestQuantDispatch: (payload: {
    symbol?: string;
    signalType?: string;
    signal_type?: string;
    signal?: string;
    direction?: string;
    price?: number;
    entry_price?: number;
    current_price?: number;
    tick?: number;
    confidence?: number;
    confidence_score?: number;
    targetPrice?: number;
    target_price?: number;
    take_profit?: number;
    stop_loss?: number;
    timestamp?: string;
    market_waiting?: boolean;
    waiting_reason?: string | null;
    waiting_detail?: string | null;
  }) => void;
  // ── Trading Actions ──
  setExpirationSeconds: (seconds: number) => void;
  /**
   * Set the PREDICTION expiration (seconds, PO canonical set). This drives
   * ONLY the target-candle count + target-price horizon on the chart — it
   * NEVER touches the candle build bucket (`selectedTimeframe`). Non-member
   * values snap to the nearest PO expiration.
   */
  setSelectedExpirationSeconds: (seconds: number) => void;
  executeTrade: (direction: "CALL" | "PUT") => Promise<void>;
  clearTradeResult: () => void;
  /**
   * Apply a live signal broadcast over the WebSocket (`new_signal` /
   * `symbol_update`) to the ACTIVE trading signal so the panel badge + the
   * ACHAT/VENTE execution buttons track the engine's latest direction
   * without any manual reload or polling.
   */
  applyLiveSignal: (payload: {
    symbol?: string;
    signalType?: string;
    signal_type?: string;
    signal?: string;
    direction?: string;
    price?: number;
    entry_price?: number;
    current_price?: number;
    confidence?: number;
    confidence_score?: number;
    targetPrice?: number;
    target_price?: number;
    take_profit?: number;
    stop_loss?: number;
    timestamp?: string;
    market_waiting?: boolean;
    waiting_reason?: string | null;
    waiting_detail?: string | null;
  }) => void;
}

// ── Store ──

/**
 * ZERO-HOP HANDLE TO THE SHARED CANDLE AGGREGATOR.
 *
 * Lets the chart engine subscribe directly to live candle events (see
 * `RealtimeCandleAggregator.subscribeLive`) WITHOUT traversing React state —
 * the whole WebSocket-tick → series.update() path runs synchronously inside
 * the socket handler's call stack (sub-millisecond UI sync). Assigned when the
 * store initialises (the create() initializer below runs at module load).
 */
export let realtimeAggregator: RealtimeCandleAggregator;

/** Minimum gap between heavy `realtimeCandles` React publishes (per symbol).
 *  Live chart morphs run on the zero-hop aggregator subscription, so the store
 *  only needs to refresh the React-merged series on bucket rollover or every
 *  ~200ms — cutting ~100× worth of full-array merges per tick burst. */
const REALTIME_PUBLISH_INTERVAL_MS = 200;

export const useTradingStore = create<TradingState>((set, get) => {
  // ── LIVE TICK RENDER COALESCER ──
  // Tracks, per symbol, the last live-candle signature we wrote into
  // `realtimeCandles`. Only forces a React re-render when the candle OBSERVABLY
  // changes (new bucket, updated OHLC) AND the throttle window has elapsed.
  const liveSignatures = new Map<string, string>();
  const lastRealtimePublish = new Map<string, number>();
  const lastPublishedBucket = new Map<string, number>();

  const syncStoreCandle = (candle: Candle, symbol: string) => {
    const norm = (symbol || "").trim().toUpperCase();
    const active = (get().activeSymbol || "").trim().toUpperCase();
    if (norm && active && norm !== active) return;

    const sig =
      `${candle.timestamp}:${candle.open}:${candle.high}:${candle.low}:` +
      `${candle.close}:${candle.volume}`;
    const changed = liveSignatures.get(norm) !== sig;
    const now = Date.now();
    const lastPublish = lastRealtimePublish.get(norm) ?? 0;
    const bucketChanged = lastPublishedBucket.get(norm) !== candle.timestamp;
    // The heavy full-series publish is gated: immediately on bucket rollover
    // (the React side must see the freshly appended bar) and at most every
    // ~200ms otherwise. Per-tick candle morphs never wait on this — the chart
    // receives them synchronously through the aggregator's zero-hop stream.
    const publishSeries =
      changed &&
      (bucketChanged || now - lastPublish >= REALTIME_PUBLISH_INTERVAL_MS);

    set((s) => {
      const patch: Partial<TradingState> = {
        currentPrice:
          aggregator.getLastPrice(norm) > 0
            ? aggregator.getLastPrice(norm)
            : s.currentPrice,
        lastPriceUpdate: new Date().toISOString(),
        _priceVersion: s._priceVersion + 1,
      };
      if (publishSeries) {
        liveSignatures.set(norm, sig);
        lastRealtimePublish.set(norm, now);
        lastPublishedBucket.set(norm, candle.timestamp);
        patch.realtimeCandles = {
          ...s.realtimeCandles,
          [norm]: aggregator.getSeries(norm),
        };
      }
      return patch;
    });
  };

  // ── SINGLETON REAL-TIME CANDLE AGGREGATOR ──
  // Owned by the store so the chart, the AI pipeline, and the timeframe
  // selector all share ONE authoritative OHLCV aggregation engine.
  const aggregator = new RealtimeCandleAggregator("M1", {
    zeroFabrication: true,
    onCandleClose: (candle, symbol, timeframe) => {
      // ════════════════════════════════════════════════════════════════
      // CANDLE CLOSE → ASYNC /predict DISPATCH
      // Every time a real live candle bucket rolls over, fetch the FastAPI
      // /predict endpoint for the active symbol and timeframe. Response
      // updates predictionData + confidence instantly.
      //
      // getPrediction() is coalescing + debounced per (symbol, timeframe) at
      // the STORE level, so even if this fires several times in one tick
      // (rollover + backfill) only ONE network request is ever issued.
      // ════════════════════════════════════════════════════════════════
      const state = useTradingStore.getState();
      const active = state.activeSymbol;
      if (active && active === symbol) {
        void state.getPrediction(active, timeframe);
      }
    },
    onRawBar: (candle, symbol, timeframe) => {
      tradingAccuracyVerifier.realizeBar({
        symbol,
        timeframe,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        timestamp: candle.timestamp,
      });
    },
    onProjection: (event) => {
      const projection = event.projection;
      if (!projection) return;
      tradingAccuracyVerifier.recordProjection({
        symbol: event.symbol,
        timeframe: event.timeframe,
        bucketOpen:
          projection.bucketOpen > 0
            ? projection.bucketOpen
            : event.geometry.bucketOpen,
        direction: projection.slopePerMs > 0 ? "BUY" : "SELL",
        projectionClose: projection.close,
        projectedHigh: projection.high,
        projectedLow: projection.low,
        recordedAt: Date.now(),
      });
    },
    onCandleUpdate: (candle, symbol) => {
      syncStoreCandle(candle, symbol);
    },
  });
  // Zero-hop handle for the chart engine's direct live subscription.
  realtimeAggregator = aggregator;

  // ── AUTONOMOUS PAIR INDEX ──
  // Pre-register every selectable OTC pair (the full whitelist) so the
  // wall-clock engine buckets ALL of them from the first frame — each pair's
  // live bar opens on the exact timeframe boundary the moment it has a real
  // price, with zero dependency on an external feed handshake. The projector
  // drives the DEFAULT pair immediately; the switch handler re-aims it.
  aggregator.registerSymbols(OTC_FOREX_PAIRS.map((p) => p.symbol));
  aggregator.setActiveSymbol(DEFAULT_SYMBOL);
  aggregator.startHeartbeat();
  aggregator.startProjector();

  return {
    // ── State defaults ──
    activeSymbol: DEFAULT_SYMBOL, // "EUR/USD" — strict OTC whitelist default
    feedStatus: "awaiting_ssid",
    currentPrice: 0,
    lastPriceUpdate: null,
    predictionData: null,
    predictionBySymbol: {},
    candlesCache: {},
    realtimeCandles: {},
    serverCandles: {},
    serverCandleVersion: 0,
    dataEpoch: 0,
    lastQuantDispatch: null,
    isLoading: false,
    error: null,
    quoteStreamWaiting: false,
    liveSignals: [],
    orderBook: {
      bids: [],
      asks: [],
    },
    _priceVersion: 0,
    _lastRequestId: 0,
    // ── DETERMINISTIC SSR DEFAULT (hydration safety) ──
    // Reading localStorage during store creation made the SERVER render "S5"
    // while the CLIENT's first render could restore e.g. "M5" → mismatched
    // active-timeframe markup → React hydration error. Always start at "S5";
    // hydrateSelectedTimeframe() re-applies the persisted value post-mount.
    selectedTimeframe: "S5",
    selectedTimeframeSeconds: 5,
    // ── DETERMINISTIC SSR DEFAULT (hydration safety) ──
    // Same hydration-safe path as selectedTimeframe: the lead-time offset
    // begins at NULL (aggregator default = one selected timeframe ahead) so
    // server markup matches first paint; hydrateLeadOffset() re-applies the
    // user's persisted choice post-mount.
    selectedLeadOffsetMs: null,
    symbolsList: OTC_FOREX_PAIRS.map((p) => ({
      symbol: p.symbol,
      name: p.name,
      type: "otc",
      exchange: "OTC_LIVE_FOREX",
      currency: p.symbol.split("/")[1] ?? "USD",
      payout: p.payout,
      label: p.label,
      digits: p.digits,
    })),

    // ── Pocket Option Trading Defaults ──
    expirationSeconds: 60, // 1 minute default
    selectedExpirationSeconds: 60, // chart expiration = 1 minute default (decoupled from timeframe)
    countdownSeconds: 0,
    isTradeActive: false,
    lastTradeResult: null,
    tradeHistory: [],

    // ── Kill Switch Defaults ──
    riskState: null,
    isKillSwitchLocked: false,
    killSwitchReason: null,

    refreshRiskState: async () => {
      try {
        const snapshot = await apiClient.getRiskState();
        set({
          riskState: snapshot,
          isKillSwitchLocked: snapshot.killSwitchLocked,
          killSwitchReason: snapshot.lockedReason,
        });
      } catch (err) {
        console.warn("[store] refreshRiskState failed:", err);
      }
    },

    resetKillSwitch: async () => {
      try {
        const snapshot = await apiClient.resetKillSwitch();
        set({
          riskState: snapshot,
          isKillSwitchLocked: snapshot.killSwitchLocked,
          killSwitchReason: snapshot.lockedReason,
          lastTradeResult: "✅ Kill switch reset — trading unlocked.",
        });
      } catch (err) {
        console.warn("[store] resetKillSwitch failed:", err);
        set({ lastTradeResult: "❌ Failed to reset kill switch." });
      }
    },

    engageKillSwitch: async (reason?: string) => {
      try {
        const snapshot = await apiClient.engageKillSwitch(reason);
        set({
          riskState: snapshot,
          isKillSwitchLocked: snapshot.killSwitchLocked,
          killSwitchReason: snapshot.lockedReason,
          lastTradeResult: "⛔ EMERGENCY STOP — trading locked.",
        });
      } catch (err) {
        console.warn("[store] engageKillSwitch failed:", err);
        set({ lastTradeResult: "❌ Failed to engage kill switch." });
      }
    },

    // ── Actions ──

    fetchRecentSignals: async () => {
      try {
        const signals = await apiClient.getSignals(undefined, 50);
        if (Array.isArray(signals) && signals.length > 0) {
          set({ liveSignals: signals.slice(0, 100) });
        }
      } catch (err) {
        console.warn("[store] fetchRecentSignals failed:", err);
      }
    },

    setActiveSymbol: (symbol: string) => {
      const cleanSymbol = symbol.trim().toUpperCase();
      if (!cleanSymbol) return;

      // ── STRICT WHITELIST ENFORCEMENT ──
      // Only the 13 OTC pairs are selectable. AAPL, BTC/USDT, NVDA → rejected.
      if (!isWhitelistedOtcpair(cleanSymbol)) {
        set({
          error: `Symbol ${cleanSymbol} is not on the OTC whitelist.`,
          isLoading: false,
        });
        return;
      }

      // Drop any pending recovery retry for the PREVIOUS pair — switching
      // symbols supersedes the old backoff (the new pair fetches immediately).
      clearPredictionRetry(
        predictionKey(get().activeSymbol, get().selectedTimeframe),
      );

      // ── INSTANT EVALUATION FALLBACK ──
      // Restore the last REAL evaluation for this symbol IF it was evaluated
      // under the SAME timeframe the user currently has selected. A mismatched
      // timeframe (e.g. returning to a symbol last seen under 5m while on 1m)
      // keeps predictionData null — brief blank (~1-2s) while the forced
      // refresh resolves. Zero fabrication: only genuine, timestamped snapshots
      // are restored.
      const currentTf = aiTimeframeFor(get().selectedTimeframe);
      const cachedSnap = get().predictionBySymbol[cleanSymbol];
      const restoredPrediction =
        cachedSnap && cachedSnap.timeframe === currentTf ? cachedSnap : null;

      set((state) => ({
        activeSymbol: cleanSymbol,
        predictionData: restoredPrediction,
        currentPrice: 0,
        lastPriceUpdate: null,
        error: null,
        quoteStreamWaiting: false,
        _priceVersion: state._priceVersion + 1,
      }));

      // ── RE-AIM THE SELF-DRIVING PROJECTOR ──
      // The aggregator's leading-projection loop now drives the newly selected
      // pair — forwards-looking target keeps drifting between ticks.
      aggregator.setActiveSymbol(cleanSymbol);

      // ── INSTANT CHART PERSISTENCE ON SYMBOL SWITCH ──
      // Hydrate realtimeCandles for the incoming symbol from the aggregator
      // BEFORE the /predict round-trip resolves. The aggregator retains every
      // ingested tick per symbol, so revisiting a pair (or switching while
      // its stream is warm) renders the full live candle series immediately —
      // the chart never blanks, never shows a white/spinner state. The
      // subsequent /predict response seeds deeper backend history on top.
      // Invalidate any near-identical live signature so switching symbols
      // forces a fresh React render of the incoming pair's series.
      liveSignatures.delete(cleanSymbol);
      set((s) => ({
        realtimeCandles: {
          ...s.realtimeCandles,
          [cleanSymbol]: aggregator.getSeries(cleanSymbol),
        },
      }));

      const cachedHistory = get().candlesCache[cleanSymbol];
      if (Array.isArray(cachedHistory) && cachedHistory.length > 0) {
        get().seedAggregatorHistory(cleanSymbol, cachedHistory);
      }

      get().getPrediction(
        cleanSymbol,
        get().selectedTimeframe,
        undefined,
        true,
      );
    },

    // ── HYDRATION-SAFE PERSISTED TIMEFRAME RESTORE ──
    // Called from a mount effect (NEVER during render). Delegates to
    // setSelectedTimeframe so localStorage persistence, aggregator
    // re-bucketing and the prediction refetch stay on ONE code path.
    hydrateSelectedTimeframe: () => {
      const persisted = getPersistedTimeframe();
      if (persisted !== get().selectedTimeframe) {
        get().setSelectedTimeframe(persisted);
      }
      // Single post-mount hydration entry also restores the persisted lead
      // offset (both parents call this once in a mount effect) — the chart's
      // future-facing grid re-projects ahead of the external feed on load.
      get().hydrateLeadOffset();
    },

    setSelectedTimeframe: (timeframe: string) => {
      const canonical = normalizeTimeframe(timeframe);
      if (!canonical) return;

      // Switching timeframe supersedes any recovery retry queued for the
      // previous (symbol, timeframe) combination. The retry/dedupe keys ride
      // the coerced AI channel (aiTimeframeFor) — a stale retry for the raw
      // sub-minute key would never be cancelled and would re-storm /predict.
      clearPredictionRetry(
        predictionKey(
          get().activeSymbol,
          aiTimeframeFor(get().selectedTimeframe),
        ),
      );

      try {
        localStorage.setItem(LS_TIMEFRAME_KEY, canonical);
      } catch {
        // localStorage may be unavailable
      }

      const tfSeconds = TIMEFRAME_MS[canonical] / 1000;

      set((state) => ({
        selectedTimeframe: canonical,
        selectedTimeframeSeconds: tfSeconds,
        predictionData: null,
        quoteStreamWaiting: false,
        _priceVersion: state._priceVersion + 1,
      }));

      // ── SYNC AGGREGATOR TIMEFRAME ──
      // Re-bucket the retained real ticks immediately so the chart never
      // blanks and never shows stale bucket widths.
      aggregator.setTimeframe(canonical);
      const norm = (get().activeSymbol || "").trim().toUpperCase();
      set((s) => ({
        realtimeCandles: {
          ...s.realtimeCandles,
          [norm]: aggregator.getSeries(norm),
        },
      }));

      const currentSymbol = get().activeSymbol;
      if (currentSymbol) {
        const cachedHistory = get().candlesCache[currentSymbol.toUpperCase()];
        if (Array.isArray(cachedHistory) && cachedHistory.length > 0) {
          get().seedAggregatorHistory(
            currentSymbol.toUpperCase(),
            cachedHistory,
          );
        }
        get().getPrediction(currentSymbol, canonical, undefined, true);
      }
    },

    getPrediction: async (
      symbol: string,
      timeframe?: string,
      signal?: AbortSignal,
      force?: boolean,
    ) => {
      const effectiveTf = timeframe || get().selectedTimeframe || "1d";
      // Sub-minute chart grids (20s/1s/100ms/20ms) are coerced to their nearest
      // supported AI thermal channel ("1m") — see aiTimeframeFor. The chart's
      // own aggregation stays on the intra-bucket grid; only the /predict
      // request (and its dedupe/retry keys) ride the 1m channel so the quant
      // engine evaluates real data instead of rejecting with a fatal 422.
      const aiTf = aiTimeframeFor(effectiveTf);
      const key = predictionKey(symbol, aiTf);

      // ── REQUEST COALESCING (kills the /predict storm) ──
      // 1) Identity dedup: at most ONE network fetch per (symbol, timeframe).
      //    Duplicate callers — mount effects, symbol/timeframe selectors,
      //    candle-close dispatch — share the same in-flight promise instead of
      //    opening more sockets (fixes ERR_INSUFFICIENT_RESOURCES).
      // 2) Debounce: if a fetch for this key began within the last 5s, skip.
      //    Combined with #1 this caps /predict at ~1 request / 5s per key.
      //    `force` (user-initiated actions) bypasses the time debounce while
      //    still coalescing in-flight identity (no duplicate concurrent fetches).
      const inflight = predictionInFlight.get(key);
      if (inflight) return inflight;

      if (typeof window !== "undefined" && !force) {
        const lastAt = lastPredictionStartedAt.get(key) ?? 0;
        if (Date.now() - lastAt < PREDICT_MIN_INTERVAL_MS) {
          if (signal?.aborted) return;
          // Do not leave a stale loading spinner behind when we intentionally
          // skip a call; but never clobber a DIFFERENT key's in-flight state.
          if (predictionInFlight.size === 0) {
            set({ isLoading: false });
          }
          return;
        }
      }

      lastPredictionStartedAt.set(key, Date.now());
      const requestId = get()._lastRequestId + 1;
      // A fresh attempt — whether user-triggered or a recovery retry —
      // cancels any pending timer. The attempt COUNTER is intentionally kept
      // so a consecutive failure batch keeps doubling its backoff (1→2→4→8s);
      // it resets on success, hard error, or symbol/timeframe switch.
      clearPredictionRetryTimer(key);
      set({
        isLoading: true,
        error: null,
        quoteStreamWaiting: false,
        _lastRequestId: requestId,
      });

      const run: Promise<void> = (async () => {
        try {
          const data = await apiClient.getPrediction(symbol, aiTf, signal);

          if (get()._lastRequestId !== requestId) return;

          // ── Strict per-symbol caching ──
          // The raw candle array is stored ONLY under the normalized symbol that
          // fetched it. Different pairs (EUR/USD, GBP/USD, AUD/CAD...) each get
          // their own unique key, so one pair's candles NEVER bleed into another.
          const normSymbol = (data.symbol || symbol || "").trim().toUpperCase();
          const candles = Array.isArray(data.candles) ? data.candles : [];

          const normalizedCandles = candles.filter((bar) => {
            const values = Number(bar?.close);
            return Number.isFinite(values) && values > 0;
          });

          // ════════════════════════════════════════════════════════════════
          // AUTHORITATIVE SIGNAL PASSTHROUGH — ZERO DIRECTION MUTATION.
          // The backend's unbiased engine ALWAYS resolves a directional
          // verdict: BUY | SELL (never HOLD). Sub-thermal confluence is
          // signalled via market_waiting instead of hiding the direction.
          // ════════════════════════════════════════════════════════════════
          const rawConfidence = Number(data.confidence) || 0;
          const authoritativeSignal = data.signal;

          const liveSignal: SignalData = {
            id: nextLiveSignalId("pred"),
            symbol: data.symbol,
            signalType: authoritativeSignal,
            price: data.current_price,
            confidence: rawConfidence / 100,
            createdAt: data.timestamp,
            timestamp: data.timestamp,
            stop_loss: 0,
            take_profit: data.target_price,
          };

          const signalEmittedAt = (() => {
            const rawNum = Number(data.timestamp);
            if (Number.isFinite(rawNum) && rawNum > 0) {
              return rawNum < 1_000_000_000_000 ? rawNum * 1000 : rawNum;
            }
            const parsed = new Date(String(data.timestamp ?? "")).getTime();
            return Number.isFinite(parsed) ? parsed : Date.now();
          })();

          tradingAccuracyVerifier.recordSignal({
            id: `pred@${key}@${requestId}`,
            symbol: normSymbol,
            timeframe: aiTf,
            direction: authoritativeSignal,
            confidence: rawConfidence,
            entryPrice: Number(data.current_price) > 0 ? data.current_price : 0,
            targetPrice: Number(data.target_price) > 0 ? data.target_price : 0,
            emittedAt: signalEmittedAt,
            horizonMs: TIMEFRAME_MS[aiTf] ?? 60_000,
            source: "ai_engine",
          });

          const verificationSnapshot = tradingAccuracyVerifier.snapshot();

          const normalizedPrediction = {
            ...data,
            signal: authoritativeSignal,
            high_confidence_alert:
              typeof data.high_confidence_alert === "boolean"
                ? data.high_confidence_alert
                : rawConfidence > 70,
            confidence_gated:
              (data.confidence_gated ??
                data.dispatch?.confidence_gated ??
                data.diagnostics?.confidence_gated ??
                false) ||
              verificationSnapshot.blocking,
            // ── MARKET-WAITING CONTRACT (dynamic floor, passthrough) ──
            market_waiting:
              typeof data.market_waiting === "boolean"
                ? data.market_waiting
                : false,
            waiting_reason:
              typeof data.waiting_reason === "string"
                ? data.waiting_reason
                : null,
            waiting_detail:
              typeof data.waiting_detail === "string"
                ? data.waiting_detail
                : null,
            book_confluence:
              data.book_confluence ?? data.diagnostics?.book ?? {},
            verification: {
              samples: verificationSnapshot.samples,
              correct: verificationSnapshot.correct,
              wrong: verificationSnapshot.wrong,
              errorRate: verificationSnapshot.errorRate,
              accuracyPct: verificationSnapshot.accuracyPct,
              validated: verificationSnapshot.validated,
              blocking: verificationSnapshot.blocking,
              targetReachedPct: verificationSnapshot.targetReachedPct,
              projectedMeanAbsErrorPct:
                verificationSnapshot.projectedMeanAbsErrorPct,
              barsObserved: verificationSnapshot.barsObserved,
              errorLimit: ERROR_RATE_LIMIT,
            },
          } satisfies PredictionResponse;

          set((state) => ({
            predictionData: normalizedPrediction,
            predictionBySymbol: {
              ...state.predictionBySymbol,
              [normSymbol]: normalizedPrediction,
            },
            candlesCache: {
              ...state.candlesCache,
              [normSymbol]: normalizedCandles,
            },
            // ── UNIFIED REAL-TIME PRICE SOURCE ──
            // The LIVE WebSocket tick stream is the single authoritative source
            // for `currentPrice`. A /predict HTTP response's `current_price` is
            // ALWAYS behind the live wire (WebSocket ticks are ~1s). Stamping it
            // here would REGRESS the trading-panel ticker + chart to an older
            // price on every prediction (especially on timeframe change, which
            // triggers a fresh /predict). So we only seed `currentPrice` from
            // the AI response when NO live tick has been observed yet.
            currentPrice:
              state.currentPrice > 0 ? state.currentPrice : data.current_price,
            lastPriceUpdate:
              state.currentPrice > 0 ? state.lastPriceUpdate : data.timestamp,
            isLoading: false,
            quoteStreamWaiting: false,
            liveSignals: [liveSignal, ...state.liveSignals].slice(0, 100),
            _priceVersion: state._priceVersion + 1,
          }));

          // Recovery confirmed — clear the retry backoff bookkeeping.
          clearPredictionRetry(key);

          if (normalizedCandles.length >= 2) {
            get().seedAggregatorHistory(normSymbol, normalizedCandles);
          }

          // ── AUTONOMOUS FIRST-FRAME PRIMING ──
          // A pair whose live tick stream has not delivered its first frame
          // yet (fresh selection, cold WebSocket room) previously stayed IDLE
          // with a blank chart until a tick landed. The backend's REAL observed
          // `current_price` — a genuine market print, never fabricated — primes
          // the aggregator so the exact-boundary SYNTHETIC bar opens the moment
          // this response resolves, decoupled from passive tick-waiting. The
          // first real live tick overwrites it in place. No-op when a real tick
          // reference already exists.
          if (Number.isFinite(data.current_price) && data.current_price > 0) {
            get().seedAggregatorPrice(normSymbol, data.current_price);
          }
        } catch (err: unknown) {
          if (get()._lastRequestId !== requestId) return;

          // ── GRACEFUL ERROR HANDLING — NO CONSOLE SPAM ──
          // Aborted requests (polling race on symbol/timeframe switch) are
          // expected control flow: clear loading silently, never surface an
          // error or log a stack trace.
          if (
            err instanceof DOMException &&
            (err.name === "AbortError" || err.name === "TimeoutError")
          ) {
            set({ isLoading: false });
            return;
          }
          if (
            axios.isCancel(err) ||
            ((err as { code?: string })?.code ?? "") === "ERR_CANCELED"
          ) {
            set({ isLoading: false });
            return;
          }

          // ── RECOVERABLE FAILURES (503 / live-quote timeout / network) ──
          // HTTP 503 Service Unavailable and >15s live-quote timeouts are
          // TRANSIENT, not application errors. Keep the last good prediction
          // on screen, flip a calm waiting banner, and re-poll with
          // exponential backoff so signal generation resumes automatically
          // the moment the quote stream / backend recovers. Note: `err` is a
          // request-level AbortError on timeout only when WE aborted; axios
          // timeouts surface as ECONNABORTED and are classified recoverable.
          const recoverable =
            (err as PredictionError | null)?.recoverable === true ||
            (axios.isAxiosError(err) && err.code === "ECONNABORTED");
          if (recoverable) {
            set({ isLoading: false, quoteStreamWaiting: true, error: null });
            schedulePredictionRetry(key);
            return;
          }

          let message = "Failed to fetch prediction. Please retry.";
          if (err && typeof err === "object" && "response" in err) {
            const axiosErr = err as {
              response?: { data?: { message?: string; error?: string } };
            };
            if (axiosErr.response?.data?.message) {
              message = axiosErr.response.data.message;
            } else if (axiosErr.response?.data?.error) {
              message = axiosErr.response.data.error;
            }
          } else if (err instanceof Error) {
            message = err.message;
          }

          // Single concise warning — no stack traces, no repeated spam.
          console.warn("[store] Prediction unavailable:", message);
          set({ error: message, isLoading: false, quoteStreamWaiting: false });
          clearPredictionRetry(key);
        } finally {
          predictionInFlight.delete(key);
        }
      })();

      predictionInFlight.set(key, run);
      return run;
    },

    fetchSymbols: async () => {
      try {
        const res = await apiClient.getSymbols();
        const fromServer = res.symbols || [];
        if (fromServer.length > 0) {
          set({ symbolsList: fromServer });
          return;
        }
      } catch (error) {
        console.error("Failed to load symbols", error);
      }
      // STRICT OTC FALLBACK — never allow stock/crypto to leak in
      set((state) => {
        if (state.symbolsList.length > 0) return {};
        return {
          symbolsList: OTC_FOREX_PAIRS.map((p) => ({
            symbol: p.symbol,
            name: p.name,
            type: "otc" as const,
            exchange: "OTC_LIVE_FOREX",
            currency: p.symbol.split("/")[1] ?? "USD",
            payout: p.payout,
            label: p.label,
            digits: p.digits,
          })),
        };
      });
    },

    addLiveSignal: (signal: SignalData) => {
      // ═══ SSOT ENFORCEMENT ═══ — NEVER overwrite currentPrice from a signal
      // payload; only ingestLiveTick may write the authoritative price.
      set((state) => ({
        liveSignals: [signal, ...state.liveSignals].slice(0, 100),
      }));
    },

    setLiveSignals: (signals: SignalData[]) => {
      set({ liveSignals: signals.slice(0, 100) });
    },

    clearError: () => set({ error: null }),

    flushPriceCache: () => {
      set((state) => ({
        predictionData: null,
        predictionBySymbol: {},
        currentPrice: 0,
        lastPriceUpdate: null,
        liveSignals: [],
        error: null,
        _priceVersion: state._priceVersion + 1,
      }));
    },

    // ── Pocket Option Trading Actions ──

    setExpirationSeconds: (seconds: number) => {
      const snapped = snapToNearestExpiration(seconds);
      // TRADE-ONLY PROPERTY: the expiration duration is a pure execution
      // parameter (position sizing / countdown / PO expiry). It NEVER touches
      // the chart timeframe, aggregator buckets or prediction channel — chart
      // timeframe and trade expiry are fully decoupled (Alpha.5 Pro).
      set({ expirationSeconds: snapped });
    },

    setSelectedExpirationSeconds: (seconds: number) => {
      const snapped = snapToNearestExpiration(seconds);
      // EXPIRATION-ONLY PROPERTY: this drives ONLY the target-candle count and
      // target-price horizon on the chart — it NEVER changes the candle build
      // bucket (`selectedTimeframe`) or the trade execution expiry.
      set({ selectedExpirationSeconds: snapped });
    },

    executeTrade: async (direction: "CALL" | "PUT") => {
      const {
        activeSymbol,
        expirationSeconds,
        currentPrice,
        lastPriceUpdate,
        predictionData,
      } = get();
      if (!activeSymbol || currentPrice <= 0) {
        set({
          lastTradeResult: "No active price data. Wait for market update.",
        });
        return;
      }

      // ── ZERO-DEMO FRESHNESS GATE ──
      // A BUY/SELL signal may ONLY be executed against a genuinely fresh live
      // quote. `lastPriceUpdate` is stamped at the LOCAL receive clock when a
      // real WebSocket tick lands. If the tape has been silent for longer than
      // the 2-second live-tick tolerance, we REFUSE to dispatch — no signal is
      // ever fired on a price we can no longer confirm is live. This guards
      // the execution boundary even if the UI button state were bypassed.
      const LIVE_TRADE_MAX_AGE_MS = 2_500;
      const parsedLast = lastPriceUpdate
        ? new Date(lastPriceUpdate).getTime()
        : NaN;
      const priceAgeMs = Number.isFinite(parsedLast)
        ? Date.now() - parsedLast
        : Number.POSITIVE_INFINITY;
      if (priceAgeMs > LIVE_TRADE_MAX_AGE_MS) {
        set({
          lastTradeResult:
            "Connecting / Waiting for Real-time Tick — no fresh live quote. Signal execution paused.",
        });
        return;
      }

      // ════════════════════════════════════════════════════════════════════
      // ⛔ STRICT ENGINE-DISPATCH CONFIDENCE GATE (defense-in-depth at the
      // client boundary). The backend authoritatively refuses BUY/SELL below
      // the strict 96.5% floor. This guard mirrors it so an ENGINE-VERIFIED
      // directional signal that somehow carries a sub-96.5% score can never be
      // dispatched — even if a restored snapshot or WS race delivered it.
      // Manual button clicks WITHOUT a matching directional engine signal
      // (predictionData null) stay free — user override, not engine.
      // ════════════════════════════════════════════════════════════════════
      const STRICT_TRADE_CONFIDENCE_MIN = 96.5;
      const engineDirection = direction === "CALL" ? "BUY" : "SELL";
      const engineBacked =
        predictionData?.signal === engineDirection &&
        Number.isFinite(predictionData?.confidence);
      const ENGINE_SIGNAL_MAX_AGE_MS = 15_000;
      const sigTsNum = Number(predictionData?.timestamp);
      const sigTsParsed = Number.isFinite(sigTsNum)
        ? sigTsNum < 1_000_000_000_000 && sigTsNum > 0
          ? sigTsNum * 1000
          : sigTsNum
        : new Date(String(predictionData?.timestamp ?? "")).getTime();
      const sigAge =
        Number.isFinite(sigTsParsed) && sigTsParsed > 0
          ? Date.now() - sigTsParsed
          : 0;
      if (
        engineBacked &&
        sigTsParsed > 0 &&
        sigAge > ENGINE_SIGNAL_MAX_AGE_MS
      ) {
        set({
          lastTradeResult: `Engine signal is ${Math.round(sigAge / 1000)}s old — execution paused until the next live quant dispatch refreshes it.`,
        });
        return;
      }
      if (
        engineBacked &&
        (predictionData?.confidence ?? 0) < STRICT_TRADE_CONFIDENCE_MIN
      ) {
        set({
          lastTradeResult: `⛔ Engine signal ${engineDirection} @ ${(predictionData?.confidence ?? 0).toFixed(1)}% confidence — below the strict 96.5% dispatch floor. Signal execution refused.`,
        });
        return;
      }
      const accuracySnapshot = tradingAccuracyVerifier.snapshot();
      if (engineBacked && accuracySnapshot.blocking) {
        set({
          lastTradeResult: `⛔ ${accuracySnapshot.reason ?? `Statistical accuracy gate: ${(accuracySnapshot.errorRate * 100).toFixed(1)}% realized signal error — execution paused until the real-tape accuracy recovers below ${(ERROR_RATE_LIMIT * 100).toFixed(1)}%.`}`,
        });
        return;
      }

      // ════════════════════════════════════════════════════════════════════
      // ⛔ CLIENT-SIDE KILL-SWITCH PRE-CHECK — evaluate daily drawdown BEFORE
      // dispatching. The backend enforces authoritatively; this check gives
      // instant feedback and avoids a doomed network round-trip.
      // ════════════════════════════════════════════════════════════════════
      try {
        const snapshot = await apiClient.getRiskState();
        set({
          riskState: snapshot,
          isKillSwitchLocked: snapshot.killSwitchLocked,
          killSwitchReason: snapshot.lockedReason,
        });
        if (snapshot.killSwitchLocked) {
          set({
            lastTradeResult: `⛔ ${snapshot.lockedReason ?? "Kill switch engaged — trading locked."}`,
          });
          return;
        }
      } catch (err) {
        console.warn(
          "[store] Risk-state pre-check unavailable, backend will enforce:",
          err,
        );
      }

      // ════════════════════════════════════════════════════════════════════
      // RISK RULE ENFORCEMENT — fetch live risk rules from backend
      // If any enabled rule is violated, block the trade and surface the
      // violation via lastTradeResult. No silent bypass.
      // ════════════════════════════════════════════════════════════════════
      try {
        const riskRules = await apiClient.getRiskRules();
        const enabledRules = riskRules.rules.filter((r) => r.enabled);
        const violations: string[] = [];

        for (const rule of enabledRules) {
          switch (rule.ruleType) {
            case "max_drawdown": {
              // Max drawdown: if prediction delta exceeds max drawdown %, block
              const deltaPct = predictionData?.delta_pct ?? 0;
              if (Math.abs(deltaPct) > rule.value) {
                violations.push(
                  `Max Drawdown (${rule.value}%) exceeded by ${Math.abs(deltaPct).toFixed(1)}% delta`,
                );
              }
              break;
            }
            case "stop_loss": {
              // Stop-loss: if current price movement exceeds threshold %, block
              // GENUINE backend ATR only — the `currentPrice * 0.005` proxy is
              // PURGED. With no real ATR, volatility honestly evaluates to 0.
              const atr = predictionData?.atr ?? 0;
              const volatilityPct =
                currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
              if (volatilityPct > rule.value) {
                violations.push(
                  `Stop-Loss Threshold (${rule.value}%) exceeded by ${volatilityPct.toFixed(2)}% volatility`,
                );
              }
              break;
            }
            case "position_size": {
              // Position size: if expiration / predicted volatility exceeds limit
              const maxExpirationSeconds = rule.value * 60; // convert minutes to seconds
              if (expirationSeconds > maxExpirationSeconds) {
                violations.push(
                  `Position Size Limit: expiration ${Math.floor(expirationSeconds / 60)}m exceeds max ${rule.value}m`,
                );
              }
              break;
            }
            case "max_leverage": {
              // Max leverage: if confidence-weighted delta exceeds leverage limit
              // GENUINE backend confidence only — the `?? 50` fabricated
              // baseline is PURGED. No confidence → 0 effective leverage.
              const confidence = predictionData?.confidence ?? 0;
              const effectiveLeverage = confidence / 10; // rough proxy
              if (effectiveLeverage > rule.value) {
                violations.push(
                  `Max Leverage (${rule.value}x) exceeded by ${effectiveLeverage.toFixed(1)}x effective`,
                );
              }
              break;
            }
            default:
              break;
          }
        }

        if (violations.length > 0) {
          set({
            lastTradeResult: `⛔ Risk rule violation: ${violations[0]}`,
          });
          return;
        }
      } catch (err) {
        // Risk rule fetch failure — log warning but PROCEED with trade
        // (network failure shouldn't freeze trading; rules are advisory)
        console.warn(
          "[store] Risk rule fetch failed, proceeding without enforcement:",
          err,
        );
      }

      set({ isTradeActive: true, countdownSeconds: expirationSeconds });

      const countdownInterval = setInterval(() => {
        const remaining = get().countdownSeconds;
        if (remaining <= 1) {
          clearInterval(countdownInterval);
          set({ countdownSeconds: 0, isTradeActive: false });
        } else {
          set({ countdownSeconds: remaining - 1 });
        }
      }, 1000);

      try {
        const trade = await apiClient.executeTrade({
          symbol: activeSymbol,
          direction,
          investment: 0, // Signal-only mode — no investment amount
          expiration: expirationSeconds,
        });

        set((state) => ({
          tradeHistory: [trade, ...state.tradeHistory].slice(0, 50),
          lastTradeResult: `${direction} signal on ${activeSymbol} — ${trade.status}`,
        }));
      } catch (err: unknown) {
        clearInterval(countdownInterval);

        // ── HTTP 423 = backend kill switch engaged mid-flight ──
        if (
          err &&
          typeof err === "object" &&
          "response" in err &&
          (err as { response?: { status?: number } }).response?.status === 423
        ) {
          const data = (
            err as {
              response?: {
                data?: {
                  message?: string;
                  riskState?: Partial<RiskStateSnapshot>;
                };
              };
            }
          ).response?.data;
          if (data?.riskState) {
            set((s) => ({
              riskState: s.riskState
                ? { ...s.riskState, ...data.riskState, killSwitchLocked: true }
                : s.riskState,
              isKillSwitchLocked: true,
              killSwitchReason:
                data.message ?? "Daily drawdown limit breached.",
            }));
          } else {
            set({
              isKillSwitchLocked: true,
              killSwitchReason:
                data?.message ?? "Daily drawdown limit breached.",
            });
          }
          set({
            isTradeActive: false,
            countdownSeconds: 0,
            lastTradeResult: `⛔ ${data?.message ?? "Kill switch engaged — trading locked."}`,
          });
          return;
        }

        const message =
          err instanceof Error ? err.message : "Trade execution failed";
        set({
          isTradeActive: false,
          countdownSeconds: 0,
          lastTradeResult: `❌ ${message}`,
        });
      }
    },

    clearTradeResult: () => {
      set({ lastTradeResult: null });
    },

    applyLiveSignal: (payload) => {
      const rawDir = String(
        payload?.signalType ??
          payload?.signal_type ??
          payload?.signal ??
          payload?.direction ??
          "",
      )
        .trim()
        .toUpperCase();
      const direction = ["BUY", "SELL"].includes(rawDir)
        ? (rawDir as "BUY" | "SELL")
        : null;
      const wsSymbol = String(payload?.symbol ?? "")
        .trim()
        .toUpperCase();
      const { activeSymbol } = get();
      const normActive = (activeSymbol || "").toUpperCase();
      const waitingOnly =
        direction === null && payload?.market_waiting === true;
      if (direction === null && !waitingOnly) return;

      // Backend WS signals (`new_signal` / `symbol_update`) carry the keys
      // `direction`, `entry_price`, `confidence_score`, `take_profit`; the
      // /predict payload uses `signal`, `price`, `confidence`, `target_price`.
      const price = Number(
        payload?.price ?? payload?.entry_price ?? payload?.current_price,
      );
      const target = Number(
        payload?.targetPrice >= 0
          ? payload?.targetPrice
          : (payload?.target_price ?? payload?.take_profit),
      );
      // WS signal confidence is on the 0..1 scale (subscriber normalizes);
      // predictionData.confidence is 0..100 — rescale so the panel badge and
      // the risk pre-check read the same magnitude as /predict.
      const rawConf = Number(payload?.confidence ?? payload?.confidence_score);
      const conf100 =
        Number.isFinite(rawConf) && rawConf >= 0
          ? rawConf > 1
            ? rawConf
            : rawConf * 100
          : 0;

      const hasPrice = Number.isFinite(price) && price > 0;
      const ts = payload?.timestamp ?? new Date().toISOString();

      if (direction && hasPrice) {
        const wsSignalTf = aiTimeframeFor(
          String(get().selectedTimeframe ?? "M1"),
        );
        const wsEmittedAt = (() => {
          const rawNum = Number(payload?.timestamp ?? 0);
          if (Number.isFinite(rawNum) && rawNum > 0) {
            return rawNum < 1_000_000_000_000 ? rawNum * 1000 : rawNum;
          }
          const parsed = new Date(String(payload?.timestamp ?? "")).getTime();
          return Number.isFinite(parsed) ? parsed : Date.now();
        })();
        tradingAccuracyVerifier.recordSignal({
          id: `ws@${nextLiveSignalId("verify")}`,
          symbol: wsSymbol || normActive,
          timeframe: wsSignalTf,
          direction,
          confidence: conf100,
          entryPrice: price,
          targetPrice: Number.isFinite(target) && target > 0 ? target : 0,
          emittedAt: wsEmittedAt,
          horizonMs: TIMEFRAME_MS[wsSignalTf] ?? 60_000,
          source: "quant_ws",
        });
      }

      // ── LIVE SIGNAL → ACTIVE PANEL + BUTTONS ──
      // Update predictionData so the badge/direction and the ACHAT/VENTE rings
      // track the engine's freshest dispatch. Guarded to the active symbol if
      // one is reported; never locks out manual trading (buttons stay enabled).
      const shouldApply = !wsSymbol || wsSymbol === normActive || !normActive;
      // Cache the merged snapshot under the ACTIVE symbol key so switching
      // back to this pair instantly restores the freshest WS evaluation.
      const snapshotKey = shouldApply ? normActive : "";

      set((s) => {
        // Waiting-only rider: no direction is fabricated — keep the last real
        // directional verdict and only flip the market-waiting banner.
        if (waitingOnly) {
          const merged = s.predictionData
            ? {
                ...s.predictionData,
                market_waiting: true,
                waiting_reason: payload?.waiting_reason ?? null,
                waiting_detail: payload?.waiting_detail ?? null,
                timestamp: ts,
              }
            : null;
          return {
            ...(shouldApply && merged ? { predictionData: merged } : {}),
            ...(snapshotKey && merged
              ? {
                  predictionBySymbol: {
                    ...s.predictionBySymbol,
                    [snapshotKey]: merged,
                  },
                }
              : {}),
          };
        }

        let mergedPrediction = s.predictionData;
        if (shouldApply) {
          mergedPrediction = s.predictionData
            ? {
                ...s.predictionData,
                signal: direction,
                confidence: conf100,
                current_price: hasPrice
                  ? price
                  : s.predictionData.current_price,
                target_price:
                  Number.isFinite(target) && target > 0
                    ? target
                    : s.predictionData.target_price,
                timestamp: ts,
              }
            : {
                symbol: wsSymbol || normActive || "",
                signal: direction,
                confidence: conf100,
                current_price: hasPrice ? price : 0,
                target_price:
                  Number.isFinite(target) && target > 0 ? target : 0,
                ml_probability: 0,
                model_accuracy: 0,
                timeframe: s.selectedTimeframe || "1d",
                proxyLatencyMs: null,
                indicators: { rsi_14: 0, sma_20: 0, sma_50: 0 },
                timestamp: ts,
              };
        }
        return {
          ...(shouldApply ? { predictionData: mergedPrediction } : {}),
          ...(snapshotKey
            ? {
                predictionBySymbol: {
                  ...s.predictionBySymbol,
                  [snapshotKey]: mergedPrediction,
                },
              }
            : {}),
          ...(hasPrice && s.currentPrice <= 0
            ? { currentPrice: price, lastPriceUpdate: ts }
            : {}),
          liveSignals: [
            {
              // Monotonic-counter suffix guarantees uniqueness per session even
              // when multiple WS events land in the same millisecond (the old
              // `live-${Date.now()}` produced duplicate React keys).
              id: nextLiveSignalId("live"),
              symbol: wsSymbol || normActive,
              signalType: direction,
              price: hasPrice ? price : undefined,
              confidence: conf100 / 100,
              createdAt: ts,
              timestamp: ts,
              stop_loss: 0,
              take_profit:
                Number.isFinite(target) && target > 0 ? target : undefined,
            },
            ...s.liveSignals,
          ].slice(0, 100),
        };
      });
    },

    ingestQuantDispatch: (payload) => {
      get().applyLiveSignal(payload);
      const rawSymbol = String(payload?.symbol ?? "")
        .trim()
        .toUpperCase();
      const normActive = (get().activeSymbol || "").toUpperCase();
      const wsSymbol = rawSymbol || normActive;
      const price = Number(
        payload?.price ??
          payload?.entry_price ??
          payload?.current_price ??
          payload?.tick ??
          Number.NaN,
      );
      if (!Number.isFinite(price) || price <= 0) return;
      let timestamp = 0;
      const rawTs: unknown = payload?.timestamp;
      if (typeof rawTs === "number") {
        timestamp = Number(rawTs);
        if (timestamp < 1e12) timestamp *= 1000;
      } else if (typeof rawTs === "string") {
        const parsed = new Date(rawTs).getTime();
        if (Number.isFinite(parsed)) timestamp = parsed;
      }
      if (!Number.isFinite(timestamp) || timestamp <= 0) timestamp = Date.now();
      const normSignal = (wsSymbol || "").trim().toUpperCase();
      if (normSignal && normActive && normSignal === normActive) {
        get().ingestLiveTick({ symbol: normSignal, price, timestamp });
        liveSignatures.delete(normSignal);
        lastRealtimePublish.delete(normSignal);
        lastPublishedBucket.delete(normSignal);
        const series = aggregator.getSeries(normSignal);
        set((s) => ({
          realtimeCandles: {
            ...s.realtimeCandles,
            [normSignal]: series,
          },
          lastPriceUpdate: new Date().toISOString(),
          ...(s.currentPrice <= 0 ? { currentPrice: price } : {}),
          lastQuantDispatch: {
            symbol: wsSymbol,
            price,
            timestamp,
            receivedAt: Date.now(),
          },
        }));
      } else {
        set({
          lastQuantDispatch: {
            symbol: wsSymbol,
            price,
            timestamp,
            receivedAt: Date.now(),
          },
        });
      }
    },

    // ── Real-time aggregator actions ──

    /**
     * Fold a live WebSocket tick into the shared aggregator. The aggregator
     * updates the in-progress OHLCV candle and fires onCandleClose on bucket
     * rollover, which triggers the async /predict dispatch.
     */
    ingestLiveTick: (rawTick: unknown) => {
      const state = get();
      const norm = (state.activeSymbol || "").trim().toUpperCase();
      const rawSymbol = (rawTick as { symbol?: string })?.symbol;
      if (!rawSymbol) return; // reject untagged ticks — must not mutate active symbol
      const tickSymbol = rawSymbol.trim().toUpperCase();

      // Only update the store when the tick belongs to the active symbol.
      if (tickSymbol && norm && tickSymbol !== norm) return;

      const candle = aggregator.ingest(rawTick);
      if (!candle) return;
      set({ feedStatus: "live" });
    },

    setFeedStatus: (status) => set({ feedStatus: status }),

    /**
     * Switch the aggregator timeframe — re-buckets retained real ticks
     * immediately so the chart never blanks.
     */
    setAggregatorTimeframe: (timeframe: string) => {
      if (!isTimeframe(timeframe)) return;
      aggregator.setTimeframe(timeframe as Timeframe);
      const state = get();
      const norm = (state.activeSymbol || "").trim().toUpperCase();
      // Invalidate the live-signature so the next tick definitely re-renders.
      liveSignatures.delete(norm);
      set((s) => ({
        realtimeCandles: {
          ...s.realtimeCandles,
          [norm]: aggregator.getSeries(norm),
        },
        _priceVersion: s._priceVersion + 1,
      }));
    },

    /**
     * Configure the PREDICTIVE LEAD-TIME OFFSET — wall-clock milliseconds the
     * forming candle is projected AHEAD of the external feed (e.g. 20s / 1m).
     * NULL restores the aggregator default: lead 0 = EXACT PO parity grid
     * (`floor(ts / interval) * interval`, byte-identical to the backend).
     * Persisted to localStorage; the retained ticks are re-bucketed onto the
     * new lead grid immediately so the chart re-projects with zero seams.
     */
    setLeadOffset: (offsetMs: number | null) => {
      const next =
        offsetMs == null
          ? null
          : Number.isFinite(offsetMs) && offsetMs >= 0
            ? offsetMs
            : null;
      if (next === get().selectedLeadOffsetMs) return;
      try {
        if (next == null) {
          localStorage.removeItem(LS_LEAD_OFFSET_KEY);
        } else {
          localStorage.setItem(LS_LEAD_OFFSET_KEY, String(next));
        }
      } catch {
        // localStorage may be unavailable
      }
      // React FIRST — state is the source of truth for the selector UI — then
      // re-project every symbol onto the new lead grid (per-symbol re-bucket).
      set((s) => ({
        selectedLeadOffsetMs: next,
        _priceVersion: s._priceVersion + 1,
      }));
      aggregator.setLeadTimeOffset(next ?? undefined);
      const norm = (get().activeSymbol || "").trim().toUpperCase();
      liveSignatures.delete(norm);
      set((s) => ({
        realtimeCandles: {
          ...s.realtimeCandles,
          [norm]: aggregator.getSeries(norm),
        },
      }));
    },

    hardResetLiveData: () => {
      try {
        aggregator.reset();
      } catch {}
      tradingAccuracyVerifier.reset();
      liveSignatures.clear();
      lastRealtimePublish.clear();
      lastPublishedBucket.clear();
      const norm = (get().activeSymbol || DEFAULT_SYMBOL).trim().toUpperCase();
      try {
        if (norm) {
          aggregator.registerSymbols([norm]);
          aggregator.setActiveSymbol(norm);
        }
      } catch {}
      set((s) => ({
        candlesCache: {},
        realtimeCandles: {},
        serverCandles: {},
        predictionData: null,
        predictionBySymbol: {},
        currentPrice: 0,
        feedStatus: "awaiting_ssid",
        lastPriceUpdate: null,
        lastQuantDispatch: null,
        quoteStreamWaiting: false,
        isLoading: false,
        error: null,
        _priceVersion: s._priceVersion + 1,
        serverCandleVersion: s.serverCandleVersion + 1,
        dataEpoch: s.dataEpoch + 1,
      }));
    },

    /**
     * Hydration-safe restore of the persisted lead offset (NULL → default).
     * Never runs during render; called once from the mount effect.
     */
    hydrateLeadOffset: () => {
      get().setLeadOffset(getPersistedLeadOffset());
    },

    /**
     * Apply a real replayed tick batch from the backend's 2000-tick ring
     * (the `history` event delivered on every subscribe / re-join) to the
     * aggregator. This backfills the chart's continuity gap between "last tick
     * before disconnect" and "first live tick after" — without triggering a
     * /predict storm (seedBatch folds the replay silently).
     */
    replayTicks: (symbol: string, ticks: unknown[]) => {
      const norm = (symbol || "").trim().toUpperCase();
      if (!norm || !Array.isArray(ticks) || ticks.length === 0) return;
      if (!aggregator.hasSymbol(norm)) return;
      const seeded = aggregator.seedBatch(norm, ticks);
      if (!seeded) return;
      // The merged series changed wholesale — invalidate the coalescer so the
      // NEXT live tick re-renders, and push the reconstructed series once.
      liveSignatures.delete(norm);
      lastRealtimePublish.delete(norm);
      lastPublishedBucket.delete(norm);
      const current = get().currentPrice;
      const replaysActive = (get().activeSymbol || "").toUpperCase() === norm;
      const seededPrice =
        seeded.live && seeded.live.close > 0 ? seeded.live.close : 0;
      set((s) => ({
        currentPrice:
          replaysActive && current <= 0 && seededPrice > 0
            ? seededPrice
            : current,
        lastPriceUpdate: new Date().toISOString(),
        _priceVersion: s._priceVersion + 1,
        realtimeCandles: {
          ...s.realtimeCandles,
          [norm]: aggregator.getSeries(norm),
        },
      }));
    },

    /**
     * Seed the aggregator with REAL historical bars from the /predict response.
     */
    seedAggregatorHistory: (symbol: string, candles: CandleDataPoint[]) => {
      const norm = (symbol || "").trim().toUpperCase();
      if (!norm || !Array.isArray(candles) || candles.length === 0) return;
      // Map API candles (optional volume) to aggregator candles (required
      // volume), normalising ISO-string / epoch-ms / epoch-seconds timestamps
      // to epoch MILLISECONDS so the seeded history lands on the SAME axis as
      // the live-tick buckets. A bar whose timestamp can't be resolved is
      // dropped (never a fabricated bucket).
      const mapped: Candle[] = [];
      const bucketMs =
        TIMEFRAME_MS[
          isTimeframe(get().selectedTimeframe) ? get().selectedTimeframe : "1m"
        ];
      for (const c of candles) {
        let ts: number;
        const rawTs = (c as unknown as { timestamp?: unknown }).timestamp;
        if (typeof rawTs === "number") {
          const finite = Number(rawTs);
          ts = finite < 1_000_000_000_000 ? finite * 1000 : finite;
        } else if (typeof rawTs === "string") {
          const parsed = new Date(rawTs).getTime();
          ts = Number.isFinite(parsed) ? parsed : Number(rawTs);
        } else {
          ts = Number(rawTs);
        }
        if (
          !Number.isFinite(ts) ||
          ts <= 0 ||
          !Number.isFinite(c.open) ||
          !Number.isFinite(c.close) ||
          c.close <= 0
        ) {
          continue;
        }
        // Align to the active bucket grid (open boundary) so the seeded bars
        // sit exactly where the live aggregator would place them — prevents
        // isolated bars straddling off-grid slots.
        const aligned = Math.floor(ts / bucketMs) * bucketMs;
        mapped.push({
          timestamp: aligned,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
        });
      }
      if (mapped.length === 0) return;
      aggregator.seedHistory(norm, mapped);
      // Invalidate the live-signature so the seeded series is rendered next.
      liveSignatures.delete(norm);
      set((s) => ({
        realtimeCandles: {
          ...s.realtimeCandles,
          [norm]: aggregator.getSeries(norm),
        },
        _priceVersion: s._priceVersion + 1,
      }));
    },

    // ── Server-authoritative closed candles ──

    /**
     * Upsert a single CLOSED candle pushed by the backend `candle` event.
     * Only `closed === true` payloads are accepted (the server owns closed
     * bars; the client aggregator paints only the forming row). Replaces any
     * prior candle at the same bucket timestamp, keeps the per-timeframe list
     * sorted, caps it at 512 rows, and bumps serverCandleVersion so the chart
     * swapKey repaints the authoritative bar.
     */
    applyServerCandle: (payload: ServerSettledCandle) => {
      if (!payload || payload.closed !== true) return;
      const symbol = (payload.symbol || "").trim().toUpperCase();
      const tf = normalizeTimeframe(payload.timeframe);
      if (!symbol || !tf) return;
      const ts = Number(payload.timestamp);
      const o = Number(payload.open);
      const h = Number(payload.high);
      const l = Number(payload.low);
      const c = Number(payload.close);
      if (
        !Number.isFinite(ts) ||
        ts <= 0 ||
        !Number.isFinite(o) ||
        !Number.isFinite(h) ||
        !Number.isFinite(l) ||
        !Number.isFinite(c) ||
        c <= 0
      ) {
        return;
      }
      const candle: Candle = {
        timestamp: ts,
        open: o,
        high: h,
        low: l,
        close: c,
        volume:
          Number.isFinite(payload.volume) && (payload.volume as number) > 0
            ? (payload.volume as number)
            : 0,
      };
      set((s) => {
        const bySym = s.serverCandles[symbol] ?? {};
        const list = bySym[tf] ?? [];
        const idx = list.findIndex((row) => row.timestamp === ts);
        const next =
          idx >= 0
            ? [...list.slice(0, idx), candle, ...list.slice(idx + 1)]
            : [...list, candle].sort((a, b) => a.timestamp - b.timestamp);
        const capped = next.slice(-512);
        return {
          serverCandles: {
            ...s.serverCandles,
            [symbol]: { ...bySym, [tf]: capped },
          },
          serverCandleVersion: s.serverCandleVersion + 1,
        };
      });
    },

    /**
     * Seed ONE timeframe's authoritative CLOSED history for a symbol from the
     * `history_candles` replay burst. The backend emits the EXACT resolution
     * requested on subscribe (`symbol` + active chart timeframe), so a chart
     * timeframe switch instantly re-seeds the selected bucket grid. Replaces
     * (rather than merges) the per-timeframe list so a stale cached series can
     * never linger ahead of the server truth. Silently ignores unknown
     * timeframes and non-finite candles.
     */
    seedServerCandles: (
      symbol: string,
      timeframe: string,
      candles: Candle[],
    ) => {
      const norm = (symbol || "").trim().toUpperCase();
      const tf = normalizeTimeframe(timeframe);
      if (!norm || !tf) return;
      if (!Array.isArray(candles) || candles.length === 0) return;

      const mapped: Candle[] = [];
      for (const r of candles) {
        if (!r) continue;
        const ts = Number(r.timestamp);
        const o = Number(r.open);
        const h = Number(r.high);
        const l = Number(r.low);
        const c = Number(r.close);
        if (
          !Number.isFinite(ts) ||
          ts <= 0 ||
          !Number.isFinite(o) ||
          !Number.isFinite(h) ||
          !Number.isFinite(l) ||
          !Number.isFinite(c) ||
          c <= 0
        ) {
          continue;
        }
        mapped.push({
          timestamp: ts,
          open: o,
          high: h,
          low: l,
          close: c,
          volume:
            Number.isFinite(r.volume) && (r.volume as number) > 0
              ? (r.volume as number)
              : 0,
        });
      }
      if (mapped.length === 0) return;
      mapped.sort((a, b) => a.timestamp - b.timestamp);

      set((s) => {
        const prev = s.serverCandles[norm] ?? {};
        return {
          serverCandles: {
            ...s.serverCandles,
            [norm]: { ...prev, [tf]: mapped.slice(-512) },
          },
          serverCandleVersion: s.serverCandleVersion + 1,
        };
      });
    },

    /**
     * PRIME the aggregator with a REAL backend-observed price (`/predict`'s
     * `current_price`) for a pair whose live tick stream has not landed yet.
     * Opens the pair's SYNTHETIC live bucket instantly (via aggregator.primePrice)
     * so a freshly selected symbol paints its first data-driven bar with zero
     * passive tick-waiting. Guarded inside the aggregator to never clobber a
     * fresher real tick reference.
     */
    seedAggregatorPrice: (symbol: string, price: number) => {
      const norm = (symbol || "").trim().toUpperCase();
      const p = Number(price);
      if (!norm || !(Number.isFinite(p) && p > 0)) return;
      aggregator.primePrice(norm, p);
      const active = (get().activeSymbol || "").trim().toUpperCase();
      if (norm && active && norm !== active) return;
      const current = get();
      const hasLiveBar =
        Array.isArray(current.realtimeCandles[norm]) &&
        current.realtimeCandles[norm].length > 0;
      liveSignatures.delete(norm);
      set((s) => ({
        ...(hasLiveBar
          ? {}
          : {
              realtimeCandles: {
                ...s.realtimeCandles,
                [norm]: aggregator.getSeries(norm),
              },
            }),
        // Seed the unified price ONLY while no real live tick is authoritative
        // yet (the live WebSocket stream remains the single source of truth).
        currentPrice: s.currentPrice > 0 ? s.currentPrice : p,
        lastPriceUpdate:
          s.currentPrice > 0 ? s.lastPriceUpdate : new Date().toISOString(),
        _priceVersion: s._priceVersion + 1,
      }));
    },

    /**
     * Read the live aggregated OHLCV series for a symbol (closed + live bar).
     */
    getRealtimeSeries: (symbol: string): Candle[] => {
      const norm = (symbol || "").trim().toUpperCase();
      return aggregator.getSeries(norm);
    },

    /**
     * Trigger explicit wall-clock sync across all symbols in the aggregator.
     */
    syncAggregatorWallClock: () => {
      aggregator.syncWallClock();
      const norm = (get().activeSymbol || "").trim().toUpperCase();
      if (norm) {
        const live = aggregator.getLiveCandle(norm);
        if (live) syncStoreCandle(live, norm);
      }
    },
  };
});

// ── INDIVIDUAL SELECTORS ──

export const selectActiveSymbol = (state: TradingState) => state.activeSymbol;
export const selectPredictionData = (state: TradingState) =>
  state.predictionData;
export const selectCurrentPrice = (state: TradingState) => state.currentPrice;
export const selectLastPriceUpdate = (state: TradingState) =>
  state.lastPriceUpdate;
export const selectIsLoading = (state: TradingState) => state.isLoading;
export const selectError = (state: TradingState) => state.error;
export const selectQuoteStreamWaiting = (state: TradingState) =>
  state.quoteStreamWaiting;
export const selectGetPrediction = (state: TradingState) => state.getPrediction;
export const selectSetActiveSymbol = (state: TradingState) =>
  state.setActiveSymbol;
export const selectLiveSignals = (state: TradingState) => state.liveSignals;
export const selectPriceVersion = (state: TradingState) => state._priceVersion;
export const selectSelectedTimeframe = (state: TradingState) =>
  state.selectedTimeframe;
export const selectSelectedExpiration = (state: TradingState) =>
  state.selectedExpirationSeconds;
export const selectSetSelectedTimeframe = (state: TradingState) =>
  state.setSelectedTimeframe;
export const selectSymbolsList = (state: TradingState) => state.symbolsList;
export const selectFetchSymbols = (state: TradingState) => state.fetchSymbols;
export const selectFetchRecentSignals = (state: TradingState) =>
  state.fetchRecentSignals;

export const selectPredictionState = (state: TradingState) => ({
  activeSymbol: state.activeSymbol,
  predictionData: state.predictionData,
  currentPrice: state.currentPrice,
  lastPriceUpdate: state.lastPriceUpdate,
  isLoading: state.isLoading,
  error: state.error,
  quoteStreamWaiting: state.quoteStreamWaiting,
  getPrediction: state.getPrediction,
  setActiveSymbol: state.setActiveSymbol,
  selectedTimeframe: state.selectedTimeframe,
  setSelectedTimeframe: state.setSelectedTimeframe,
  symbolsList: state.symbolsList,
  fetchSymbols: state.fetchSymbols,
});

export const selectLiveSignalsObj = (state: TradingState) => ({
  liveSignals: state.liveSignals,
});

export const selectUnifiedPriceObj = (state: TradingState) => ({
  currentPrice: state.currentPrice,
  lastPriceUpdate: state.lastPriceUpdate,
});

/**
 * PER-SYMBOL CANDLE SELECTOR — returns ONLY the candle array that belongs to
 * the given normalized symbol. Returns `null` when nothing has been fetched
 * yet so the chart can show a loading/syncing state instead of a fake layout.
 */
export const selectCandlesForSymbol = (
  state: TradingState,
  symbol: string,
): CandleDataPoint[] | null => {
  const norm = (symbol || "").trim().toUpperCase();
  return state.candlesCache[norm] ?? null;
};

/** Real-time aggregator selectors */
export const selectIngestLiveTick = (state: TradingState) =>
  state.ingestLiveTick;
export const selectRealtimeCandles = (state: TradingState) =>
  state.realtimeCandles;
export const selectGetRealtimeSeries = (state: TradingState) =>
  state.getRealtimeSeries;

/**
 * LIVE REALTIME SERIES SELECTOR — returns the aggregator's live OHLCV series
 * for a symbol (closed candles + in-progress bar). Falls back to the raw
 * prediction candles when no live ticks have arrived yet.
 */
export const selectRealtimeSeriesForSymbol = (
  state: TradingState,
  symbol: string,
): Candle[] => {
  const norm = (symbol || "").trim().toUpperCase();
  const live = state.realtimeCandles[norm];
  if (live && live.length > 0) return live;
  const raw = state.candlesCache[norm];
  if (raw && raw.length > 0) {
    return raw.map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    }));
  }
  return [];
};

/**
 * Read the live tick-vs-bucket parity telemetry for any symbol — the
 * aggregation layer's tick count vs bucket write count. Used by the
 * WebSocket orchestrator's heartbeat assertion to detect flat-lining
 * symbols (raw ticks arriving but no bucket increment).
 */
export const getAggregatorParityDebug = (symbol?: string) =>
  realtimeAggregator.getDebug(symbol);
