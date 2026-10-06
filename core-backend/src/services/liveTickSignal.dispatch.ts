/**
 * liveTickSignal.dispatch.ts — REAL-TIME /tick-signal FORWARDER (THERMAL GATE)
 *
 * Coalesces the live tick tape into a ~1s/symbol POST to the AI Engine's
 * high-frequency `/tick-signal` scorer so the strict 10-book multiplicative
 * confluence runs on the ACTUAL live tape (trailing real prices + real bid/ask
 * arms). This is the ONLY way confidence can organically cross the 60%
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
 *   • A DEFINITIVE (>=60%) verdict also fires the global `high_confidence_signal`
 *     priority toast.
 */

import axios from "axios";
import { logger } from "../utils/logger";
import { AI_ENGINE_HTTP_AGENT } from "../utils/aiEngineHttp";
import { secrets } from "../config/secrets";
import { websocketService } from "./websocket.service";
import { clampMinTierToEngineSet } from "../lib/signalTiers";
import type { SignalTier } from "../lib/signalTiers";
import { realtimeTickBuffer } from "./realtimeTickBuffer.service";
import { publishDurableSignal } from "../messaging/signalStream";

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
 *  DEFINITIVE 98% thermal gate (no signal fires as a priority alert
 *  unless all ten books organically converge past 0.98). */
const HIGH_CONFIDENCE_THRESHOLD = 98.0;

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
  /** Honest band last emitted (or null when the engine sent none). */
  tier: string | null;
}

/**
 * Mirrors the engine's resolve_horizon_minutes() (ai-engine/app/services/
 * horizon_engine.py), including its floor bias on ties, so the fast 1Hz path
 * evaluates the SAME horizon the operator selected on the Pro Expiry Bar.
 */
export const TICK_HORIZON_OPTIONS_MINUTES = [1, 2, 3, 5, 10] as const;

export function clampTickHorizonMinutes(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return TICK_HORIZON_OPTIONS_MINUTES.reduce((best, opt) =>
    Math.abs(opt - n) < Math.abs(best - n) ? opt : best,
  );
}

class LiveTickSignalDispatcher {
  private static instance: LiveTickSignalDispatcher;
  /** Last /tick-signal POST time per symbol (coalescing anchor). */
  private lastSentAt: Map<string, number> = new Map();
  /** Trailing-edge timers (fire the dispatch for the remainder of the 1s beat). */
  private pendingTimers: Map<string, NodeJS.Timeout> = new Map();
  /**
   * Symbols with a /tick-signal request currently outstanding.
   *
   * `dispatch` is fire-and-forget (`void this.dispatch(...)`), so a slow engine
   * could previously let two requests for the SAME symbol overlap: the 1s
   * coalescing gate is measured from request START, while the response can take
   * up to TICK_SIGNAL_TIMEOUT_MS. Two overlapping responses then race, and the
   * SLOWER (older) one can land last — broadcasting a stale verdict and
   * corrupting the change-gate state machine in `broadcast`. Serializing per
   * symbol makes out-of-order delivery structurally impossible instead of
   * filtering for it after the fact.
   */
  private inFlight: Set<string> = new Set();
  /**
   * Symbols that received a tick while a request was outstanding. The tick is
   * not discarded: when the in-flight request settles we re-arm immediately so
   * the freshest window is scored without ever stacking requests.
   */
  private rescan: Set<string> = new Set();
  /** Last meaningful verdict broadcast per symbol (change-gate). */
  private lastBroadcast: Map<string, LastBroadcastState> = new Map();
  /**
   * Operator-selected target-expiry horizon per symbol, learned from the
   * Socket.IO "subscribe" payload. Without this the 1Hz quant path always
   * evaluated the engine's 1m default, so the live tick verdict ignored the
   * chosen expiry even though /predict honoured it.
   */
  private selectedHorizons: Map<string, number> = new Map();
  /**
   * Operator-selected minimum signal tier per symbol, learned from the
   * Socket.IO "subscribe" payload. Without this the 1Hz quant path silently
   * fell back to the engine's strict T1 default, so selecting a wider tier had
   * NO effect on the live tick verdict — the surface the terminal actually
   * watches. Mirrors `selectedHorizons` deliberately.
   */
  private selectedMinTiers: Map<string, SignalTier> = new Map();

  private constructor() {}

