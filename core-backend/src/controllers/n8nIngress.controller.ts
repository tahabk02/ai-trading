/**
 * n8nIngress.controller.ts — PHASE 5 external signal ingress.
 *
 * POST /signals/n8n-ingress — the ZERO-WAIT entry point for n8n workflow
 * verdicts. n8n POSTs a finalized CALL/PUT decision (or a WAITING notice)
 * and this endpoint IMMEDIATELY fans it out over both live socket channels:
 *
 *   - `live_quant_signal` — always (the single-signal card + market terminal)
 *   - `new_signal`        — only for SIGNAL_GENERATED (priority toast path)
 *
 * There is NO persistence hop and NO engine re-score: the verdict is
 * broadcast at receipt with a server-set timestamp so the client's 2.5s
 * freshness gate sees a genuinely fresh dispatch even when the n8n workflow
 * itself ran minutes earlier.
 *
 * AUTH: X-API-Key == AI_ENGINE_API_KEY via requireAiEngineKey — the same
 * service-to-service secret that gates /signals/receive.
 */

import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { canonicalizeSymbol } from "../utils/symbolFormat";
import { websocketService } from "../services/websocket.service";

/**
 * PHASE 5 EXTERNAL FLOOR — n8n verdicts are authored by an independent
 * strategy pipeline that validates its own entry conditions, so the client's
 * strict 96.5% engine bar does not apply. The operational floor for
 * DISPATCHABLE n8n signals is 60% (mirrored client-side as
 * `EXTERNAL_SIGNAL_FLOOR` in realtimeCandleAggregator.ts — keep in sync).
 */
export const N8N_MIN_CONFIDENCE = 60;

/** Client-side mirror of the engine tier ladder (signalTiers.ts). Kept in
 *  lockstep so the tier badge on an n8n card matches the ladder everywhere. */
function tierForConfidence(confidence: number): { tier: string; tierLabel: string } {
  if (confidence >= 96.5) return { tier: "T1", tierLabel: "PREMIUM" };
  if (confidence >= 90) return { tier: "T2", tierLabel: "HIGH" };
  if (confidence >= 80) return { tier: "T3", tierLabel: "MEDIUM" };
  if (confidence >= 70) return { tier: "T4", tierLabel: "LOW" };
  return { tier: "T5", tierLabel: "WEAK" };
}

type N8nDirection = "CALL" | "PUT";

