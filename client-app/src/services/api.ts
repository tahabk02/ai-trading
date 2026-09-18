import axios, {
  AxiosInstance,
  AxiosError,
  InternalAxiosRequestConfig,
} from "axios";
import { getApiBaseUrl } from "@/utils/getBaseUrl";
import { OTC_WHITELIST } from "@/constants/symbols";
import { logDebounced503 } from "@/lib/logDebouncer";

/**
 * SYMBOL PAYLOAD NORMALIZER — guarantees the POST body sent to
 * /api/v1/predict matches the backend strict whitelist format ("EUR/USD").
 *
 * Mirrors core-backend symbolRegistry.normalizeSymbol():
 *   "eur/usd"           → "EUR/USD"
 *   "EURUSD"            → "EUR/USD"   (compact 6-char)
 *   "EUR-USD"/"EUR_USD" → "EUR/USD"
 *   "EUR/USD OTC"       → "EUR/USD"   (UI label suffix)
 *   "EUR/USD=X"         → "EUR/USD"   (Yahoo-style suffix)
 *   "EUR/USD.FX"        → "EUR/USD"   (exchange qualifier)
 *
 * Returns null when the input cannot map onto ANY whitelisted pair.
 */
export function normalizeSymbol(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;

  let s = raw.trim().toUpperCase();

  // Strip common display/exchange suffixes
  s = s.replace(/\s*OTC\s*$/, "");
  s = s.replace(/=X$/, "");
  s = s.replace(/\.(FX|FOREX|CS|TO)$/, "");

  // Unify every separator style onto "/"
  s = s.replace(/[\-_.\s]+/g, "/");
  s = s.replace(/\/{2,}/g, "/");
  s = s.replace(/^\//, "").replace(/\/$/, "");

  if (OTC_WHITELIST.has(s)) return s;

  // Compact 6-char form: "EURUSD" → "EUR/USD"
  const compact = s.replace(/\//g, "");
  if (compact.length === 6 && /^[A-Z]{6}$/.test(compact)) {
    const candidate = `${compact.slice(0, 3)}/${compact.slice(3)}`;
    if (OTC_WHITELIST.has(candidate)) return candidate;
  }

  return null;
}

// ── Types ──

export interface PredictionRequest {
  symbol: string;
  timeframe?: string;
  candles?: any[];
  live_price?: number;
  dataSource?: string;
}

export interface CandleDataPoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  projected?: boolean;
}

export interface PredictionResponse {
  symbol: string;
  signal: "BUY" | "SELL";
  confidence: number;
  target_price: number;
  current_price: number;
  ml_probability: number;
  model_accuracy: number;
  timeframe: string;
  proxyLatencyMs: number | null;
  indicators?: {
    rsi_14?: number;
    macd_momentum?: number;
    spread_quality?: number;
    [key: string]: number | undefined;
  };
  scalping_indicators?: {
    rsi_7?: number;
    rsi_14?: number;
    sma_10?: number;
    sma_20?: number;
    sma_50?: number;
    ema_5_slope?: number;
    ema_21_slope?: number;
    macd_fast?: number;
    stoch_k?: number;
    stoch_d?: number;
    atr_14?: number;
  };
  momentum_confirmation?: {
    buy: boolean;
    sell: boolean;
  };
  delta_pct?: number;
  /** True when the engine demoted a directional verdict to market-waiting (CONFLUENCE_BELOW_THERMAL). */
  confidence_gated?: boolean;
  /** Original direction before the confidence gate filtered it (when gated). */
  gated_direction?: string;
  /**
   * Dispatch diagnostics from the AI Engine (v8): confidence gate state,
   * gated direction and the dynamic (50-55%) dispatch floor.
   */
  dispatch?: {
    confidence_gated?: boolean;
    gated_direction?: string;
    threshold?: number;
  };
  /**
   * AI Engine multi-tier dispatch tier (T1…T5) — the honest quality band
   * (T1 PREMIUM … T5 WEAK). Resolved by the engine; never client-derived.
   */
  tier?: string;
  /** Human label for the tier (PREMIUM / HIGH / MEDIUM / LOW / WEAK). */
  tier_label?: string;
  diagnostics?: {
    confidence_gated?: boolean;
    gated_direction?: string;
    dispatch_threshold?: number;
    market_waiting?: boolean;
    waiting_reason?: string | null;
    waiting_detail?: string | null;
    book?: {
      book_confirm?: number;
      agreement?: number;
      magnitude?: number;
      active_count?: number;
      aligned_count?: number;
      factors?: Record<string, number>;
      detail?: Record<string, unknown>;
    };
  };
  /** 10-book confluence folded into the dispatched confidence (v7). */
  book_confluence?: {
    book_confirm?: number;
    agreement?: number;
    magnitude?: number;
    active_count?: number;
    aligned_count?: number;
    factors?: Record<string, number>;
    detail?: Record<string, unknown>;
  };
  /**
   * Market-waiting flag — true when the combined confluence did NOT meet the
   * dynamic (50-55%) floor, so no directional signal was dispatched (blocked
   * for market waiting). The honest reason/detail accompany it.
   */
  market_waiting?: boolean;
  waiting_reason?: string | null;
  waiting_detail?: string | null;
  /**
   * Backend high-confidence alert flag — true when a dispatched signal's
   * genuine confidence exceeds 70%. Drives the priority
   * toast + audio chime; never fabricated client-side.
   */
  high_confidence_alert?: boolean;
  /**
   * 0.98 ensemble watershed diagnostics (the 5-factor quality lock):
   * `quality` is the weighted score (0..1); `quality_factors` the per-factor
   * 0|1 alignment (mtf/momentum/volatility/volume/pressure); `quality_reason`
   * names the block reason. NULL while the factor window is unavailable —
   * the ensemble is honestly reported, never fabricated.
   */
  quality?: number | null;
  quality_factors?: Record<string, number> | null;
  quality_reason?: string | null;
  /** True when the 0.98 watershed collapsed a confidence-valid verdict. */
  quality_watershed_blocked?: boolean;
  verification?: {
    samples: number;
    correct: number;
    wrong: number;
    errorRate: number;
    accuracyPct: number;
    validated: boolean;
    blocking: boolean;
    targetReachedPct: number;
    projectedMeanAbsErrorPct: number;
    barsObserved: number;
    errorLimit: number;
  };
  timestamp: string;
  candles?: CandleDataPoint[];
  future_candles?: CandleDataPoint[];
  barCount?: number;
  dataSource?: string;
  isCrypto?: boolean;
  atr?: number;
  volatility_pct?: number;
  payout?: number;
  // ── TARGET-EXPIRY HORIZON CONTRACT (Alpha.5 Pro) ──
  /** Requested horizon in minutes (1/2/3/5/10) — snap-resolved by the backend. */
  horizon_minutes?: number;
  /**
   * Rolling trend-momentum stabilized horizon contract (Alpha.5 Pro).
   * `stable_signal` is the EWMA-deadband-smoothed directional verdict
   * (CALL/PUT). `confidence` is the calibrated, smoothed confidence
   * (0–100). `expires_in_seconds` is the remaining time until the
   * horizon window closes. NULL when the horizon engine fails.
   */
  horizon?: {
    horizon_minutes: number;
    backend_timeframe: string;
    stable_signal: "CALL" | "PUT" | "NEUTRAL";
    direction: "BUY" | "SELL";
    confidence: number;
    confidence_prev: number;
    delta_confidence: number;
    stable_flips: number;
    entry_ts: string;
    expiry_ts: string;
    expires_in_seconds: number;
    live_price: number | null;
    atr: number | null;
    timeframe: string | null;
    features: {
      ema_cross: number;
      ema_cross_velocity: number;
      ema_fast: number;
      ema_slow: number;
      rsi_14: number;
      rsi_delta: number;
      regression_slope: number;
      regression_r2: number;
      divergence: number;
      divergence_kind: string;
      momentum: number;
      position: number;
      volatility: number;
    };
    raw_direction: "CALL" | "PUT" | "NEUTRAL";
    raw_confidence: number;
    stability: {
      alpha: number;
      reversal_halfwidth: number;
      flip_inertia: number;
      samples: number;
      buffer_ticks: number;
    };
  };
}

export interface SignalData {
  id?: string;
  symbol: string;
  signalType?: "BUY" | "SELL";
  signal_type?: "BUY" | "SELL";
  price?: number;
  confidence?: number;
  /** AI Engine dispatch tier T1…T5 (PART 6) — mirrors signal-gatekeeper. */
  tier?: string;
  createdAt?: string;
  timestamp?: string;
  indicators?: Record<string, unknown>;
  stop_loss?: number;
  take_profit?: number;
  /** Settled P&L in account currency (present on executed trades). */
  pnl?: number;
  /** Broker payout percentage for this instrument (e.g. 92). */
  payout?: number;
}

// ── MARKET TERMINAL (all-pairs grid) ──
/** Enriched single-pair live quote — the exact payload of GET /api/v1/quotes
 *  and the `market_quotes` WS snapshots. Strictly real tape data. */
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

export interface QuotesResponse {
  success: boolean;
  count: number;
  quotes: MarketQuote[];
  timestamp: string;
}

export interface MultiPredictSymbolResult {
  ok: boolean;
  status: number;
  data?: PredictionResponse;
  error?: unknown;
}

export interface MultiPredictResponse {
  success: boolean;
  count: number;
  timeframe: string;
  requestedAt: string;
  generatedAt: string;
  results: Record<string, MultiPredictSymbolResult>;
}

export interface TradeRequest {
  symbol: string;
  direction: "CALL" | "PUT";
  investment: number;
  expiration: number;
}

export interface TradeResponse {
  id: string;
  symbol: string;
  direction: "CALL" | "PUT";
  investment: number;
  entry_price: number;
  expiration: number;
  payout: number;
  status: "OPEN" | "WIN" | "LOSS";
  created_at: string;
  expires_at: string;
}

export interface TradeHistoryResponse {
  trades: TradeResponse[];
  count: number;
}

// ── ADVANCED RISK MANAGEMENT & KILL SWITCH ──
export interface RiskStateSnapshot {
  dayKey: string;
  startingEquity: number;
  realizedPnl: number;
  equity: number;
  peakEquity: number;
  drawdownPct: number;
  maxDailyDrawdownPct: number;
  tradesToday: number;
  winsToday: number;
  lossesToday: number;
  killSwitchLocked: boolean;
  lockedReason: string | null;
  lockedAt: string | null;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
}

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

// ── Axios Instance ──
const api: AxiosInstance = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 15_000,
  headers: {
    "Content-Type": "application/json",
  },
});