  public static getInstance(): LiveTickSignalDispatcher {
    if (!LiveTickSignalDispatcher.instance) {
      LiveTickSignalDispatcher.instance = new LiveTickSignalDispatcher();
    }
    return LiveTickSignalDispatcher.instance;
  }

  /** Records the horizon the operator selected for `symbol` (subscribe event). */
  public setSelectedHorizonMinutes(symbol: string, minutes: unknown): void {
    const key = String(symbol ?? "").trim().toUpperCase();
    const hz = clampTickHorizonMinutes(minutes);
    if (!key || hz === null) return;
    this.selectedHorizons.set(key, hz);
  }

  /** The horizon to evaluate for `symbol`, or null to defer to the engine default. */
  public getSelectedHorizonMinutes(symbol: string): number | null {
    const key = String(symbol ?? "").trim().toUpperCase();
    return this.selectedHorizons.get(key) ?? null;
  }

/** Drops the learned horizon when a symbol is fully unsubscribed. */
public clearSelectedHorizonMinutes(symbol: string): void {
    const key = String(symbol ?? "").trim().toUpperCase();
    this.selectedHorizons.delete(key);
  }

  /**
   * Records the minimum tier the operator selected for `symbol` (subscribe
   * event). Garbage is dropped rather than coerced: an unparseable value must
   * leave the engine on its own strict default rather than widen the bar.
   */
  public setSelectedMinTier(symbol: string, tier: unknown): void {
    const key = String(symbol ?? "").trim().toUpperCase();
    if (!key) return;
    const resolved = clampMinTierToEngineSet(tier);
    if (resolved === null) {
      this.selectedMinTiers.delete(key);
      return;
    }
    this.selectedMinTiers.set(key, resolved);
  }

  /** The minimum tier to score `symbol` against, or null for the engine default. */
  public getSelectedMinTier(symbol: string): SignalTier | null {
    const key = String(symbol ?? "").trim().toUpperCase();
    return this.selectedMinTiers.get(key) ?? null;
  }

  /** Drops the learned tier when a symbol is fully unsubscribed. */
  public clearSelectedMinTier(symbol: string): void {
    const key = String(symbol ?? "").trim().toUpperCase();
    this.selectedMinTiers.delete(key);
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
    // A request is already outstanding for this symbol. Record that the tape
    // moved and return: the settle handler re-arms IMMEDIATELY, which is
    // strictly better than arming the trailing timer below — that timer would
    // hold this tick for up to a full coalescing beat on top of the request
    // that is already in flight, i.e. up to 2s of staleness under a slow
    // engine, for a feed that is supposed to be zero-latency.
    if (this.inFlight.has(norm)) {
      this.rescan.add(norm);
      return;
    }
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
    // ── PER-SYMBOL SERIALIZATION ──
    // A request is already outstanding for this symbol. Do NOT stack another
    // one: record that the tape moved and let the settle handler re-arm, which
    // keeps the freshest window scored while guaranteeing that the response we
    // broadcast is always the newest one.
    if (this.inFlight.has(symbol)) {
      this.rescan.add(symbol);
      return;
    }
    this.inFlight.add(symbol);
    try {
      await this.runDispatch(symbol);
    } finally {
      this.inFlight.delete(symbol);
      // Cancel any trailing timer armed while this request was outstanding:
      // the re-arm below supersedes it, and leaving it alive would fire a
      // redundant second follow-up dispatch a beat later.
      const pending = this.pendingTimers.get(symbol);
      if (pending) {
        clearTimeout(pending);
        this.pendingTimers.delete(symbol);
      }
      if (this.rescan.delete(symbol)) {
        // The tape advanced while we were waiting. Re-arm now rather than at
        // the next 1s beat edge, and clear the coalescing anchor so `enqueue`
        // treats this as a fresh leading-edge dispatch (no added latency).
        this.lastSentAt.delete(symbol);
        this.enqueue(symbol);
      }
    }
  }

  private async runDispatch(symbol: string): Promise<void> {
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
      // Fresh-only: held prints keep the ring contiguous for charts but must
      // never drive the scorer. If every observed entry is held, this window is
      // empty and no signal is produced (honest: no real prices ⇒ no signal).
      { freshOnly: true },
    );
    if (window.length < 2) return; // honest: need ≥2 real prices

