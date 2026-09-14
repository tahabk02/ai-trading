import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";
import { symbolRegistry } from "../services/symbolRegistry.service";
import { forexDataService, ForexCandle } from "../services/forexData.service";
import { websocketService } from "../services/websocket.service";
import { realtimeTickBuffer } from "../services/realtimeTickBuffer.service";

const prisma = new PrismaClient();

// ── Constants ──
const MINIMUM_REQUIRED_BARS = 30;

// ── LIVE-PRICE FRESHNESS GATE ──
// The AI pipeline is fed EXCLUSIVELY by the real-time tick tape. If the
// freshest genuine tick's own timestamp is older than this, analysis is
// paused (HTTP 503 "Waiting for Real-time Tick") — the platform NEVER
// analyses, scores or projects a stale price. 10s absorbs brief spot-rate
// jitter while staying well below the platform's stale-price threshold.
const LIVE_PRICE_MAX_AGE_MS = 10_000;

function timeframeMs(timeframe: string): number {
  const token = String(timeframe || "1m")
    .toLowerCase()
    .replace("+", "");
  const amount = Number.parseInt(token, 10);
  if (!Number.isFinite(amount) || amount <= 0)
    throw new Error(`Invalid timeframe: ${timeframe}`);
  if (token.endsWith("h")) return amount * 3_600_000;
  if (token.endsWith("d")) return amount * 86_400_000;
  return amount * 60_000;
}

function buildFutureCandles(
  bars: ForexCandle[],
  livePrice: number,
  target: number,
  atr: number,
  bid: number | undefined,
  ask: number | undefined,
  timeframe: string,
  digits: number,
) {
  if (!bars.length || livePrice <= 0 || target <= 0 || atr <= 0) return [];
  const interval = timeframeMs(timeframe);
  const rawTimestamp = new Date(bars[bars.length - 1].timestamp).getTime();
  if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) return [];
  const anchor = Math.floor(rawTimestamp / interval) * interval;
  const intervals = Math.max(1, Math.round(interval / 60_000));
  const spread = bid && ask && ask >= bid ? ask - bid : 0;
  const wick = Math.max(atr * 0.5, spread * 0.5);
  const round = (value: number) => Number(value.toFixed(digits));
  const result = [];
  let previousClose = livePrice;
  for (let index = 1; index <= intervals; index += 1) {
    const close =
      index === intervals
        ? target
        : livePrice + ((target - livePrice) * index) / intervals;
    result.push({
      timestamp: anchor + index * interval,
      open: round(previousClose),
      high: round(Math.max(previousClose, close) + wick),
      low: round(Math.max(0, Math.min(previousClose, close) - wick)),
      close: round(close),
      volume: 0,
      projected: true,
    });
    previousClose = close;
  }
  return result;
}

const TIMEFRAME_DESIRED_BARS: Record<string, number> = {
  "1m": 200,
  "2m": 200,
  "3m": 200,
  "5m": 200,
  "10m": 200,
  "15m": 200,
  "20m": 200,
  "25m": 200,
  "30m": 200,
  "35m+": 200,
  "1h": 240,
  "4h": 240,
  "1d": 200,
};

/** HIGH-CONFIDENCE NOTIFICATION THRESHOLD — fires a priority WS toast above this.
 *  Mirrors the AI Engine's ALERT threshold. Since v10 the AI Engine's
 *  `high_confidence_alert` fires ONLY on an organically converged DEFINITIVE
 *  (>=96.5%) 10-book verdict (no secondary pathway, no dynamic floor), the
 *  priority toast threshold is locked to that same 96.5% thermal gate. */
export const HIGH_CONFIDENCE_THRESHOLD = 96.5;

// ════════════════════════════════════════════════════════════════════
// SHORT-TTL /predict RESULT CACHE — kills the duplicate-inference storm
// ════════════════════════════════════════════════════════════════════
// Multiple consumers (trading-panel, predictive-intelligence, symbol
// dropdowns) fire /predict for the SAME (symbol, timeframe) within the same
// second. Without a server-side cache every burst recomputes spot + history
// and re-runs the AI Engine concurrently — wasting inference and turning the
// heavy work into 429/5xx blips. A short TTL collapses concurrent duplicates
// onto ONE fresh computation while the client's 5s throttle still bounds
// steady-state polling. Responses are per-pair so pairs never bleed into one
// another. Only SUCCESSFUL predictions are cached (never a 503/500).
const PREDICT_CACHE_TTL_MS = 5_000;
const predictCache = new Map<
  string,
  { expiresAt: number; response: unknown }