// ════════════════════════════════════════════════════════════════════════
// GLOBAL RATE THROTTLE + 429 BACKOFF SHIELD
//
// Every apiClient call flows through THIS axios instance, so the guards
// below act as a SINGLE global throttle/queue for /predict, /signals,
// /risk-state and every other request — no per-call sprinkling required.
//
// 1) THROTTLE: enforce a minimum 5000ms gap between requests to the SAME
//    ENDPOINT + SYMBOL (same method + URL + body). Rapid duplicates from
//    parallel components (symbol switch, multi-component refreshRiskState)
//    are delayed just enough to avoid hammering the backend rate limiter,
//    which otherwise returns HTTP 429 Too Many Requests.
// 2) 429 SHIELD: exponential backoff retry when the server still returns 429.
// ════════════════════════════════════════════════════════════════════════

const THROTTLE_MIN_GAP_MS = 5000;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 10_000;
const RETRY_MAX_ATTEMPTS = 3;

/**
 * HTTP statuses that mean "the backend/quote stream is TEMPORARILY
 * unavailable" — a 503 Service Unavailable (FastAPI proxy has no live quote to
 * price the candle) or a gateway 502/504. Together with the axios
 * `ECONNABORTED` timeout (live-quote response > instance timeout), these are
 * classified as RECOVERABLE in the prediction store: they never surface as a
 * hard application error, they trigger an exponential-backoff re-poll instead.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** SSR-safe timer helpers (window absent during server render). */
