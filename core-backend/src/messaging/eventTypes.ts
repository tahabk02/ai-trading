/**
 * eventTypes.ts
 *
 * Centralised constants for all event types flowing through
 * the messaging layer (Redis Pub/Sub, WebSocket broadcasts).
 */

export const EventTypes = {
  // ── Trading Signals ──
  SIGNAL_GENERATED: "trading_signals",
  SIGNAL_EXECUTED: "signal_executed",
  SIGNAL_CANCELLED: "signal_cancelled",

  // ── Market Data ──
  MARKET_DATA_UPDATE: "market_data_update",
  PRICE_TICK: "price_tick",

  // ── System Events ──
  SYSTEM_HEALTH_CHECK: "system_health",
  ENGINE_STATUS_CHANGE: "engine_status_change",
  SYSTEM_ALERTS: "system_alerts",

  // ── User Events ──
  USER_LOGIN: "user_login",
  USER_LOGOUT: "user_logout",

  // ── WebSocket Client Events ──
  NEW_SIGNAL: "new_signal",
  SYMBOL_UPDATE: "symbol_update",
  CONNECTION_STATUS: "connection_status",

  // ── Legacy Aliases (backward compatibility) ──
  TRADING_SIGNALS: "trading_signals",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];