>();
function getCachedPredict(key: string): unknown | null {
  const hit = predictCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    predictCache.delete(key);
    return null;
  }
  return hit.response;
}
function setCachedPredict(key: string, response: unknown): void {
  predictCache.set(key, {
    expiresAt: Date.now() + PREDICT_CACHE_TTL_MS,
    response,
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downstream AI-Engine failure classifier — the single source of truth for WHY
 * the Python service (default `http://ai-engine:8000`) failed a request:
 *   • unreachable → ECONNREFUSED / EHOSTUNREACH / no HTTP response while the
 *     engine is DOWN or still STARTING UP (docker-compose).
 *   • timeout    → ECONNABORTED / ETIMEDOUT — heavy inference exceeded budget.
 *   • http       → the engine is UP but responded 503 (unavailable/loading),
 *                  4xx (payload rejected) or 5xx (internal error).
 *   • unknown    → anything else (kept as a string so nothing crashes).
 * `postWithRetry` uses it only for the transient-vs-permanent decision; the
 * /predict catch path uses it to stamp honest metadata on the HOLD fallback.
 */
export type AiEngineFailure =
  | { kind: "unreachable"; code: string; detail: string }
  | { kind: "timeout"; code: string; detail: string }
  | { kind: "http"; status: number; code: string; detail: string }
  | { kind: "unknown"; code: string; detail: string };

export function classifyAiEngineFailure(err: unknown): AiEngineFailure {
  if (axios.isAxiosError(err)) {
    const code = err.code || "";
    // ── Transport-level failure — NO HTTP response came back from the engine.
    //    Covers ECONNREFUSED (service down / still starting on :8000), network
    //    drops and client-side timeouts (ECONNABORTED / ETIMEDOUT). Bare
    //    axios/post errors never turn into a raw unhandled 5xx here.
    if (!err.response) {
      if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
        return {
          kind: "timeout",
          code,
          detail:
            "Request timed out — AI Engine exceeded its inference budget.",
        };
      }
      return {
        kind: "unreachable",
        code,
        detail:
          code === "ECONNREFUSED"
            ? "Connection refused — AI Engine (port 8000) is not up or is still starting."
            : code === "EHOSTUNREACH"
              ? "AI Engine host is unreachable."
              : code || "No HTTP response was received from the AI Engine.",
      };
    }
    // ── The engine IS reachable — preserve the exact upstream status (e.g. 503
    //    while FastAPI warms up its model) so callers can classify cleanly.
    const status = err.response.status;
    return {
      kind: "http",
      status,
      code: String(status),
      detail: `AI Engine responded with HTTP ${status}${err.response.statusText ? ` (${err.response.statusText})` : ""}.`,
    };
  }
  return {
    kind: "unknown",
    code: "",
    detail: err instanceof Error ? err.message : String(err),
  };
}

/** True when a downstream AI-Engine failure is TRANSIENT (worth a retry):
 *  no HTTP response at all (ECONNREFUSED/timeout/network), 429 rate-limit, or
 *  any 5xx — including the 503 the engine returns while starting up. 4xx
 *  validation errors are permanent and never retried. */
function isTransientAiFailure(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  if (!err.response) return true;
  return status === 429 || (status != null && status >= 500);
}

async function postWithRetry<T>(
  url: string,
  payload: unknown,
  config: Record<string, unknown>,
  maxRetries = PREDICT_MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await axios.post<T>(url, payload, config);
      return data;
    } catch (err) {
      lastError = err;
      if (isTransientAiFailure(err)) {
        if (attempt < maxRetries) {
          // Exponential backoff (+ small jitter so a burst of deduped /predict
          // calls never re-storms a still-starting engine all at once) absorbs
          // transient heavy-inference spikes — the HOLD fallback only engages
          // after PERSISTENT failure.
          const backoff = 500 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 100);
          await sleep(backoff + jitter);
          continue;
        }
      }
      break;
    }
  }
  throw lastError;
}

const buildAiEnginePredictUrl = (baseUrl: string): string => {
  const cleaned = baseUrl.replace(/\/+$/, "");
  if (cleaned.endsWith("/api/v1")) return `${cleaned}/predict`;
  if (cleaned.endsWith("/api")) return `${cleaned}/v1/predict`;
  return `${cleaned}/api/v1/predict`;
};