const safeSetTimeout = (
  fn: () => void,
  ms: number,
  ...args: unknown[]
): unknown =>
  typeof window !== "undefined"
    ? window.setTimeout(fn, ms)
    : ((globalThis as any).setTimeout(fn, ms, ...args) as number);
const safeClearTimeout = (handle: unknown): void => {
  if (handle == null) return;
  if (typeof window !== "undefined") {
    window.clearTimeout(handle as number);
  } else {
    (globalThis as any).clearTimeout(handle as number);
  }
};

/** Last-sent timestamp per identical-request key. */
const lastSentAt: Record<string, number> = {};

/** Build a stable key identifying "this exact request" for throttling. */
function throttleKey(config: InternalAxiosRequestConfig): string {
  const method = (config.method || "get").toUpperCase();
  const url = config.url || "";
  let body = "";
  try {
    let data = config.data;
    // Strip the per-call cache-buster (`_cb`) so two /predict calls for the
    // SAME symbol+timeframe are recognized as "identical" and throttled —
    // otherwise every request would carry a unique key and the gap never binds.
    if (data && typeof data === "object") {
      const { _cb, ...rest } = data as Record<string, unknown>;
      data = rest;
    }
    body = data ? JSON.stringify(data) : "";
  } catch {
    body = String(config.data ?? "");
  }
  return `${method}|${url}|${body}`;
}