export const n8nIngress = async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // ── VALIDATION ──
  // Every field n8n must ship is checked BEFORE anything is broadcast — a
  // malformed verdict never reaches the socket.
  const rawSymbol = String(body.symbol ?? "").trim();
  if (!rawSymbol) {
    return res.status(400).json({
      error: "validation_error",
      message: 'A non-empty "symbol" field is required (e.g. "GBP/USD" or "GBP/USD_OTC").',
    });
  }
  const symbol = canonicalizeSymbol(rawSymbol);
  if (!symbol) {
    return res.status(400).json({
      error: "validation_error",
      message: 'The "symbol" field could not be canonicalized to a known pair.',
    });
  }

  const rawDirection = String(body.direction ?? "").trim().toUpperCase();
  if (rawDirection !== "CALL" && rawDirection !== "PUT") {
    return res.status(400).json({
      error: "validation_error",
      message: 'direction must be "CALL" or "PUT".',
    });
  }
  const direction = rawDirection as N8nDirection;

  const rawStatus = String(body.status ?? "SIGNAL_GENERATED").trim().toUpperCase();
  if (rawStatus !== "SIGNAL_GENERATED" && rawStatus !== "WAITING") {
    return res.status(400).json({
      error: "validation_error",
      message: 'status must be "SIGNAL_GENERATED" or "WAITING".',
    });
  }
  const waiting = rawStatus === "WAITING";

  const confidenceRaw = Number(body.confidence);
  if (!Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 100) {
    return res.status(400).json({
      error: "validation_error",
      message: "confidence must be a number on the 0-100 scale.",
    });
  }
  const confidence = Math.round(confidenceRaw * 100) / 100;

  const departPrice = Number(body.depart_price);
  if (!Number.isFinite(departPrice) || departPrice <= 0) {
    return res.status(400).json({
      error: "validation_error",
      message: "depart_price must be a positive number (the departure strike).",
    });
  }

  const expiryRaw = Number(body.recommended_expiry_seconds);
  if (!Number.isFinite(expiryRaw) || expiryRaw <= 0) {
    return res.status(400).json({
      error: "validation_error",
      message: "recommended_expiry_seconds must be a positive number.",
    });
  }
  const recommendedExpirySeconds = Math.round(expiryRaw);

  // ── TIMESTAMP: SERVER RECEIPT CLOCK ──
  // The client's age gates (engine-signal age, live-quote age) measure against
  // THIS clock, so a delayed n8n workflow run can never masquerade as a fresh
  // dispatch — and a fresh dispatch is never rejected as stale.
  const nowMs = Date.now();
  const receivedAt = new Date(nowMs).toISOString();
  const n8nTimestamp = String(body.timestamp ?? "").trim() || null;

  // CALL → BUY / PUT → SELL for the engine-shaped channels.
  const engineDirection: "BUY" | "SELL" = direction === "CALL" ? "BUY" : "SELL";
  const { tier, tierLabel } = tierForConfidence(confidence);
  const executable = !waiting && confidence >= N8N_MIN_CONFIDENCE;

  /**
   * DEPARTURE CONTRACT — n8n reports the exact departure strike
   * ("ligne du départ"). The chart's cyan DEPART line + DOM price markers
   * render from this contract, so it is mirrored here with an OPEN entry
   * window (receipt → expiry) and no slippage tolerance (the external engine
   * already validated the level before dispatching). No projected target is
   * fabricated — n8n sends none.
   */
  const departure = {
    available: true,
    status: "ACTIVE" as const,
    reason: "n8n_ingress",
    side: direction,
    strike_price: departPrice,
    target_price: departPrice,
    entry_window_start_ms: nowMs - 15_000,
    entry_window_end_ms: nowMs + recommendedExpirySeconds * 1000,
    max_allowed_slippage: null,
    slippage: null,
  };

  const quantPayload = {
    symbol,
    signalType: waiting ? null : engineDirection,
    signal: waiting ? null : engineDirection,
    confidence,
    confidence_score: confidence,
    current_price: departPrice,
    timeframe: "1m",
    market_waiting: waiting,
    waiting_reason: waiting ? "n8n_waiting" : null,
    waiting_detail: waiting
      ? "n8n reported WAITING for this pair — no directional verdict dispatched."
      : null,
    book_confluence: null,
    dataSource: "n8n",
    source: "n8n",
    tier,
    tier_label: tierLabel,
    status: waiting ? "waiting" : "active",
    dispatchable: !waiting,
    scored_only: waiting,
    executable,
    regime_gate: waiting ? null : "tradable",
    suppressed_reason: null,
    entry_timestamp: receivedAt,
    entry_price: departPrice,
    expiry_timestamp: new Date(nowMs + recommendedExpirySeconds * 1000).toISOString(),
    horizon: { departure },
    recommended_expiry_seconds: recommendedExpirySeconds,
    n8n_timestamp: n8nTimestamp,
    timestamp: receivedAt,
  };

  websocketService.broadcastLiveQuantSignal(quantPayload);

  let newSignalBroadcast = false;
  if (!waiting) {
    websocketService.broadcastSignal({
      id: `n8n-${nowMs}-${symbol}`,
      symbol,
      signalType: engineDirection,
      signal: engineDirection,
      direction: engineDirection,
      price: departPrice,
      entry_price: departPrice,
      confidence,
      confidence_score: confidence,
      status: "ACTIVE",
      dataSource: "n8n",
      source: "n8n",
      tier,
      recommended_expiry_seconds: recommendedExpirySeconds,
      timestamp: receivedAt,
    });
    newSignalBroadcast = true;
  }

  logger.info("[n8nIngress] broadcast", {
    symbol,
    direction,
    status: rawStatus,
    confidence,
    tier,
    expiry_s: recommendedExpirySeconds,
    events: newSignalBroadcast ? "live_quant_signal,new_signal" : "live_quant_signal",
  });

  return res.status(200).json({
    status: "success",
    data: {
      broadcast: true,
      events: newSignalBroadcast ? ["live_quant_signal", "new_signal"] : ["live_quant_signal"],
      symbol,
      direction,
      signal_status: rawStatus,
      confidence,
      tier,
      depart_price: departPrice,
      recommended_expiry_seconds: recommendedExpirySeconds,
      executable,
      received_at: receivedAt,
    },
  });
};