    const spread = realtimeTickBuffer.getLatestSpread(symbol);
    const prices = window.map((w) => Number(w.price));
    // Forward the operator's selected expiry so the fast path scores the SAME
    // horizon as /predict. Absent → the engine's own default (never invented).
    const horizonMinutes = this.getSelectedHorizonMinutes(symbol);
    // Same reasoning for the tier floor: without forwarding it the live tick
    // verdict would always be scored at the engine's strict T1 default and the
    // operator's selection would be invisible on the live surface. Absent →
    // the engine's own default (never invented here).
    const minTier = this.getSelectedMinTier(symbol);
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
      ...(horizonMinutes !== null ? { horizon_minutes: horizonMinutes } : {}),
      ...(minTier !== null ? { min_tier: minTier } : {}),
    };

    try {
      const { data } = await axios.post<any>(
        AI_ENGINE_TICK_SIGNAL_URL,
        payload,
        {
          timeout: TICK_SIGNAL_TIMEOUT_MS,
          httpAgent: AI_ENGINE_HTTP_AGENT,
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
    // ── HONEST BAND (PART 38.1 [377]) ──
    // The engine already stamps `tier`/`tier_label`/`executable`/`scored_only`/
    // `dispatchable` on every /tick-signal response (signal_gatekeeper.
    // apply_strict_execution_gate -> signals._strict_execution_surface). They
    // are part of the verdict, not decoration: dropping them here left the
    // terminal's LiveVerdict contract (`tier` "present for every tier") reading
    // null for every live verdict, so the card had to re-derive a band from a
    // micro-quant confidence. `clampMinTierToEngineSet` validates the same
    // T1..T5 set the ladder owns, so garbage resolves to null rather than
    // inventing a band.
    const tier = clampMinTierToEngineSet(data?.tier);
    const prev = this.lastBroadcast.get(symbol);
    if (prev) {
      const stepped = Math.abs(confidence - prev.confidence);
      const crossedGate =
        (prev.confidence < 60.0) !== (confidence < 60.0);
      if (
        prev.direction === direction &&
        prev.waiting === waiting &&
        prev.tier === tier &&
        stepped < BROADCAST_CONFIDENCE_STEP &&
        !crossedGate
      ) {
        return;
      }
    }

    const price = Number(data?.current_price ?? data?.tick ?? 0);
    const targetPrice =
      Number(data?.target_price) > 0 ? Number(data.target_price) : price;
    const timestamp = data?.timestamp ?? new Date().toISOString();
    // The horizon this verdict was actually evaluated at, so the client never
    // has to guess which expiry a live tick belongs to.
    const horizonMinutes =
      Number(data?.horizon_minutes) > 0
        ? Number(data.horizon_minutes)
        : this.getSelectedHorizonMinutes(symbol);

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
        Number(data?.book_confluence) > 0 ? Number(data.book_confluence) : null,
      dataSource: "live_tick_quant",
      // Honest execution surface (PART 38.1 [377]) — forwarded verbatim so the
      // card's `LiveVerdict` contract (tier / tier_label / scored_only /
      // dispatchable / executable) stays true across the socket hop instead of
      // being declared on the type and then silently dropped by the builder.
      tier,
      tier_label: typeof data?.tier_label === "string" ? data.tier_label : null,
      status: typeof data?.status === "string" ? data.status : null,
      dispatchable: data?.dispatchable === true,
      scored_only: data?.scored_only === true,
      executable: data?.executable === true,
      regime_gate:
        typeof data?.regime_gate === "string" ? data.regime_gate : null,
      suppressed_reason:
        typeof data?.suppressed_reason === "string"
          ? data.suppressed_reason
          : null,
      ...(horizonMinutes !== null ? { horizon_minutes: horizonMinutes } : {}),
      ...(data?.aiEngine ? { aiEngine: data.aiEngine } : {}),
      timestamp,
    };

    this.lastBroadcast.set(symbol, {
      direction,
      confidence,
      waiting,
      tier,
    });

    websocketService.broadcastLiveQuantSignal(payload);

    // ── DURABLE HALF ──
    // The socket emit above is the HOT path: sub-millisecond, best-effort, and
    // lossy by design (if nobody is connected the operator was not watching).
    // The stream append is the DURABLE path: at-least-once, so a crash between
    // here and the database write still leaves a recoverable record. It is
    // fire-and-forget and can never slow down or fail the broadcast above.
    void publishDurableSignal(payload as Record<string, unknown>);

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