/**
 * Delay until the minimum gap since the previous identical request has
 * elapsed. Resolves immediately if there has been no recent identical call.
 * Rejects early if the AbortSignal was already fired (keeps polling aborts
 * fast during symbol/timeframe switches).
 */
function enforceThrottle(config: InternalAxiosRequestConfig): Promise<void> {
  const key = throttleKey(config);
  const now = Date.now();
  const last = lastSentAt[key] ?? 0;
  const elapsed = now - last;
  const waitMs = Math.max(0, THROTTLE_MIN_GAP_MS - elapsed);

  return new Promise<void>((resolve, reject) => {
    // Honor an already-aborted signal without waiting out the throttle.
    if (config.signal && config.signal.aborted) {
      const err = new axios.CanceledError("canceled");
      return reject(err);
    }
    if (waitMs === 0) return resolve();
    const timer = safeSetTimeout(() => {
      // Re-check after the wait so an abort issued mid-delay short-circuits.
      if (config.signal && config.signal.aborted) {
        reject(new axios.CanceledError("canceled"));
      } else {
        resolve();
      }
    }, waitMs);
    config.signal?.addEventListener(
      "abort",
      () => {
        safeClearTimeout(timer);
        reject(new axios.CanceledError("canceled"));
      },
      { once: true },
    );
  });
}

/** Mark a request key as "just sent" so the next identical one is gated. */
function recordSent(config: InternalAxiosRequestConfig): void {
  lastSentAt[throttleKey(config)] = Date.now();
}

// ── Request interceptor: attach JWT + global throttle ──
api.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    if (typeof window !== "undefined") {
      const token = localStorage.getItem("token");
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    // Global identical-request throttle (5s gap for same endpoint+symbol).
    await enforceThrottle(config);
    recordSent(config);
    return config;
  },
  (error: AxiosError) => Promise.reject(error),
);