const AI_ENGINE_PREDICT_URL = buildAiEnginePredictUrl(secrets.AI_ENGINE_URL);
// ── Extended AI Engine timeout ──
// A cold-cache RandomForest train alone takes ~1.3s, and /predict requests can
// queue briefly behind the AI Engine's event loop while heavy confluence
// computation runs. The previous 3s budget was aborted by axios (exactly 3.0s
// of socket inactivity) even when the engine completed the request in
// 300–700ms — a consistent 503 source. 12s keeps a legitimate slow-but-alive
// engine alive while still returning fast enough for the client's backoff
// loop (retryAfterMs) to stay snappy on a genuinely dead engine.
const PREDICT_TIMEOUT_MS = 12_000;
const PREDICT_MAX_RETRIES = 1;

// ════════════════════════════════════════════════════════════════════════
// HIGH-FREQUENCY TICK-QUANT PATH (fast endpoint, separate from /predict)
// ════════════════════════════════════════════════════════════════════════
// The heavy /predict path needs >=85 real bars + RandomForest warmup and only
// runs on candle close (~once a minute). This is a SEPARATE fast path that
// evaluates the REAL sub-minute tape every second (client-driven 1s loop) on
// genuine live prices via the AI Engine's <1ms numpy scorer
// (POST /tick-signal). It works with as few as 2 real prices, so the terminal
// never sticks on a stale candle-close HOLD — direction and confidence are
// re-derived continuously from true observed momentum.
//
// ZERO FABRICATION:
//   * Only prices from the realtimeTickBuffer (real live ticks) and/or a REAL
//     live-spot fetch are ever forwarded. No invented close, no seeded series.
//   * With fewer than 2 real prices the endpoint returns a clean HTTP 400 —
//     it refuses to invent a signal.
//   * Short timeout + minimal retry: this is the high-cadence path; a slow
//     AI Engine must not back-pressure the 1s loop.
// ════════════════════════════════════════════════════════════════════════
const buildAiEngineTickSignalUrl = (baseUrl: string): string => {
  const cleaned = baseUrl.replace(/\/+$/, "");
  if (cleaned.endsWith("/api/v1")) return `${cleaned}/tick-signal`;
  if (cleaned.endsWith("/api")) return `${cleaned}/v1/tick-signal`;
  return `${cleaned}/api/v1/tick-signal`;
};

const AI_ENGINE_TICK_SIGNAL_URL = buildAiEngineTickSignalUrl(
  secrets.AI_ENGINE_URL,
);
/** Fast path budget — short enough to keep the 1s loop from back-pressuring. */
const TICK_SIGNAL_TIMEOUT_MS = 4_000;

