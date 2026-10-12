import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { AI_ENGINE_HTTP_AGENT } from "../utils/aiEngineHttp";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";
import { symbolRegistry } from "../services/symbolRegistry.service";
import { forexDataService, ForexCandle } from "../services/forexData.service";
import { websocketService } from "../services/websocket.service";
import { realtimeTickBuffer } from "../services/realtimeTickBuffer.service";
import {
  engineCircuitOpen,
  recordEngineFailure,
  recordEngineSuccess,
} from "../lib/engineCircuitBreaker";
import { clampMinTierToEngineSet, readMinTier } from "../lib/signalTiers";
import type { SignalTier } from "../lib/signalTiers";
import { isAlertEligible } from "../lib/alertGate";

const prisma = new PrismaClient();

// ── Constants ──
const MINIMUM_REQUIRED_BARS = 30;
const MINIMUM_FAST_PATH_BARS = 2;

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
 *  Mirrors the AI Engine's ALERT threshold. Since v12 the AI Engine's
 *  `high_confidence_alert` fires on an organically converged DEFINITIVE
 *  (>=98%) 10-book verdict (no secondary pathway, no dynamic floor), the
 *  priority toast threshold is locked to that same 98% thermal gate. */
export const HIGH_CONFIDENCE_THRESHOLD = 98.0;

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

// ════════════════════════════════════════════════════════════════════
// LAST-GOOD PREDICTION FALLBACK (STALE-WHILE-UNAVAILABLE)
// ════════════════════════════════════════════════════════════════════
// Distinct from the 5s dedupe cache: persists the LAST REAL successful engine
// verdict per (symbol, timeframe) so that when the engine exceeds its budget
// on a heavy high-precision evaluation (or is briefly unavailable) the
// endpoint serves that real verdict — clearly stamped `stale` — instead of a
// hard 503. It NEVER fabricates a signal: it only reuses an actually-computed
// prior result, and the client keeps its last real directional state. TTL
// tunable via env AI_ENGINE_LAST_GOOD_TTL_MS (default 60s, floor 15s).
const LAST_GOOD_TTL_MS = Math.max(
  15_000,
  Number(process.env.AI_ENGINE_LAST_GOOD_TTL_MS) || 60_000,
);
const lastGoodCache = new Map<
  string,
  { expiresAt: number; servedAt: string; response: unknown }
>();
export function getLastGoodPredict(
  key: string,
): { servedAt: string; response: unknown } | null {
  const hit = lastGoodCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    lastGoodCache.delete(key);
    return null;
  }
  return { servedAt: hit.servedAt, response: hit.response };
}
export function setLastGoodPredict(key: string, response: unknown): void {
  lastGoodCache.set(key, {
    expiresAt: Date.now() + LAST_GOOD_TTL_MS,
    servedAt: new Date().toISOString(),
    response,
  });
}

/**
 * SINGLE SOURCE OF TRUTH for the /predict result-cache + last-good identity.
 *
 * Every dimension that changes the engine's VERDICT must appear here, otherwise
 * one evaluation is served for a different request:
 *   • symbol + timeframe  — the evaluation itself
 *   • min_confidence      — the Confidence Filter's executable verdict
 *   • horizon_minutes     — the operator's selected expiry (the Pro Expiry Bar)
 *
 * Exported so callers/tests can never drift from the controller's own key.
 */
export function buildPredictCacheKey(
  symbol: string,
  timeframe: string,
  minConfidence: number | null,
  horizonMinutes: number | null,
  minTier: SignalTier | null = null,
): string {
  // `min_tier` is part of the identity for the same reason `min_confidence`
  // is: the tier floor decides which bands are executable, so a request for T4
  // must never be served a verdict evaluated under the T1 default bar.
  return `${String(symbol).trim().toLowerCase()}::${timeframe}::mc${
    minConfidence ?? "default"
  }::hz${horizonMinutes ?? "default"}::mt${minTier ?? "default"}`;
}

// ════════════════════════════════════════════════════════════════════
// STALE RE-ARM — SAFETY BOUNDS (executable ONLY under safe volatility)
// ════════════════════════════════════════════════════════════════════
// When serving the last-good verdict after an engine outage, the stale
// verdict is restored as EXECUTABLE only when the market is demonstrably
// inside safe bounds computed from FRESH bars on THIS request:
//   • price drift vs the last-good current_price within
//     STALE_REARM_MAX_PRICE_DRIFT_PCT (0.25%) — the market hasn't moved
//     away from the verdict's base price;
//   • realized ATR (fresh Wilder, % of price) below
//     STALE_REARM_MAX_ATR_PCT (0.8%) — no volatility burst;
// Outside those bounds (or when ATR/price can't be verified) the stale verdict
// is served but NOT re-armed (executable=false, stamped with the reason) — a
// real directional result is still honored, only its tradability is withheld.
const STALE_REARM_MAX_PRICE_DRIFT_PCT = Math.max(
  0.05,
  Number(process.env.AI_ENGINE_STALE_MAX_DRIFT_PCT) || 0.25,
);
const STALE_REARM_MAX_ATR_PCT = Math.max(
  0.1,
  Number(process.env.AI_ENGINE_STALE_MAX_ATR_PCT) || 0.8,
);

export interface StaleSafetyReport {
  safe: boolean;
  priceDriftPct: number;
  atrPct: number;
  reasons: string[];
}