// ── Response interceptor: global error handling + 429 backoff retry ──
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as InternalAxiosRequestConfig | undefined;

    // 401 — drop stale token.
    if (error.response?.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("token");
    }

    // ── DEBOUNCED 503 WARNING ──
    // The grid survives an AI-Engine/feed outage by re-polling every pair with
    // backoff — a burst of HTTP 503s. Log the FIRST one, stay silent through
    // the 10s window, then warn again only on a genuinely NEW incident.
    if (error.response?.status === 503) {
      logDebounced503("[api] 503 Service Unavailable", {
        url: config?.url,
        method: config?.method,
      });
    }

    // ══ RETRYABLE TRANSPORT FAILURES → exponential backoff retry ══
    // 429 (rate limited) · 502/503/504 (gateway / backend temporarily
    // unavailable / live-quote proxy refusing to price) · ECONNABORTED
    // (axios timeout — quote response exceeded the 15s window) are ALL
    // temporary conditions. The retry is exponential-backoff so the UI
    // auto-recovers the moment the backend / quote stream is back.
    //   • 429 retries ANY method (the request was never accepted).
    //   • 502/503/504 + timeouts retry only idempotent probes (GETs + the
    //     /predict read) — the server MAY have started the request, and a
    //     blind retry of a mutating POST (trade execution) could double-submit.
    const reqStatus = error.response?.status;
    const timedOut = error.code === "ECONNABORTED";
    const retryableState =
      (typeof reqStatus === "number" && RETRYABLE_STATUS.has(reqStatus)) ||
      timedOut;
    const lowerMethod = (config?.method ?? "get").toLowerCase();
    // 429 means the request was NOT accepted by the rate limiter, so a retry
    // is safe for ANY method. 502/503/504 + live-quote timeouts mean the
    // server MAY have started the request → retry only idempotent probes
    // (GETs + the /predict read).
    const isIdempotent =
      lowerMethod === "get" || String(config?.url ?? "").startsWith("/predict");
    if (
      retryableState &&
      (reqStatus === 429 || isIdempotent) &&
      config &&
      !config.signal?.aborted
    ) {
      const attempt =
        ((config as InternalAxiosRequestConfig & { __retryCount?: number })
          .__retryCount ?? 0) + 1;
      if (attempt <= RETRY_MAX_ATTEMPTS) {
        (
          config as InternalAxiosRequestConfig & { __retryCount?: number }
        ).__retryCount = attempt;
        const delay = Math.min(
          RETRY_MAX_DELAY_MS,
          RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        );
        await new Promise<void>((resolve) => safeSetTimeout(resolve, delay));
        // recordSent is re-hit on the retry so the throttle gap still applies;
        // reset the key so a retry is not gated behind a fresh identical call.
        lastSentAt[throttleKey(config)] = 0;
        return api.request(config);
      }
    }

    return Promise.reject(error);
  },
);

// ── Order Book Types ──
export interface OrderBookLevel {
  price: number;
  quantity: number;
  total: number;
}

export interface OrderBookResponse {
  symbol: string;
  source: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midPrice: number;
  spread: number;
  spreadPercent: number;
  level1?: boolean;
  lastPrice?: number;
  /**
   * TRUE electron-book depth gate (lock-down): FALSE when the live broker tape
   * exposes no real depth (Pocket Option quotes are L1-only). When false,
   * `bids`/`asks` are EMPTY and the UI must render the honest L1 quote panel —
   * never a fabricated ladder.
   */
  hasDepth?: boolean;
  depthLabel?: string;
  timestamp: string;
}

/**
 * Enhanced prediction error carrying a classifier so the STORE can decide how
 * to surface it:
 *   - `recoverable === true` → 5xx / 429 / network failure / live-quote
 *     timeout. NOT a hard application error: the store keeps the last good
 *     prediction, flips a calm "waiting for live asset stream" banner and
 *     schedules an exponential-backoff re-poll.
 *   - otherwise → a real 4xx / payload validation failure the UI should show.
 */
export interface PredictionError extends Error {
  status?: number;
  recoverable?: boolean;
}

