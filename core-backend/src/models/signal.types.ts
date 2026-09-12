/**
 * signal.types.ts
 *
 * TypeScript type definitions for trading signal payloads
 * across the entire platform (AI Engine, Core Backend, Client App).
 */

// ── Core Signal (snake_case from Python AI Engine) ──

export interface SignalIndicatorPayload {
  adx: number;
  atr: number;
  [key: string]: unknown;
}

export interface SignalPayload {
  id?: string;
  symbol: string;
  signal_type: "BUY" | "SELL";
  price: number;
  confidence: number;
  stop_loss?: number;
  take_profit?: number;
  indicators?: Record<string, number>;
  timestamp?: string;
  status?: string;
  reason?: string;
  debug?: Record<string, unknown>;
}

// ── Normalised Signal for Client Consumption (camelCase) ──

export interface ClientSignal {
  id: string;
  symbol: string;
  signalType: "BUY" | "SELL";
  price: number;
  confidence: number;
  createdAt: string;
  indicators?: SignalIndicatorPayload;
  stop_loss?: number;
  take_profit?: number;
}

// ── Radar Signal (used by useSignals hook) ──

export interface RadarSignal {
  id: string;
  symbol: string;
  direction: "BUY" | "SELL";
  entry_price: number;
  take_profit: number;
  stop_loss: number;
  confidence_score: number;
  timestamp: string;
  reasoning: {
    adx_value: number;
    market_regime: string;
    ml_probability: number;
    logic_audit: string;
    news_impact?: string;
  };
}

// ── WebSocket Signal (for Socket.IO broadcasts) ──

export type WebSocketSignal = RadarSignal;

// ── Prediction Response ──

export interface PredictionResponse {
  symbol: string;
  signal: "BUY" | "SELL" | "HOLD";
  confidence: number;
  target_price: number;
  current_price: number;
  ml_probability: number;
  model_accuracy: number;
  timeframe: string;
  proxyLatencyMs: number | null;
  indicators: {
    rsi_14: number;
    sma_20: number;
    sma_50: number;
  };
  timestamp: string;
}

// ── WebSocket Events ──

export interface WsSignalEvent {
  event: "new_signal";
  data: ClientSignal;
}

export interface WsSymbolUpdateEvent {
  event: "symbol_update";
  symbol: string;
  data: ClientSignal;
}