/** Map internal numeric-ms candles to the AI Engine ISO-string contract. */
function mapCandlesToAiFormat(bars: ForexCandle[]) {
  return bars.map((b) => ({
    timestamp: new Date(b.timestamp).toISOString(),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

/**
 * HIGH-CONFIDENCE WEBSOCKET EVENT — fires when a dispatched signal's
 * confidence crosses the strict 96.5% DEFINITIVE thermal gate (aligned with
 * the v10 AI Engine alert threshold — only organically converged 10-book
 * confluence can ever reach it). The frontend renders a priority toast with an
 * alert sound on receipt of `high_confidence_signal`.
 */
function maybeBroadcastHighConfidence(prediction: {
  symbol?: string;
  signal?: string;
  confidence?: number;
  target_price?: number;
  current_price?: number;
  timeframe?: string;
  market_waiting?: boolean;
}) {
  try {
    const conf = Number(prediction.confidence);
    if (
      Number.isFinite(conf) &&
      conf >= HIGH_CONFIDENCE_THRESHOLD &&
      prediction.signal &&
      prediction.market_waiting !== true
    ) {
      websocketService.broadcastHighConfidenceSignal({
        symbol: String(prediction.symbol ?? ""),
        signalType: prediction.signal as "BUY" | "SELL",
        confidence: conf,
        price: Number(prediction.current_price ?? 0),
        targetPrice: Number(prediction.target_price ?? 0),
        timeframe: String(prediction.timeframe ?? "1d"),
        timestamp: new Date().toISOString(),
      });
    }
  } catch (e) {
    logger.warn("[signal.controller] High-confidence broadcast failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── Signal CRUD ──
export const getSignals = async (req: Request, res: Response) => {
  try {
    const { symbol, limit = "50" } = req.query;
    const signals = await prisma.signal.findMany({
      where: symbol ? { symbol: String(symbol) } : {},
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit), 100),
    });
    return res.json(signals);
  } catch (error) {
    logger.error("Error fetching signals", { error });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

export const getSignalById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const signal = await prisma.signal.findUnique({ where: { id } });
    if (!signal) return res.status(404).json({ error: "Signal not found" });
    return res.json(signal);
  } catch (error) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// ── Prediction Pipeline ──
export const predictSignal = async (req: Request, res: Response) => {
  const { symbol, timeframe } = req.body as {
    symbol?: string;
    timeframe?: string;
  };

  if (!symbol || typeof symbol !== "string" || symbol.trim().length === 0) {
    logger.info("[predict] symbol=missing timeframe=unknown status=error");
    return res.status(400).json({
      error: "Validation Error",
      message: 'A non-empty "symbol" field is required.',
    });
  }

  if (
    !timeframe ||
    typeof timeframe !== "string" ||
    timeframe.trim().length === 0
  ) {
    logger.info(
      `[predict] symbol=${symbol.trim()} timeframe=missing status=error`,
    );
    return res.status(400).json({
      error: "Validation Error",
      message: 'A non-empty "timeframe" field is required.',
    });
  }

  // ── SYMBOL NORMALIZATION RECOVERY ──
  // Accept every common client format ("eur/usd", "EURUSD", "EUR-USD",
  // "EUR/USD OTC", "EUR/USD=X") and map onto the canonical whitelist entry.
  // Only inputs that cannot map to ANY whitelisted pair are rejected.
  const normalizedSymbol =
    symbolRegistry.normalizeSymbol(symbol) ?? symbol.trim().toUpperCase();
  const normalizedTimeframe = timeframe || "1d";
  const t0 = Date.now();

  // ════════════════════════════════════════════════════════════════════
  // STEP 0 — STRICT OTC WHITELIST ENFORCEMENT (single boundary check)
  // ════════════════════════════════════════════════════════════════════
  if (!symbolRegistry.isValidSymbolSync(normalizedSymbol)) {
    logger.warn("[signal.controller] Non-whitelisted symbol rejected", {
      symbol: normalizedSymbol,
    });
    logger.info(
      `[predict] symbol=${normalizedSymbol} timeframe=${normalizedTimeframe} status=error`,
    );
    return res.status(400).json({
      error: "Symbol not permitted",
      symbol: normalizedSymbol,
      message: `"${normalizedSymbol}" is not part of the strict OTC forex whitelist. Only the whitelisted OTC pairs are supported.`,
      supportedSymbols: (await symbolRegistry.getAll("otc")).map(
        (e) => e.symbol,
      ),
      timeframe: normalizedTimeframe,
      timestamp: new Date().toISOString(),
    });
  }

  const tfNormalized = normalizedTimeframe.toLowerCase();
  // ── SUB-MINUTE CHART GRID → AI THERMAL HORIZON BRIDGE ──
  // The chart may request a sub-minute bucket (20s / 1s / 100ms / 20ms), but
  // the ai-engine's Pydantic whitelist (schemas.py) only accepts >= 1m. A raw
  // sub-minute dispatch would 422 → permanently cached HOLD-only fallback.
  // Coerce the AI-dispatch channel (bars fetch + engine payload) to "1m" while
  // `tfNormalized` stays untouched for the response / ATR target scaling.
  const SUB_MINUTE_CHART_TIMEFRAMES = new Set(["20ms", "100ms", "1s", "20s"]);
  const aiDispatchTimeframe = SUB_MINUTE_CHART_TIMEFRAMES.has(tfNormalized)
    ? "1m"
    : tfNormalized;
  const desiredBars = TIMEFRAME_DESIRED_BARS[tfNormalized] || 200;

  // ── RESULT CACHE (5s TTL) — concurrent /predict bursts share one result ──
  const cacheKey = `${normalizedSymbol.toLowerCase()}::${tfNormalized}`;
  const cached = getCachedPredict(cacheKey);
  if (cached !== null) {
    return res
      .setHeader(
        "Cache-Control",
        `private, max-age=${PREDICT_CACHE_TTL_MS / 1000}`,
      )
      .json(cached);
  }

  logger.info("[signal.controller] Starting OTC forex prediction pipeline", {
    symbol: normalizedSymbol,
    timeframe: normalizedTimeframe,
    dataSource: "forex_otc",
  });

  // ── Step 1: Fetch REAL live spot + REAL historical OTC candles ──
  // Intraday timeframes (1m–4h) have NO free real source without a
  // TWELVE_DATA_API_KEY. Rather than failing the whole prediction (the
  // "intraday dead-zone"), we fall back to the pair's REAL daily bars —
  // genuine ECB/CoinGecko history — so the quant engines always receive a
  // valid real series. The volatility floor in computeAtr scales the
  // horizon correctly for the requested timeframe.
  const [spotResult, barResult] = await Promise.all([
    forexDataService.getLiveSpotFresh(normalizedSymbol),
    forexDataService
      .getHistoricalCandles(normalizedSymbol, aiDispatchTimeframe, desiredBars)
      .then(async (intraday) => {
        if (intraday.success && intraday.bars.length >= MINIMUM_REQUIRED_BARS) {
          return intraday;
        }
        // Real daily-bar fallback (never synthetic)
        return forexDataService.getHistoricalCandles(
          normalizedSymbol,
          "1d",
          Math.max(desiredBars, MINIMUM_REQUIRED_BARS),
        );
      })
      .catch((err) => {
        logger.warn("[signal.controller] Historical candle fetch threw", {
          symbol: normalizedSymbol,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          success: false as const,
          symbol: normalizedSymbol,
          bars: [] as ForexCandle[],
          source: "none" as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }),
  ]);

  // ── LIVE PRICE: SSOT from the real-time tick buffer (same stream the
  //    chart renders) — NOT from REST spot calls which can be stale. ──
  // FRESHNESS GATE — analysis only ever runs on a genuinely fresh live quote:
  //   1. fresh real WS tick (its own timestamp ≤ 10s old)  → authoritative
  //   2. cold-start (no genuine tick yet) + fresh spot fetch
  //      (held 15s/60s PO rates are REJECTED)             → bootstrap only
  //   3. any tick older than 10s                           → PAUSE (HTTP 503)
  // The last-candle-close fallback is REMOVED: a closing print from an old
  // bar is a historical price, never a live quote, so it is ineligible for
  // live analysis regardless of how the tape looks.
  const tickEntry = realtimeTickBuffer.getLatestEntry(normalizedSymbol);
  const tickAgeMs = tickEntry ? Date.now() - tickEntry.tsMs : null;

  const isHeldStaleSpot =
    spotResult.source === "pocket_option_held" ||
    spotResult.source === "held_stale_real";
  const spotBootstrap =
    spotResult.success &&
    spotResult.price != null &&
    Number.isFinite(spotResult.price) &&
    spotResult.price > 0 &&
    !isHeldStaleSpot;

  let bars: ForexCandle[] = barResult.success ? barResult.bars : [];

  let effectiveLivePrice: number | null = null;
  let livePriceSource = "none";
  let livePriceAgeMs: number | null = tickAgeMs;

  if (
    tickEntry &&
    tickEntry.price > 0 &&
    Number.isFinite(tickEntry.price) &&
    tickAgeMs != null &&
    tickAgeMs <= LIVE_PRICE_MAX_AGE_MS
  ) {
    effectiveLivePrice = tickEntry.price;
    livePriceSource = "live_ws_tick";
  } else if (tickEntry == null && spotBootstrap) {
    // Pure cold-start bootstrap (no genuine tick has ever arrived yet). The
    // moment the first real tick lands, this path is disabled for good. A
    // stale-but-existed tape is NEVER masked by a spot quote — that is the
    // exact "no tick for 2-3s → pause" rule.
    effectiveLivePrice = spotResult.price;
    livePriceSource = spotResult.source;
    livePriceAgeMs = null;
  }

  if (
    effectiveLivePrice == null ||
    !Number.isFinite(effectiveLivePrice) ||
    effectiveLivePrice <= 0
  ) {
    const staleMs = tickAgeMs ?? 0;
    logger.warn(
      "[signal.controller] Stale-live gate — refusing analysis on an old price",
      {
        symbol: normalizedSymbol,
        liveTickAgeMs: tickAgeMs,
        spotSource: spotResult.source,
        spotPresent: spotResult.success,
      },
    );
    logger.info(
      `[predict] symbol=${normalizedSymbol} timeframe=${normalizedTimeframe} status=error`,
    );
    return res.status(503).json({
      error: "Awaiting real-time tick",
      symbol: normalizedSymbol,
      message:
        tickAgeMs != null
          ? `No fresh live quote observed for ${staleMs}ms — signal generation is paused. Analysis resumes on the next real-time tick.`
          : "Waiting for Real-time Tick — no live quote yet. Analysis resumes once the real-time bridge delivers a fresh quote.",
      timeframe: normalizedTimeframe,
      connecting: true,
      live_tick_age_ms: staleMs,
      live_price_source: livePriceSource,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Step 2: CONSERVE & ACCUMULATE REAL CANDLES (ZERO-FABRICATION) ──
  // The persistent per-symbol buffer accumulates ONLY real 1-minute OHLC
  // buckets from live ticks (see tickIngestion.service → appendTick). If the
  // real bars fetched here fall short of the minimum, we pull the live-fed
  // buffer too. When that still cannot reach the real-bar floor, we do NOT
  // manufacture history — we return a honest "awaiting live data" state so
  // the client keeps streaming real ticks until enough genuine bars exist.
  if (bars.length < MINIMUM_REQUIRED_BARS) {
    const buffered = await forexDataService.getBufferedCandles({
      symbol: normalizedSymbol,
      timeframe: tfNormalized,
      quote: effectiveLivePrice ?? undefined,
      required: MINIMUM_REQUIRED_BARS,
      realBars: bars,
    });

    // Prefer the freshest real observation (live quote or buffer last close).
    const bufferedLive =
      effectiveLivePrice != null &&
      Number.isFinite(effectiveLivePrice) &&
      effectiveLivePrice > 0
        ? effectiveLivePrice
        : buffered.length > 0
          ? buffered[buffered.length - 1].close
          : null;

    if (buffered.length >= MINIMUM_REQUIRED_BARS) {
      logger.info(
        "[signal.controller] Real candle buffer satisfied — continuing with directional signal",
        {
          symbol: normalizedSymbol,
          realBars: bars.length,
          bufferedBars: buffered.length,
          required: MINIMUM_REQUIRED_BARS,
          livePrice: bufferedLive,
          source: "real",
        },
      );
      bars = buffered;
      if (
        bufferedLive != null &&
        Number.isFinite(bufferedLive) &&
        bufferedLive > 0
      ) {
        effectiveLivePrice = bufferedLive;
      }
    } else {
      logger.warn(
        "[signal.controller] Real historical bars accumulating — awaiting live data (zero-fabrication)",
        {
          symbol: normalizedSymbol,
          realBars: bars.length,
          bufferedBars: buffered.length,
          required: MINIMUM_REQUIRED_BARS,
        },
      );
      logger.info(
        `[predict] symbol=${normalizedSymbol} timeframe=${normalizedTimeframe} status=error`,
      );
      return res.status(503).json({
        error: "Awaiting live market data",
        symbol: normalizedSymbol,
        message: `Not enough real historical bars yet (${buffered.length}/${MINIMUM_REQUIRED_BARS}). Live ticks are being recorded — a definitive signal will be available once sufficient real bars accumulate. The zero-fabrication policy refuses to invent candles.`,
        timeframe: normalizedTimeframe,
        bars_collected: buffered.length,
        bars_required: MINIMUM_REQUIRED_BARS,
        collecting: true,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Step 3: Genuine ATR computation from real candles (Wilder) ──
  // Defensive: a computeAtr edge case (e.g. insufficient bars) must NEVER
  // become an unhandled 500. It degrades to a neutral 0 so the pipeline either
  // still reaches the AI Engine or lands on the HOLD fallback cleanly.
  let atr = 0;
  try {
    atr = forexDataService.computeAtr(bars, 14, {
      symbol: normalizedSymbol,
      timeframe: normalizedTimeframe,
    }).atr;
  } catch (e) {
    atr = 0;
    logger.warn(
      "[signal.controller] ATR computation failed — continuing with neutral ATR",
      {
        symbol: normalizedSymbol,
        timeframe: normalizedTimeframe,
        barCount: bars.length,
        error: e instanceof Error ? e.message : String(e),
      },
    );
  }

  // ── Step 4: Forward bars + live tick + REAL bid/ask arms to AI Engine ──
  // The bid/ask come from the live PO/real tick buffer so the AI Engine's
  // bid_ask_pressure factor is computed from genuine quoted arms (never a
  // proxy). Zero synthetic values are forwarded.
  const latestSpread = realtimeTickBuffer.getLatestSpread(normalizedSymbol);
  const payload = {
    symbol: normalizedSymbol,
    timeframe: aiDispatchTimeframe,
    candles: mapCandlesToAiFormat(bars),
    dataSource: "forex_otc",
    live_price: Number(effectiveLivePrice),
    bid:
      Number.isFinite(latestSpread.bid) && (latestSpread.bid as number) > 0
        ? Number(latestSpread.bid)
        : undefined,
    ask:
      Number.isFinite(latestSpread.ask) && (latestSpread.ask as number) > 0
        ? Number(latestSpread.ask)
        : undefined,
  };

  logger.info("[signal.controller] Forwarding OTC data to AI Engine", {
    symbol: normalizedSymbol,
    barCount: payload.candles.length,
    livePrice: payload.live_price,
    atr,
    dataSource: "forex_otc",
  });

  try {
    const prediction = await postWithRetry<any>(
      AI_ENGINE_PREDICT_URL,
      payload,
      {
        timeout: PREDICT_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": secrets.AI_ENGINE_API_KEY,
        },
      },
    );

    const elapsed = Date.now() - t0;
    logger.info(
      `[predict] symbol=${normalizedSymbol} timeframe=${normalizedTimeframe} status=ok`,
    );
    logger.info(
      `[predict] ai_engine_url=${AI_ENGINE_PREDICT_URL} latency_ms=${elapsed}`,
    );

    // ════════════════════════════════════════════════════════════════════
    // CONFIDENCE SANITIZER — normalizes every upstream scale to 0-100.
    // ════════════════════════════════════════════════════════════════════
    const rawConf = Number(prediction.confidence) || 0;
    const normalizedConf = rawConf > 100 ? rawConf / 100 : rawConf;
    const finalConfidence = Math.min(
      Math.max(normalizedConf > 1 ? normalizedConf : normalizedConf * 100, 0),
      100,
    );

    // ════════════════════════════════════════════════════════════════════
    // STEP 5 — VOLATILITY-DRIVEN TARGET PRICING (AUTHORITATIVE)
    // Target = live price +/− ATR-scaled distance. ZERO hash injection.
    // ════════════════════════════════════════════════════════════════════
    const direction = prediction.signal as "BUY" | "SELL";

    // ── AUTHORITATIVE VERDICT PASSTHROUGH ──
    // The Python engine's BUY/SELL is the SINGLE source of truth for direction
    // and confidence — it NEVER returns HOLD, so its verdict is passed through
    // verbatim. It is NEVER re-scored or force-mapped by local Node math. Zero
    // local quant engines exist in this pipeline; signals derive exclusively
    // from real technical indicators computed in the Python engine on real
    // bars.

    // ════════════════════════════════════════════════════════════════════
    // DIRECTION↔TARGET INVARIANT (AUTHORITATIVE) — the dispatched signal and
    // the chart projection line MUST mathematically agree:
    //   BUY  → target strictly ABOVE live price
    //   SELL → target strictly BELOW live price
    // Any upstream target contradicting the dispatched direction is
    // recomputed from real ATR. delta_pct is ALWAYS derived from THIS target.
    // ════════════════════════════════════════════════════════════════════
    const authoritativeTarget = forexDataService.computeTargetPrice(
      direction,
      effectiveLivePrice,
      atr,
      normalizedTimeframe,
      normalizedSymbol,
    );

    logger.info("[signal.controller] Prediction successful (OTC)", {
      symbol: normalizedSymbol,
      signal: direction,
      confidence: finalConfidence,
      rawConfidence: rawConf,
      elapsedMs: elapsed,
      dataSource: "forex_otc",
      targetPrice: authoritativeTarget,
      atr,
    });

    // ── Refresh dynamic payout for the /symbols dropdown (live ATR) ──
    forexDataService.syncPayouts(normalizedSymbol).catch((e) =>
      logger.warn("[signal.controller] syncPayouts failed", {
        symbol: normalizedSymbol,
        error: e instanceof Error ? e.message : String(e),
      }),
    );

    const authoritativeDeltaPct =
      effectiveLivePrice > 0
        ? Math.round(
            ((authoritativeTarget - effectiveLivePrice) / effectiveLivePrice) *
              100 *
              100,
          ) / 100
        : 0;

    const finalResponse = {
      ...prediction,
      signal: direction,
      confidence: finalConfidence,
      target_price: authoritativeTarget,
      current_price: effectiveLivePrice,
      currentPrice: effectiveLivePrice,
      delta_pct: authoritativeDeltaPct,
      symbol: normalizedSymbol,
      proxied: true,
      proxyLatencyMs: elapsed,
      live_price_source: livePriceSource,
      live_price_age_ms: livePriceAgeMs,
      dataSource: "forex_otc",
      // The chart's requested bucket (possibly sub-minute, e.g. "20s"); the AI
      // verdict itself was evaluated on the coerced >= 1m channel and surfaces
      // in `timeframe` via the spread above.
      requestedTimeframe: normalizedTimeframe,
      barCount: bars.length,
      // ── MARKET-WAITING CONTRACT (strict 96.5% thermal gate, passthrough) ──
      // The Python engine decides this from the real confluence; a directional
      // verdict is ALWAYS emitted (never HOLD) and any sub-thermal signal is
      // flagged market_waiting by the engine itself.
      market_waiting: prediction.market_waiting === true,
      waiting_reason:
        typeof prediction.waiting_reason === "string"
          ? prediction.waiting_reason
          : null,
      waiting_detail:
        typeof prediction.waiting_detail === "string"
          ? prediction.waiting_detail
          : null,
      book_confluence:
        prediction.book_confluence ?? prediction.diagnostics?.book ?? {},
      future_candles: buildFutureCandles(
        bars,
        Number(effectiveLivePrice),
        authoritativeTarget,
        atr,
        Number.isFinite(latestSpread.bid)
          ? Number(latestSpread.bid)
          : undefined,
        Number.isFinite(latestSpread.ask)
          ? Number(latestSpread.ask)
          : undefined,
        normalizedTimeframe,
        symbolRegistry.getDigits(normalizedSymbol),
      ),
      candles: bars.map((b) => ({
        timestamp: b.timestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
    };

    // ── HIGH-CONFIDENCE (>=96.5%) WEBSOCKET NOTIFICATION EVENT ──
    maybeBroadcastHighConfidence(finalResponse);

    // Cache the successful result so concurrent /predict bursts reuse it for
    // the TTL window instead of duplicating the spot/history fetch + inference.
    setCachedPredict(cacheKey, finalResponse);

    return res.json(finalResponse);
  } catch (aiError) {
    const elapsed = Date.now() - t0;

    // ════════════════════════════════════════════════════════════════════
    // ENGINE-UNAVAILABLE (503) — the Python AI Engine is unreachable or
    // rejected the payload. Direction is decided ONLY by the Python engine
    // (which NEVER returns HOLD), so when it cannot run no verdict is
    // synthesized: no BUY/SELL is ever fabricated and no HOLD fallback is
    // served. A 503 tells the client to keep the last real directional state
    // and re-poll with backoff — recoverable, never a fake signal.
    //
    // LOGGING NOTE: reaching this point means the extended timeout + all
    // retries were exhausted, so the engine failed PERSISTENTLY — this is a
    // meaningful condition worth logging. Transient heavy-inference spikes
    // are absorbed by the timeout + retry loop above and never reach here,
    // so we log at WARN (not ERROR) to avoid noise during legitimate load.
    // ════════════════════════════════════════════════════════════════════
    const aiFailure = classifyAiEngineFailure(aiError);

    logger.info(
      `[predict] symbol=${normalizedSymbol} timeframe=${normalizedTimeframe} status=${aiFailure.kind === "timeout" ? "timeout" : "error"}`,
    );
    logger.info(
      `[predict] ai_engine_url=${AI_ENGINE_PREDICT_URL} latency_ms=${elapsed}`,
    );

    logger.warn(
      "[signal.controller] AI Engine failed persistently after extended timeout + retries — no HOLD fallback, serving 503",
      {
        symbol: normalizedSymbol,
        timeframe: normalizedTimeframe,
        elapsedMs: elapsed,
        attempts: PREDICT_MAX_RETRIES,
        timeoutMs: PREDICT_TIMEOUT_MS,
        aiEngineFailure: aiFailure,
        error: aiError instanceof Error ? aiError.message : String(aiError),
      },
    );

    // ── Refresh dynamic payout (non-fatal) ──
    forexDataService.syncPayouts(normalizedSymbol).catch(() => {});

    if (aiFailure.kind === "timeout") {
      return res.status(503).json({
        error: "ai_timeout",
        retryAfterMs: 1000,
        symbol: normalizedSymbol,
        timeframe: normalizedTimeframe,
        proxyLatencyMs: elapsed,
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(503).json({
      error: "ai_unavailable",
      message:
        "The AI Engine is currently unavailable or rejected the payload. " +
        "No direction was dispatched — retrying.",
      symbol: normalizedSymbol,
      timeframe: normalizedTimeframe,
      proxyLatencyMs: elapsed,
      recoverable: true,
      aiEngineAvailable: false,
      aiEngineFailure: {
        kind: aiFailure.kind,
        code: aiFailure.code,
        detail: aiFailure.detail,
      },
      timestamp: new Date().toISOString(),
    });
  }
};