/** Compute whether the CURRENT market is inside the safe re-arm bounds. */
export function buildStaleSafetyReport(
  lastGood: { response: unknown } | null,
  livePrice: number | null | undefined,
  atr: number,
): StaleSafetyReport {
  const reasons: string[] = [];
  let priceDriftPct = 0;
  let atrPct = 0;
  const good = (lastGood?.response ?? null) as Record<string, unknown> | null;
  const goodPrice =
    good && typeof good.current_price === "number" ? good.current_price : null;

  if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) {
    reasons.push("no_live_price");
  } else if (goodPrice && goodPrice > 0) {
    priceDriftPct = (Math.abs(livePrice - goodPrice) / goodPrice) * 100;
    if (priceDriftPct > STALE_REARM_MAX_PRICE_DRIFT_PCT) {
      reasons.push("price_drift_exceeds_bounds");
    }
  } else {
    reasons.push("no_last_good_price");
  }

  if (atr > 0 && livePrice && Number.isFinite(livePrice) && livePrice > 0) {
    atrPct = (atr / livePrice) * 100;
    if (atrPct > STALE_REARM_MAX_ATR_PCT) {
      reasons.push("volatility_exceeds_safe_bounds");
    }
  } else {
    // Cannot verify volatility safety → don't re-arm (conservative).
    reasons.push("atr_unavailable");
  }

  return {
    safe: reasons.length === 0,
    priceDriftPct: Number(priceDriftPct.toFixed(4)),
    atrPct: Number(atrPct.toFixed(4)),
    reasons,
  };
}