// ── API Methods ──
const apiClient = {
  async register(
    email: string,
    password: string,
    name?: string,
  ): Promise<AuthResponse> {
    const { data } = await api.post<AuthResponse>("/auth/register", {
      email,
      password,
      name,
    });
    return data;
  },

  async login(email: string, password: string): Promise<AuthResponse> {
    const { data } = await api.post<AuthResponse>("/auth/login", {
      email,
      password,
    });
    return data;
  },

  async getSignals(symbol?: string, limit = 50): Promise<SignalData[]> {
    const params: Record<string, string | number> = { limit };
    if (symbol) params.symbol = symbol;
    const { data } = await api.get<SignalData[]>("/signals", { params });
    return data;
  },

  async getSignalById(id: string): Promise<SignalData> {
    const { data } = await api.get<SignalData>(`/signals/${id}`);
    return data;
  },

  async getPrediction(
    symbol: string,
    timeframe: string = "1d",
    signal?: AbortSignal,
    horizonMinutes?: number,
  ): Promise<PredictionResponse> {
    const _cb = Date.now();
    // ── NORMALIZE BEFORE SEND — never transmit a non-whitelist format.
    // Falls back to the trimmed uppercase input when normalization cannot
    // recover a canonical pair (backend will respond with a descriptive
    // error listing supported symbols).
    const cleanSymbol = normalizeSymbol(symbol) ?? symbol.trim().toUpperCase();
    const cleanTimeframe = timeframe.trim().toLowerCase();
    const hz = Number.isFinite(horizonMinutes) && (horizonMinutes as number) >= 1
      ? Math.min(10, Math.round(horizonMinutes as number))
      : undefined;

    try {
      const { data } = await api.post<PredictionResponse>(
        "/predict",
        {
          symbol: cleanSymbol,
          timeframe: cleanTimeframe,
          dataSource: "otc_forex",
          ...(hz != null ? { horizon_minutes: hz } : {}),
          _cb,
        },
        { signal },
      );
      return data;
    } catch (proxyError) {
      // ── RECOVERABLE vs HARD FAILURE CLASSIFIER ──
      // 503 Service Unavailable + axios ECONNABORTED (>15s live-quote timeout)
      // are TRANSIENT (the quote stream is stalling, not gone). They carry
      // `recoverable = true` so the store re-polls instead of alarming.
      if (axios.isAxiosError(proxyError)) {
        // Live-quote / proxy timeout — the candle could not be priced in time.
        if (proxyError.code === "ECONNABORTED") {
          const timedOut = new Error(
            "Live quote timed out — waiting for asset stream.",
          ) as PredictionError;
          timedOut.name = "PredictionTimeoutError";
          timedOut.recoverable = true;
          throw timedOut;
        }

        const status = proxyError.response?.status;

        // Transport-level failure with NO HTTP response (backend unreachable,
        // gateway dropped the connection). Same transient classification.
        if (!status && proxyError.request) {
          const netErr = new Error(
            "Prediction service unreachable — retrying.",
          ) as PredictionError;
          netErr.name = "PredictionNetworkError";
          netErr.recoverable = true;
          throw netErr;
        }

        if (proxyError.response) {
          const serverMsg =
            proxyError.response.data?.message ||
            proxyError.response.data?.error ||
            "";
          const err = new Error(
            serverMsg ||
              `Prediction service returned ${status}. Please verify the symbol and try again.`,
          ) as PredictionError;
          err.status = status;
          // 5xx (including 503 Service Unavailable) and 429 are transient by
          // nature; 4xx validation errors are NOT retryable.
          err.recoverable =
            typeof status === "number" && (status >= 500 || status === 429);
          throw err;
        }
      }
      throw proxyError;
    }
  },

  async getSymbols(
    search?: string,
    type?: "stock" | "crypto" | "etf" | "otc" | "commodity",
    limit = 50,
  ): Promise<{
    success: boolean;
    count: number;
    symbols: Array<{
      symbol: string;
      name: string;
      type: "stock" | "crypto" | "etf" | "otc" | "commodity";
      assetSubType?: "forex" | "otc" | "crypto" | "commodity";
      exchange: string;
      currency: string;
      payout: number;
      label: string;
      digits: number;
    }>;
  }> {
    const params: Record<string, string | number> = { limit };
    if (search) params.search = search;
    if (type) params.type = type;
    const { data } = await api.get("/symbols", { params });
    return data;
  },

  async getOrderBook(symbol: string): Promise<OrderBookResponse> {
    const { data } = await api.get<OrderBookResponse>("/orderbook", {
      params: { symbol: symbol.toUpperCase() },
    });
    return data;
  },

  // ── MARKET TERMINAL (all-pairs grid) ──
  /** REST bootstrap for the grid — one enriched snapshot of every live pair. */
  async getQuotes(): Promise<QuotesResponse> {
    const { data } = await api.get<QuotesResponse>("/quotes");
    return data;
  },

  /**
   * Batch prediction (horizon refresh). Fans the symbol list through the SAME
   * /predict pipeline server-side (real bars + live tick + ATR targets, 5s
   * result cache, bounded concurrency); `silent` suppresses the global
   * high-confidence toasts so a 34-card horizon change never spams alerts.
   * Longer window than the default 15s — a cold batch across all pairs can
   * take longer than the standard request budget.
   */
  async multiPredict(
    symbols: string[],
    timeframe: string = "1m",
  ): Promise<MultiPredictResponse> {
    const cleanSymbols = symbols
      .map((s) => normalizeSymbol(s) ?? s.trim().toUpperCase())
      .filter(Boolean);
    const { data } = await api.post<MultiPredictResponse>(
      "/multi-predict",
      {
        symbols: cleanSymbols,
        timeframe: timeframe.trim().toLowerCase(),
        _cb: Date.now(),
      },
      { timeout: 60_000 },
    );
    return data;
  },

  async getProfile(): Promise<UserProfile> {
    const { data } = await api.get<UserProfile>("/users/me");
    return data;
  },

  async updateProfile(updates: Partial<Pick<UserProfile, "name">>) {
    const { data } = await api.patch<UserProfile>("/users/me", updates);
    return data;
  },

  async getSettings() {
    const { data } = await api.get("/settings");
    return data;
  },

  async updateSettings(updates: any) {
    const { data } = await api.put("/settings", updates);
    return data;
  },

  async executeTrade(trade: TradeRequest): Promise<TradeResponse> {
    const { data } = await api.post<TradeResponse>("/trades", trade);
    return data;
  },

  async getTradeHistory(limit = 50): Promise<TradeHistoryResponse> {
    const { data } = await api.get<TradeHistoryResponse>("/trades", {
      params: { limit },
    });
    return data;
  },

  async getRiskRules() {
    const { data } = await api.get("/risk-rules");
    return data;
  },

  async createRiskRule(input: any) {
    const { data } = await api.post("/risk-rules", input);
    return data;
  },

  async updateRiskRule(id: string, updates: any) {
    const { data } = await api.put(`/risk-rules/${id}`, updates);
    return data;
  },

  async deleteRiskRule(id: string): Promise<void> {
    await api.delete(`/risk-rules/${id}`);
  },

  // ── Kill Switch / Daily Drawdown Engine ──
  async getRiskState(): Promise<RiskStateSnapshot> {
    const { data } = await api.get<RiskStateSnapshot>("/risk-state");
    return data;
  },

  async recordTradeResult(pnl: number): Promise<RiskStateSnapshot> {
    const { data } = await api.post<RiskStateSnapshot>(
      "/risk-state/trade-result",
      { pnl },
    );
    return data;
  },

  async resetKillSwitch(): Promise<RiskStateSnapshot> {
    const { data } = await api.post<RiskStateSnapshot>("/risk-state/reset");
    return data;
  },

  /** EMERGENCY LOCK — manually engage the kill switch (locks live trading). */
  async engageKillSwitch(reason?: string): Promise<RiskStateSnapshot> {
    const { data } = await api.post<RiskStateSnapshot>("/risk-state/engage", {
      reason,
    });
    return data;
  },

  async setMaxDrawdown(maxDrawdownPct: number): Promise<RiskStateSnapshot> {
    const { data } = await api.put<RiskStateSnapshot>(
      "/risk-state/max-drawdown",
      { maxDrawdownPct },
    );
    return data;
  },
};

export default apiClient;
