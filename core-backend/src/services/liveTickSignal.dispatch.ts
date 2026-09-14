/**
 * liveTickSignal.dispatch.ts — REAL-TIME /tick-signal FORWARDER (THERMAL GATE)
 *
 * Coalesces the live tick tape into a ~1s/symbol POST to the AI Engine's
 * high-frequency `/tick-signal` scorer so the strict 10-book multiplicative
 * confluence runs on the ACTUAL live tape (trailing real prices + real bid/ask
 * arms). This is the ONLY way confidence can organically cross the 96.5%
 * thermal gate on a strong momentum run instead of flatlining at the
 * candle-close HOLD.
 *
 * ZERO FABRICATION (0% DEMO):
 *   • The payload is strict real buffer data — realtimeTickBuffer.getRecentWindow
 *     + getLatestSpread (the last-known-arm cache keeps a genuine book alive
 *     across arm-less mid ticks).
 *   • Fewer than 2 real prices → the dispatch is skipped entirely (the AI Engine
 *     would reject it with an HTTP 400; we never invent a signal).
 *   • Verdicts are broadcast on the dedicated `live_quant_signal` room event and
 *     only when they MEANINGFULLY change (direction / confidence step / gate
 *     crossing) — no 1Hz feed spam, no repeated identical frames.
 *   • A DEFINITIVE (>=96.5%) verdict also fires the global `high_confidence_signal`
 *     priority toast.
 */

import axios from "axios";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";
import { websocketService } from "./websocket.service";
import { realtimeTickBuffer } from "./realtimeTickBuffer.service";

const buildAiEngineTickSignalUrl = (baseUrl: string): string => {
  const cleaned = baseUrl.replace(/\/+$/, "");
  if (cleaned.endsWith("/api/v1")) return `${cleaned}/tick-signal`;
  if (cleaned.endsWith("/api")) return `${cleaned}/v1/tick-signal`;
  return `${cleaned}/api/v1/tick-signal`;
};

const AI_ENGINE_TICK_SIGNAL_URL = buildAiEngineTickSignalUrl(
  secrets.AI_ENGINE_URL,
);
/** Fast-path budget — short enough to never back-pressure the ingest loop. */
const TICK_SIGNAL_TIMEOUT_MS = 4_000;
/** Coalescing cadence — at most one /tick-signal per symbol per second. */
const DISPATCH_INTERVAL_MS = 1_000;
/** Real tape window forwarded to the scorer (trailing closes + armed ticks). */
const FORWARD_WINDOW_TICKS = 60;
/** Confidence step (0-100 scale) that warrants a fresh live-quant broadcast. */
const BROADCAST_CONFIDENCE_STEP = 2.0;
/** THE PLATFORM HIGH-CONFIDENCE ALERT THRESHOLD — mirrors the AI Engine's
 *  strict DEFINITIVE 96.5% thermal gate (no signal fires as a priority alert
 *  unless all ten books organically converge). */
const HIGH_CONFIDENCE_THRESHOLD = 96.5;

type TickSignalFailureKind =
  | "unreachable"
  | "timeout"
  | "http_downstream"
  | "unknown";

/** Structured classifier for a downstream /tick-signal failure — mirrors the
 *  predict proxy's `classifyAiEngineFailure` so connectivity / timeout /
 *  503-style failures can fall back to a clean HOLD rider instead of a gap. */
function classifyTickSignalFailure(err: unknown): {
  kind: TickSignalFailureKind;
  code: string | null;
  status: number | null;
} {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? null;
    const code = err.code ?? null;
    if (!err.response) {
      if (
        code === "ECONNABORTED" ||
        code === "ETIMEDOUT" ||
        code === "EHOSTUNREACH"
      ) {
        return { kind: "timeout", code, status: null };
      }
      return { kind: "unreachable", code, status: null };
    }
    return { kind: "http_downstream", code, status };
  }
  return { kind: "unknown", code: null, status: null };
}

/** True only when the failure is DOWNSTREAM / transient (retryable). 4xx
 *  validation rejections (e.g. HTTP 400) must NEVER trigger an invented
 *  signal — the scorer would treat that as a genuine verdict. */
function isDownstreamTickSignalFailure(err: unknown): boolean {
  const cls = classifyTickSignalFailure(err);
  if (cls.kind !== "http_downstream") return cls.kind !== "unknown";
  const s = cls.status ?? 0;
  return s === 429 || s >= 500;
}

interface LastBroadcastState {
  direction: string | null;
  confidence: number;
  waiting: boolean;
}