export function buildStaleFallbackPayload(
  cacheKey: string,
  errorKind: string,
  elapsedMs: number,
  aiFailure: AiEngineFailure,
  safety?: StaleSafetyReport,
): Record<string, unknown> | null {
  const lastGood = getLastGoodPredict(cacheKey);
  if (!lastGood) return null;
  const body = { ...(lastGood.response as Record<string, unknown>) };
  const executableBefore = body.executable === true;
  const directional = typeof body.signal === "string" && body.signal !== "HOLD";
  const safeBounded = safety?.safe === true;
  const rearmed = safeBounded && executableBefore && directional;
  if (rearmed) {
    body.executable = true;
  } else if (executableBefore) {
    // Honest demotion: the last-good verdict was tradable when fresh, but the
    // current market is outside the verified safety bounds so it is NOT.
    body.executable = false;
    body.regime_gate = "pending_high_precision";
    body.suppressed_reason = "stale_market_out_of_safety_bounds";
  }
  return {
    ...body,
    error: errorKind,
    stale: true,
    stale_at: lastGood.servedAt,
    recoverable: true,
    retryAfterMs: 1000,
    aiEngineAvailable: false,
    aiEngineFailure: {
      kind: aiFailure.kind,
      code: aiFailure.code,
      detail: aiFailure.detail,
    },
    fallback: {
      stale: true,
      bounded: safeBounded,
      rearmed_executable: rearmed,
      price_drift_pct: safety?.priceDriftPct ?? null,
      atr_pct: safety?.atrPct ?? null,
      safety_bounds: {
        max_price_drift_pct: STALE_REARM_MAX_PRICE_DRIFT_PCT,
        max_atr_pct: STALE_REARM_MAX_ATR_PCT,
      },
    },
    proxyLatencyMs: elapsedMs,
    timestamp: new Date().toISOString(),
  };
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
  if (
    typeof err === "object" &&
    err != null &&
    (err as { isCircuitOpen?: boolean }).isCircuitOpen === true
  ) {
    return {
      kind: "unreachable",
      code: "CIRCUIT_OPEN",
      detail:
        "Circuit breaker open — AI Engine recently failed repeatedly; fallback served without re-attempting.",
    };
  }
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

/**
 * PART 32.5a [262] — connection failures that are DEFINITIVE rather than
 * transient: nothing is listening on the engine's port, so the destination
 * cannot answer. ECONNREFUSED in particular is NOT "still starting up" — a
 * booting engine already has its socket bound and answers with HTTP 503 (which
 * is retried below as a 5xx). A refused connection means the process is not
 * there at all, and re-dialling it inside one request window cannot change
 * that, so every retry was pure latency.
 */
const DEFINITIVE_ENGINE_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** True when a downstream AI-Engine failure is TRANSIENT (worth a retry):
 *  no HTTP response at all (timeout/network), 429 rate-limit, or any 5xx —
 *  including the 503 the engine returns while starting up. 4xx validation
 *  errors are permanent and never retried, and neither are the definitive
 *  "nothing is listening" codes above.
 *
 *  PART 32.5a [262]: a dead engine used to match the blanket `!err.response`
 *  rule and burn the whole retry ladder. Measured cost with :8000 down —
 *  3 attempts + 500ms/1000ms backoff = 12,280ms of stall on EVERY page load,
 *  because /predict is called on mount. Retrying only what can actually clear
 *  makes an offline engine fail in well under a second, and the breaker records
 *  the refusal so later calls short-circuit for the whole cooldown window. */
export function isTransientAiFailure(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  if (!err.response) {
    if (DEFINITIVE_ENGINE_CONNECTION_CODES.has(err.code || "")) return false;
    return true;
  }
  return status === 429 || (status != null && status >= 500);
}

export async function postWithRetry<T>(
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
// ── AI Engine timeout + retry budget ──
// Wired from secrets (env AI_ENGINE_TIMEOUT_MS / AI_ENGINE_MAX_RETRIES) so the
// strict high-precision 96.5% pipeline — the OTC HF filter plus the REAL
// liquidity gate (spread-to-ATR margin, order-flow, M1/M5/H1 proxies) and the
// per-symbol RandomForest corroboration — gets a real inference budget. The
// previous hard 3s / 1-retry ceiling reproduced as 503 { ai_timeout } on cold
// RF fits and multi-predict fan-out (engine CPU pool is small). The secrets.ts
// contract forbids budgets below 15s, so we floor there and let operators tune
// per-env via AI_ENGINE_TIMEOUT_MS / AI_ENGINE_MAX_RETRIES. A timing-out
// request is still classified `ai_timeout` and surfaced as JSON
// { error: "ai_timeout", retryAfterMs } — the client re-polls with exponential
// backoff (see the stale-while-unavailable fallback below), never a bare 503.
const PREDICT_TIMEOUT_MS = Math.max(
  15_000,
  Number(secrets.AI_ENGINE_TIMEOUT_MS) || 120_000,
);
const PREDICT_MAX_RETRIES = Math.max(
  1,
  Math.floor(Number(secrets.AI_ENGINE_MAX_RETRIES) || 3),
);

// ── ENGINE TIMEFRAME CLAMP (validation-bridge parity) ──
// The engine's Pydantic whitelist only accepts a closed set of buckets
// (1m … 35m+, 1h, 4h, 1d … 10d). The chart grid can legitimately ask for
// buckets outside that set on the DISPATCH channel (e.g. "40m", "45m"); a raw
// forward would be rejected by strict validation (engine maps it to HTTP 400)
// which the integration layer classifies permanent → 503 ai_unavailable.
// Clamp the AI-dispatch channel to the nearest valid bucket (same idea as the
// sub-minute → "1m" bridge) while `requestedTimeframe` stays untouched for the
// response and ATR-target scaling.
const ENGINE_VALID_TIMEFRAMES = new Set([
  "1m", "2m", "3m", "5m", "10m", "15m", "20m", "25m", "30m", "35m+",
  "1h", "4h", "1d", "2d", "3d", "5d", "10d",
]);
export function clampToEngineTimeframe(timeframe: string): string {
  const t = String(timeframe || "1m").toLowerCase();
  if (ENGINE_VALID_TIMEFRAMES.has(t)) return t;
  if (t === "35m") return "35m+";
  const minutes = /^(\d+)m\+?$/.exec(t);
  if (minutes) {
    const m = Number(minutes[1]);
    if (m >= 35) return "35m+";
    // Smallest valid bucket covering the requested minutes (never undershoots
    // the horizon so ATR scaling stays conservative).
    for (const bucket of ["1m", "2m", "3m", "5m", "10m", "15m", "20m", "25m", "30m"]) {
      if (Number(bucket.replace("m", "")) >= m) return bucket;
    }
    return "30m";
  }
  const hours = /^(\d+)h$/.exec(t);
  if (hours) {
    const h = Number(hours[1]);
    if (h >= 24) return "1d";
    if (h >= 4) return "4h";
    return "1h";
  }
  const days = /^(\d+)d$/.exec(t);
  if (days) {
    const d = Number(days[1]);
    for (const bucket of ["1d", "2d", "3d", "5d", "10d"]) {
      if (Number(bucket.replace("d", "")) >= d) return bucket;
    }
    return "10d";
  }
  return "1m";
}

// ── USER MIN-CONFIDENCE CLAMP (dashboard Confidence Filter bridge) ──
// The client can send an optional `minConfidence` (the Confidence Filter,
// 50..99%) that overrides the engine's default 96.5% executable bar. The
// engine's Pydantic schema enforces 50..99 via ge/le → out-of-range maps to
// HTTP 400 (classified permanent → 503). Clamping here keeps integration
// resilient while the engine floors the effective bar at T4 (70%) itself.
const MIN_CONFIDENCE_LOW = 50;
const MIN_CONFIDENCE_HIGH = 99;
export function clampMinConfidenceToEngineRange(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MIN_CONFIDENCE_HIGH, Math.max(MIN_CONFIDENCE_LOW, n));
}

// ── USER HORIZON CLAMP (Pro Terminal expiry bridge) ──
// The client sends the Pro Expiry Bar selection as `horizon_minutes` (snake,
// the field the engine's PredictRequest declares) and the inference bridge
// accepts `horizonMinutes` (camel). BOTH are accepted here: the browser client
// has always spoken snake_case, so a camelCase-only destructure silently
// dropped the operator's chosen expiry and the engine fell back to its
// `resolve_horizon_minutes(None)` default of 1 minute for EVERY request — which
// is why switching expiries appeared to do nothing.
//
// This mirrors the engine's resolve_horizon_minutes() (ai-engine/app/services/
// horizon_engine.py) exactly, including its floor bias on ties, so the cache
// identity and the forwarded payload always agree with what the engine will
// actually evaluate. `null` means "no usable selection": the request is not
// constrained here and the engine applies its own default.
const HORIZON_OPTIONS_MINUTES = [1, 2, 3, 5, 10] as const;
export function clampHorizonMinutesToEngineRange(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Floor-biased nearest step: an unsupported 4m resolves to 3m, never 5m.
  return HORIZON_OPTIONS_MINUTES.reduce((best, opt) =>
    Math.abs(opt - n) < Math.abs(best - n) ? opt : best,
  );
}

/** Reads the horizon from either the engine's snake_case or the bridge's camelCase key. */
export function readHorizonMinutes(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  return clampHorizonMinutesToEngineRange(
    b.horizon_minutes ?? b.horizonMinutes,
  );
}

/** Reads the min-confidence from either the engine's snake_case or the bridge's camelCase key. */
export function readMinConfidence(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  return clampMinConfidenceToEngineRange(b.min_confidence ?? b.minConfidence);
}

/**
 * The canonical T1..T5 ladder now lives in `lib/signalTiers.ts` so the 1Hz
 * `/tick-signal` forwarder and the controllers share one definition. Re-exported
 * here to keep this module's existing public surface stable.
 */
export {
  VALID_SIGNAL_TIERS,
  clampMinTierToEngineSet,
  readMinTier,
} from "../lib/signalTiers";
export type { SignalTier } from "../lib/signalTiers";

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
 * confidence crosses the 98% DEFINITIVE thermal gate (HIGH_CONFIDENCE_THRESHOLD,
 * aligned with the AI Engine's organic 10-book verdict). The frontend renders a
 * priority toast with an alert sound on receipt of `high_confidence_signal`.
 */
function maybeBroadcastHighConfidence(prediction: {
  symbol?: string;
  signal?: string;
  confidence?: number;
  target_price?: number;
  current_price?: number;
  timeframe?: string;
  market_waiting?: boolean;
  executable?: boolean;
  tier?: string | null;
  regime_gate?: string | null;
}) {
  try {
    const conf = Number(prediction.confidence);
    if (
      Number.isFinite(conf) &&
      conf >= HIGH_CONFIDENCE_THRESHOLD &&
      prediction.signal &&
      prediction.market_waiting !== true &&
      // PART 41 [403] — a 98% score on a GATED verdict is not an alert. Only an
      // actually-executable high-precision signal may ring the bell.
      isAlertEligible(prediction)
    ) {
      websocketService.broadcastHighConfidenceSignal({
        symbol: String(prediction.symbol ?? ""),
        signalType: prediction.signal as "BUY" | "SELL",
        confidence: conf,
        price: Number(prediction.current_price ?? 0),
        targetPrice: Number(prediction.target_price ?? 0),
        timeframe: String(prediction.timeframe ?? "1d"),
        timestamp: new Date().toISOString(),
        executable: prediction.executable,
        tier: prediction.tier,
        regime_gate: prediction.regime_gate,
      });
    }
  } catch (e) {
    logger.warn("[signal.controller] High-confidence broadcast failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── Signal CRUD ──
/**
 * Distinguish "the database is unreachable" from "the query failed". A DB
 * outage is a RECOVERABLE infrastructure condition (503 + retry), not a bug in
 * the request (500). Prisma surfaces it as a known error code, an
 * initialization error, or a connection-level message — all of which mean the
 * caller should retry, never that the API is broken.
 */
function isDbUnavailable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code && ["P1001", "P1008", "P1017", "P2024"].includes(code)) return true;
  const name = (error as { name?: string } | null)?.name;
  if (name === "PrismaClientInitializationError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /can'?t reach database server|connection (pool|refused)|Timed out fetching a new connection|ECONNREFUSED (?:127\.0\.0\.1|localhost|::1):5433/i.test(
    message,
  );
}

/**
 * Redis/cache outages are a SEPARATE recoverable condition from a DB outage.
 * ioredis surfaces them as `MaxRetriesPerRequestError` / `ReplyError`, an
 * `NR_CLOSED` code, or a connection message naming Redis — all of which mean
 * "cache unavailable", never "database unavailable". Checked BEFORE the DB
 * classifier because a refused Redis connection carries a bare ECONNREFUSED.
 */
function isCacheUnavailable(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (
    /redis/i.test(name) ||
    name === "MaxRetriesPerRequestError" ||
    name === "ReplyError"
  ) {
    return true;
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "NR_CLOSED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /redis|MaxRetriesPerRequest|Stream isn'?t writeable|ECONNREFUSED .*:6379/i.test(
    message,
  );
}

export const getSignals = async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const { symbol, limit = "50" } = req.query;
    const signals = await prisma.signal.findMany({
      where: symbol ? { symbol: String(symbol) } : {},
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit), 100),
    });
    logger.info(`[signals] status=200 latency_ms=${Date.now() - t0}`);
    return res.json(signals);
  } catch (error) {
    const latencyMs = Date.now() - t0;
    if (isCacheUnavailable(error)) {
      logger.error(
        `[signals] status=503 cache_unavailable latency_ms=${latencyMs}`,
        { error: error instanceof Error ? error.message : String(error) },
      );
      return res.status(503).json({ error: "cache_unavailable" });
    }
    if (isDbUnavailable(error)) {
      logger.error(
        `[signals] status=503 db_unavailable latency_ms=${latencyMs}`,
        { error: error instanceof Error ? error.message : String(error) },
      );
      return res.status(503).json({ error: "db_unavailable" });
    }
    logger.error(`[signals] status=500 latency_ms=${latencyMs}`, { error });
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

export const getSignalById = async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const { id } = req.params;
    const signal = await prisma.signal.findUnique({ where: { id } });
    if (!signal) return res.status(404).json({ error: "Signal not found" });
    return res.json(signal);
  } catch (error) {
    const latencyMs = Date.now() - t0;
    if (isCacheUnavailable(error)) {
      logger.error(
        `[signals] status=503 cache_unavailable latency_ms=${latencyMs}`,
        { error: error instanceof Error ? error.message : String(error) },
      );
      return res.status(503).json({ error: "cache_unavailable" });
    }
    if (isDbUnavailable(error)) {
      logger.error(
        `[signals] status=503 db_unavailable latency_ms=${latencyMs}`,
        { error: error instanceof Error ? error.message : String(error) },
      );
      return res.status(503).json({ error: "db_unavailable" });
    }
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// ── Prediction Pipeline ──
export const predictSignal = async (req: Request, res: Response) => {
  const { symbol, timeframe, silent, minConfidence, min_confidence } =
    req.body as {
      symbol?: string;
      timeframe?: string;
      /** Batch-suppression flag: `/multi-predict` sets it so a 34-symbol grid
       *  refresh never fires 34 global high-confidence toasts. Single /predict
       *  callers leave it unset and keep the existing toast behavior. */
      silent?: boolean;
      /** Confidence Filter: user-set minimum executable confidence (50..99%).
       *  Clamped to the engine range; absent = engine default 96.5% bar. */
      minConfidence?: unknown;
      /** Engine-native snake_case alias — what the browser client actually sends. */
      min_confidence?: unknown;
    };

  if (!symbol || typeof symbol !== "string" || symbol.trim().length === 0) {
    logger.info("[predict] symbol=missing tf=unknown status=error");
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
      `[predict] symbol=${symbol.trim()} tf=missing status=error`,
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
  const minConfidenceClamped = clampMinConfidenceToEngineRange(
    minConfidence ?? min_confidence,
  );
  // Flexible-tier floor. Absent/garbage → null → the engine's own T1 default.
  const minTierClamped = readMinTier(req.body);
  // The Pro Expiry Bar selection. Absent → null → the engine keeps its own
  // default; present → snapped onto the engine's supported set so the cache
  // identity and the forwarded payload match the evaluated horizon.
  const horizonMinutesClamped = readHorizonMinutes(req.body);
  const t0 = Date.now();

  // ════════════════════════════════════════════════════════════════════
  // STEP 0 — STRICT OTC WHITELIST ENFORCEMENT (single boundary check)
  // ════════════════════════════════════════════════════════════════════
  if (!symbolRegistry.isValidSymbolSync(normalizedSymbol)) {
    logger.warn("[signal.controller] Non-whitelisted symbol rejected", {
      symbol: normalizedSymbol,
    });
    logger.info(
      `[predict] symbol=${normalizedSymbol} tf=${normalizedTimeframe.toLowerCase()} status=error`,
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
  // Clamp any bucket outside the engine's Pydantic whitelist to the nearest
  // valid dispatch bucket (the response still reports the real
  // `requestedTimeframe`). Prevents strict-validation HTTP 400s → 503 ai_unavailable.
  const engineDispatchTimeframe = clampToEngineTimeframe(aiDispatchTimeframe);
  const desiredBars = TIMEFRAME_DESIRED_BARS[tfNormalized] || 200;

  // ── RESULT CACHE (5s TTL) — concurrent /predict bursts share one result ──
  // The Confidence Filter AND the target-expiry horizon both ride the cache
  // identity: switching either is a DISTINCT evaluation (never a stale
  // same-key hit). Without the horizon segment a 3m request could be served a
  // 5m verdict from inside the 5s TTL, so the button appeared inert.
  const cacheKey = buildPredictCacheKey(
    normalizedSymbol,
    tfNormalized,
    minConfidenceClamped,
    horizonMinutesClamped,
    minTierClamped,
  );
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
      .getHistoricalCandles(normalizedSymbol, engineDispatchTimeframe, desiredBars)
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
  // A HELD print (last known good, re-pended for continuity while every source
  // is exhausted) is never a live quote. Its own timestamp is recent by
  // construction, so the age gate alone would wave it through — the explicit
  // stale stamp is what keeps analysis off a cold feed.
  const tickIsStale = tickEntry?.stale === true;

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
    !tickIsStale &&
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
        liveTickStale: tickIsStale,
        spotSource: spotResult.source,
        spotPresent: spotResult.success,
      },
    );
    logger.info(
      `[predict] symbol=${normalizedSymbol} tf=${tfNormalized} status=error`,
    );
    return res.status(503).json({
      error: "Awaiting real-time tick",
      symbol: normalizedSymbol,
      message: tickIsStale
        ? "Holding the last known good price while every live source is exhausted — signal generation stays paused until a fresh real-time tick arrives."
        : tickAgeMs != null
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
    } else if (buffered.length >= MINIMUM_FAST_PATH_BARS) {
      // ── MICRO-QUANT FAST PATH ──
      // Enough real bars for a fast-path micro-quant verdict (2+ bars) but not
      // enough for the full ML pipeline. Forward to the AI engine which will
      // run evaluate_live_tick_signal instead of the full confluence+ML path.
      logger.info(
        "[signal.controller] Micro-quant fast path — forwarding real bars to AI engine",
        {
          symbol: normalizedSymbol,
          realBars: bars.length,
          bufferedBars: buffered.length,
          fastPathMinimum: MINIMUM_FAST_PATH_BARS,
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
        `[predict] symbol=${normalizedSymbol} tf=${tfNormalized} status=error`,
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
    timeframe: engineDispatchTimeframe,
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
    // Confidence Filter: absent → engine default 96.5% executable bar.
    ...(minConfidenceClamped !== null
      ? { min_confidence: minConfidenceClamped }
      : {}),
    // Flexible-tier floor: absent → engine default T1. When present the engine
    // still emits EVERY computed tier (T1..T5) and only changes which ones are
    // marked executable for this request.
    ...(minTierClamped !== null ? { min_tier: minTierClamped } : {}),
    // Target-expiry horizon: absent → the engine's resolve_horizon_minutes
    // default. When the operator HAS chosen an expiry it is forwarded verbatim,
    // so the verdict, the lock identity and the TGT/ANC on screen all belong to
    // the selected horizon. This is the field whose absence made every expiry
    // button behave identically (the engine always evaluated 1m).
    ...(horizonMinutesClamped !== null
      ? { horizon_minutes: horizonMinutesClamped }
      : {}),
  };

  logger.info("[signal.controller] Forwarding OTC data to AI Engine", {
    symbol: normalizedSymbol,
    barCount: payload.candles.length,
    livePrice: payload.live_price,
    atr,
    dataSource: "forex_otc",
    horizonMinutes: horizonMinutesClamped ?? "engine-default",
  });

  try {
    // ── CIRCUIT BREAKER — never re-attempt a persistently failing engine ──
    // Open circuit → fail fast into the stale-while-unavailable / 503 path
    // below (no timeout, no retry storm against a down service).
    if (engineCircuitOpen(AI_ENGINE_PREDICT_URL)) {
      throw Object.assign(new Error("AI Engine circuit open"), {
        code: "CIRCUIT_OPEN",
        isCircuitOpen: true,
      });
    }
    const prediction = await postWithRetry<any>(
      AI_ENGINE_PREDICT_URL,
      payload,
      {
        timeout: PREDICT_TIMEOUT_MS,
        httpAgent: AI_ENGINE_HTTP_AGENT,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": secrets.AI_ENGINE_API_KEY,
        },
      },
    );

    const elapsed = Date.now() - t0;
    logger.info(
      `[predict] symbol=${normalizedSymbol} tf=${tfNormalized} status=ok latency_ms=${elapsed}`,
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

    // ════════════════════════════════════════════════════════════════════
    // STRICT PASS-THROUGH (2026-09-24): the Python engine OWNS the strict
    // 96.5% execution gate (signal_gatekeeper.MIN_EXECUTABLE_TIER = T1) and
    // the dual-regime filters (OTC HF / REAL liquidity). The core-backend
    // integration layer is a pure pass-through of the engine's executable /
    // regime_gate / regime_status / suppressed_reason fields — sub-96.5%
    // verdicts stay SCORED-ONLY (executable=false,
    // regime_gate="pending_high_precision"). The GLOBAL_FORCE_OVERRIDE stamp
    // (LIVE-TEST 2026-09-23) and the engine-side escape hatch it referred to
    // have both been removed outright: it stamped tradable/executable onto
    // every verdict and could only fabricate actionability. There is no env
    // var that re-enables it, in either service.
    // ════════════════════════════════════════════════════════════════════

    // ── HIGH-CONFIDENCE (>=60%) WEBSOCKET NOTIFICATION EVENT ──
    // Suppressed in batch (/multi-predict) mode so a grid horizon change never
    // spams 34 priority toasts — the terminal surfaces verdicts in-card.
    if (!silent) {
      maybeBroadcastHighConfidence(finalResponse);
    }

    // Cache the successful result so concurrent /predict bursts reuse it for
    // the TTL window instead of duplicating the spot/history fetch + inference.
    setCachedPredict(cacheKey, finalResponse);
    // Also persist the LAST-GOOD real verdict for the stale-while-unavailable
    // fallback (served when the engine later exceeds its inference budget).
    setLastGoodPredict(cacheKey, finalResponse);
    // Success closes the circuit (half-open probe → closed).
    recordEngineSuccess(AI_ENGINE_PREDICT_URL);

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
    // A TRANSIENT failure nudges the circuit breaker OPEN; once the breaker
    // threshold is crossed the engine is not re-attempted until the cooldown
    // elapses (half-open probe) — the 503 storm is converted into fast
    // stale-while-unavailable responses.
    //
    // LOGGING NOTE: reaching this point means the extended timeout + all
    // retries were exhausted, so the engine failed PERSISTENTLY — this is a
    // meaningful condition worth logging. Transient heavy-inference spikes
    // are absorbed by the timeout + retry loop above and never reach here,
    // so we log at WARN (not ERROR) to avoid noise during legitimate load.
    // ════════════════════════════════════════════════════════════════════
    const aiFailure = classifyAiEngineFailure(aiError);

    if (aiFailure.kind === "unreachable" || aiFailure.kind === "timeout") {
      recordEngineFailure(AI_ENGINE_PREDICT_URL);
    }
    if (
      aiFailure.kind === "http" &&
      (aiFailure.status === 429 || aiFailure.status >= 500)
    ) {
      recordEngineFailure(AI_ENGINE_PREDICT_URL);
    }

    const latency = Date.now() - t0;
    logger.info(
      `[predict] symbol=${normalizedSymbol} tf=${tfNormalized} status=${aiFailure.kind === "timeout" ? "timeout" : "error"} latency_ms=${latency}`,
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

    // ════════════════════════════════════════════════════════════════════
    // STALE-WHILE-UNAVAILABLE FALLBACK — a heavy high-precision (96.5% gate)
    // evaluation that exceeds its budget (or a briefly unresponsive engine)
    // NEVER yields a bare 503 when a REAL prior verdict exists for this pair:
    // that verdict is served, stamped stale:true, with the engine-failure
    // diagnostics + retryAfterMs so the client keeps its last real directional
    // state and re-polls. Only when no real verdict has ever been computed for
    // this (symbol, timeframe) is a structured 503 served.
    // ════════════════════════════════════════════════════════════════════
    if (aiFailure.kind === "timeout") {
      const stale = buildStaleFallbackPayload(
        cacheKey,
        "ai_timeout",
        elapsed,
        aiFailure,
        buildStaleSafetyReport(
          getLastGoodPredict(cacheKey),
          effectiveLivePrice,
          atr,
        ),
      );
      if (stale) {
        logger.warn(
          "[signal.controller] AI Engine timed out — serving last-good stale prediction",
          { symbol: normalizedSymbol, timeframe: normalizedTimeframe },
        );
        return res
          .setHeader(
            "Cache-Control",
            "private, max-age=5, stale-while-revalidate=30",
          )
          .json(stale);
      }
      return res.status(503).json({
        error: "ai_timeout",
        retryAfterMs: 1000,
        symbol: normalizedSymbol,
        timeframe: normalizedTimeframe,
        proxyLatencyMs: elapsed,
        timestamp: new Date().toISOString(),
      });
    }

    const stale = buildStaleFallbackPayload(
      cacheKey,
      "ai_unavailable",
      elapsed,
      aiFailure,
      buildStaleSafetyReport(
        getLastGoodPredict(cacheKey),
        effectiveLivePrice,
        atr,
      ),
    );
    if (stale) {
      logger.warn(
        "[signal.controller] AI Engine unavailable — serving last-good stale prediction",
        { symbol: normalizedSymbol, timeframe: normalizedTimeframe },
      );
      return res
        .setHeader(
          "Cache-Control",
          "private, max-age=5, stale-while-revalidate=30",
        )
        .json(stale);
    }

    return res.status(503).json({
      error: "ai_unavailable",
      detail: aiFailure.detail,
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

// ════════════════════════════════════════════════════════════════════
// MULTI-PREDICT — POST /api/v1/multi-predict
// ════════════════════════════════════════════════════════════════════
// The market-terminal grid's heavier "refresh on horizon change" channel.
// Fans a symbol batch (e.g. all 34 pairs at a new horizon) through the EXACT
// same /predict pipeline via a minimal Express shim — every freshness gate,
// the 5s result cache, ATR targeting and the real-tape fallbacks apply
// identically, and the shared cache collapses duplicates against single /predict
// calls from other surfaces. `silent: true` is injected so a 34-card refresh
// never fires 34 global high-confidence toasts.
//
// Concurrency is BOUNDED: the grid must not storm the AI Engine the way 44
// parallel clients would. Duplicate work already made impossible by the 5s
// cache — this pool only bounds truly fresh computations.
// ════════════════════════════════════════════════════════════════════
// PART 40 [395] — the batch cap MUST cover the whole strict-44 universe
// (symbolRegistry.service.ts: the client grid sends ALL_MARKET_SYMBOLS = the
// 44 canonical instruments). A cap below 44 rejected every grid refresh with
// "symbols is limited to 40 instruments", so the cards could never receive
// the engine's regime_gate/suppressed_reason and fell back to "awaiting".
const MULTI_PREDICT_MAX_SYMBOLS = 44;
const MULTI_PREDICT_CONCURRENCY = 6;

type SymbolPredictOutcome = {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: unknown;
};

/**
 * Run the shared /predict pipeline for ONE symbol by driving the existing
 * `predictSignal` handler through a minimal req/res shim. Reusing the real
 * handler (rather than copying its ~580-line body) guarantees the multi-feed
 * is byte-for-byte based on the same gates, cache and verdict contract.
 */
function shimPredict(
  symbol: string,
  timeframe: string,
  minConfidenceClamped?: number | null,
  horizonMinutesClamped?: number | null,
  minTierClamped?: SignalTier | null,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const shimRes = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {
        return this;
      },
      json(body: unknown) {
        resolve({ status: this.statusCode, body });
      },
    };
    const shimReq = {
      body: {
        symbol,
        timeframe,
        silent: true,
        // Confidence Filter rides the shared pipeline (clamped per-request
        // inside predictSignal, absent → engine default 96.5% bar).
        ...(minConfidenceClamped != null ? { minConfidence: minConfidenceClamped } : {}),
        // The flexible-tier floor rides the same shared pipeline, so a grid
        // refresh honours the trader's selected band on every cell.
        ...(minTierClamped != null ? { min_tier: minTierClamped } : {}),
        // Same for the target-expiry horizon, so a grid refresh at 3m is a
        // distinct evaluation per symbol rather than a re-run of 1m.
        ...(horizonMinutesClamped != null
          ? { horizon_minutes: horizonMinutesClamped }
          : {}),
      },
    };
    Promise.resolve(predictSignal(shimReq as unknown as Request,
      shimRes as unknown as Response)).catch((err: unknown) => {
      resolve({
        status: 500,
        body: {
          error: "internal",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
  });
}

// ── PART 41 [401c] — MODEL PRE-WARM (faster the HONEST way) ──
// Pre-warm engine models for the symbols in use so the FIRST client batch is a
// cache hit instead of an 8–24s cold model train. Rules, per the PART 41 hard
// rule:
//   • bounded concurrency — a boot storm is worse than no warmup;
//   • EVERY run is `silent` — a warmup verdict can NEVER ring the high-
//     confidence alert/toast ([403] gate stays authoritative on the wire);
//   • observable — per-symbol latency_ms is logged so cold-vs-warm is
//     measurable ([400]); failures are tolerated, warmup is never a boot
//     dependency and never loosens a gate.
export const PREDICT_WARM_UP_CONCURRENCY = 3;
export const PREDICT_WARM_UP_DELAY_MS = 800;

export async function warmUpModels(
  symbols: string[],
  options: { concurrency?: number; delayMs?: number } = {},
): Promise<{ warmed: number; skipped: number }> {
  const concurrency = Math.min(
    6,
    Math.max(1, options.concurrency ?? PREDICT_WARM_UP_CONCURRENCY),
  );
  const delayMs = Math.max(0, options.delayMs ?? PREDICT_WARM_UP_DELAY_MS);
  const queue = symbols.filter((s) => typeof s === "string" && s.trim());
  let cursor = 0;
  let warmed = 0;
  let skipped = 0;

  const worker = async () => {
    while (cursor < queue.length) {
      const symbol = queue[cursor++];
      const startedAt = Date.now();
      try {
        const { status } = await shimPredict(symbol, "1m");
        const latencyMs = Date.now() - startedAt;
        if (status === 200) {
          warmed += 1;
        } else {
          skipped += 1;
        }
        logger.info("[warmup] model pre-warm", {
          symbol,
          status,
          latency_ms: latencyMs,
        });
      } catch (err) {
        skipped += 1;
        logger.warn("[warmup] model pre-warm skipped", {
          symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()),
  );
  logger.info("[warmup] model pre-warm complete", { warmed, skipped });
  return { warmed, skipped };
}

export const multiPredict = async (req: Request, res: Response) => {
  const body = req.body as {
    symbols?: unknown;
    timeframe?: unknown;
    minConfidence?: unknown;
    min_confidence?: unknown;
    horizonMinutes?: unknown;
    horizon_minutes?: unknown;
    minTier?: unknown;
    min_tier?: unknown;
  };
  const rawSymbols = Array.isArray(body.symbols) ? body.symbols : [];
  const timeframe =
    typeof body.timeframe === "string" && body.timeframe.trim()
      ? body.timeframe.trim()
      : "1m";
  const minConfidenceClamped = clampMinConfidenceToEngineRange(
    body.minConfidence ?? body.min_confidence,
  );
  const horizonMinutesClamped = readHorizonMinutes(req.body);
  const minTierClamped = readMinTier(req.body);

  if (rawSymbols.length === 0) {
    return res.status(400).json({
      error: "Validation Error",
      message: 'A non-empty "symbols" array is required.',
    });
  }
  if (rawSymbols.length > MULTI_PREDICT_MAX_SYMBOLS) {
    return res.status(400).json({
      error: "Validation Error",
      message: `"symbols" is limited to ${MULTI_PREDICT_MAX_SYMBOLS} instruments.`,
    });
  }

  // Deduplicate preserving order; only accept string symbols.
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const raw of rawSymbols) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().toUpperCase();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    symbols.push(trimmed);
  }

  const requestedAt = new Date().toISOString();
  const results = new Map<string, SymbolPredictOutcome>();

  // ── BOUNDED CONCURRENCY POOL ──
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= symbols.length) return;
      const symbol = symbols[index];
      try {
        const { status, body } = await shimPredict(
          symbol,
          timeframe,
          minConfidenceClamped,
          horizonMinutesClamped,
          minTierClamped,
        );
        results.set(symbol, {
          ok: status === 200,
          status,
          data: status === 200 ? body : undefined,
          error: status === 200 ? undefined : body,
        });
        logger.info(`[multi-predict] symbol=${symbol} timeframe=${timeframe} status=${status}`);
      } catch (err) {
        logger.warn("[multi-predict] Unexpected prediction failure", {
          symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        results.set(symbol, {
          ok: false,
          status: 500,
          error: { error: "internal", message: "Prediction pipeline failed." },
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MULTI_PREDICT_CONCURRENCY, symbols.length) },
      () => worker()),
  );

  const resultsObject: Record<string, SymbolPredictOutcome> = {};
  for (const [symbol, outcome] of results) {
    resultsObject[symbol] = outcome;
  }

  return res.json({
    success: true,
    count: symbols.length,
    timeframe,
    requestedAt,
    results: resultsObject,
    generatedAt: new Date().toISOString(),
  });
};