class LiveTickSignalDispatcher {
  private static instance: LiveTickSignalDispatcher;
  /** Last /tick-signal POST time per symbol (coalescing anchor). */
  private lastSentAt: Map<string, number> = new Map();
  /** Trailing-edge timers (fire the dispatch for the remainder of the 1s beat). */
  private pendingTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Last meaningful verdict broadcast per symbol (change-gate). */
  private lastBroadcast: Map<string, LastBroadcastState> = new Map();

  private constructor() {}

  public static getInstance(): LiveTickSignalDispatcher {
    if (!LiveTickSignalDispatcher.instance) {
      LiveTickSignalDispatcher.instance = new LiveTickSignalDispatcher();
    }
    return LiveTickSignalDispatcher.instance;
  }

  /**
   * Coalescing enqueue — called on EVERY appended real tick. Fires the
   * dispatch immediately when the 1s budget has elapsed, otherwise schedules a
   * trailing-edge timer for the remainder. No tick is ever dropped: the
   * freshest tap always lands inside the next dispatched window.
   */
  public enqueue(symbol: string): void {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm) return;
    const now = Date.now();
    const last = this.lastSentAt.get(norm) ?? 0;
    if (now - last >= DISPATCH_INTERVAL_MS) {
      void this.dispatch(norm);
      return;
    }
    if (this.pendingTimers.has(norm)) return; // trailing timer already armed
    const remain = DISPATCH_INTERVAL_MS - (now - last);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(norm);
      void this.dispatch(norm);
    }, remain);
    timer.unref?.();
    this.pendingTimers.set(norm, timer);
  }

  private async dispatch(symbol: string): Promise<void> {
    this.lastSentAt.set(symbol, Date.now());

    // ── SUBSCRIBER GATE ──
    // Only spend AI Engine CPU on symbols an actual client is watching. Boot
    // auto-starts all 34 OTC pairs, so without this gate every pair issues a
    // full 10-book live-quant evaluation once/second — a guaranteed 34 req/sec
    // flood that starves /predict and the socket loop. With it, only the
    // active chart pair(s) evaluate.
    if (!websocketService.hasActiveSubscribers(symbol)) return;

    const window = realtimeTickBuffer.getRecentWindow(
      symbol,
      FORWARD_WINDOW_TICKS,
    );
    if (window.length < 2) return; // honest: need ≥2 real prices

    const spread = realtimeTickBuffer.getLatestSpread(symbol);
    const prices = window.map((w) => Number(w.price));
    const payload = {
      symbol,
      timeframe: "1m",
      dataSource: "live_tick_ring",
      prices,
      tick: prices[prices.length - 1],
      bid:
        spread.bid != null && Number.isFinite(spread.bid) && spread.bid > 0
          ? Number(spread.bid)
          : undefined,
      ask:
        spread.ask != null && Number.isFinite(spread.ask) && spread.ask > 0
          ? Number(spread.ask)
          : undefined,
    };

    try {
      const { data } = await axios.post<any>(
        AI_ENGINE_TICK_SIGNAL_URL,
        payload,
        {
          timeout: TICK_SIGNAL_TIMEOUT_MS,
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": secrets.AI_ENGINE_API_KEY,
          },
        },
      );
      this.broadcast(symbol, data);
    } catch (err) {
      // Fast-path failure is non-fatal — the next coalesced beat re-arms.
      logger.debug("[LiveTickDispatch] /tick-signal dispatch failed", {
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      // ── DOWNSTREAM FAILURE RIDER ──
      // ECONNREFUSED / timeout / 503 / 5xx from the AI Engine must never leave
      // live-quant consumers in a silent gap. Emit a structured, change-gated
      // WAITING-ONLY rider carrying the failure metadata — no direction is ever
      // fabricated (the engine NEVER returns HOLD). 4xx validation rejections
      // (e.g. HTTP 400) NEVER invent a signal either.
      if (isDownstreamTickSignalFailure(err)) {
        const cls = classifyTickSignalFailure(err);
        this.broadcastFallback(
          symbol,
          "AI_ENGINE_UNREACHABLE",
          "tick-signal downstream " +
            cls.kind +
            (cls.code ? " code=" + cls.code : "") +
            (cls.status ? " status=" + cls.status : ""),
          prices[prices.length - 1],
          {
            available: false,
            failure: { kind: cls.kind, code: cls.code, status: cls.status },
            endpoint: AI_ENGINE_TICK_SIGNAL_URL,
          },
        );
      }
    }
  }

  /**
   * Structured WAITING-ONLY rider for a SPOT-RATE-EXHAUSTED / DEGRADED feed
   * (e.g. all spot sources exhausted for USD/SGD). Direction is never
   * fabricated: emits one change-gated waiting rider so live-quant consumers
   * never see a silent gap while the feed lingers in recovery. NEVER invents a
   * price — the rider carries the last real tape price (or none).
   */
  public notifyFeedDegraded(symbol: string, detail: string): void {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm) return;
    const window = realtimeTickBuffer.getRecentWindow(norm, 1);
    const lastPrice =
      window.length > 0 && Number.isFinite(window[window.length - 1].price)
        ? Number(window[window.length - 1].price)
        : NaN;
    this.broadcastFallback(
      norm,
      "SPOT_RATE_EXHAUSTED",
      detail,
      Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : undefined,
    );
  }

  /**
   * Change-gated WAITING-ONLY rider for downstream / feed failures — a
   * directional verdict is NEVER fabricated, so the rider carries NO signal.
   * It only flips the market-waiting banner while the feed/engine recovers;
   * the last real directional state stays on screen. One per incident (the
   * broadcast change-gate suppresses identical repeats, so a lingering feed
   * never spams the socket).
   */
  private broadcastFallback(
    symbol: string,
    reason: string,
    detail: string,
    lastPrice?: number,
    aiEngine?: unknown,
  ): void {
    const price = lastPrice && Number.isFinite(lastPrice) ? lastPrice : 0;
    this.broadcast(symbol, {
      market_waiting: true,
      waiting_reason: reason,
      waiting_detail: detail,
      current_price: price > 0 ? price : undefined,
      ...(aiEngine ? { aiEngine } : {}),
    });
  }

  /**
   * Change-gated broadcast: only direction flips, >= BROADCAST_CONFIDENCE_STEP
   * confidence moves, thermal-gate crossings and market-waiting transitions
   * reach the socket — a flat identical verdict at 1Hz is silently skipped so
   * the feed stays clean and genuinely reflective of fresh state. Waiting-only
   * riders (no ``signal``) flip the waiting banner without fabricating a
   * direction.
   */
  private broadcast(symbol: string, data: any): void {
    const rawDir = String(data?.signal ?? "").trim().toUpperCase();
    const direction = ["BUY", "SELL"].includes(rawDir)
      ? (rawDir as "BUY" | "SELL")
      : null;
    const waitingOnly = direction === null && data?.market_waiting === true;
    if (direction === null && !waitingOnly) return;

    const confidence = Number(data?.confidence ?? 0);
    if (!Number.isFinite(confidence)) return;
    const waiting = data?.market_waiting === true;
    const prev = this.lastBroadcast.get(symbol);
    if (prev) {
      const stepped = Math.abs(confidence - prev.confidence);
      const crossedGate =
        (prev.confidence < 96.5) !== (confidence < 96.5);
      if (
        prev.direction === direction &&
        prev.waiting === waiting &&
        stepped < BROADCAST_CONFIDENCE_STEP &&
        !crossedGate
      ) {
        return;
      }
    }

    const price = Number(data?.current_price ?? data?.tick ?? 0);
    const targetPrice =
      Number(data?.target_price) > 0 ? Number(data?.target_price) : price;
    const timestamp = data?.timestamp ?? new Date().toISOString();

    const payload = {
      symbol,
      signalType: direction,
      signal: direction,
      confidence,
      confidence_score: confidence,
      current_price: Number.isFinite(price) ? price : undefined,
      target_price: Number.isFinite(targetPrice) ? targetPrice : undefined,
      take_profit: Number.isFinite(targetPrice) ? targetPrice : undefined,
      timeframe: "1m",
      market_waiting: waiting,
      waiting_reason: data?.waiting_reason ?? null,
      waiting_detail: data?.waiting_detail ?? null,
      book_confluence:
        Number(data?.book_confluence) > 0 ? Number(data?.book_confluence) : null,
      dataSource: "live_tick_quant",
      ...(data?.aiEngine ? { aiEngine: data.aiEngine } : {}),
      timestamp,
    };

    this.lastBroadcast.set(symbol, {
      direction,
      confidence,
      waiting,
    });

    websocketService.broadcastLiveQuantSignal(payload);

    if (direction && confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      websocketService.broadcastHighConfidenceSignal({
        symbol,
        signalType: direction as "BUY" | "SELL",
        confidence,
        price: Number.isFinite(price) ? price : 0,
        targetPrice: Number.isFinite(targetPrice) ? targetPrice : 0,
        timeframe: "1m",
        timestamp,
      });
    }
  }
}

export const liveTickSignalDispatcher = LiveTickSignalDispatcher.getInstance();
export default liveTickSignalDispatcher;