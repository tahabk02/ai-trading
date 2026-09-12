/**
 * secrets.ts
 *
 * Centralised configuration for sensitive keys, secrets, and runtime settings.
 * In production you should inject these via environment variables
 * or a vault service (Vault, AWS Secrets Manager, etc.).
 */

import dotenv from "dotenv";

// Load .env from project root and core-backend directory
dotenv.config({ path: "../../.env" });
dotenv.config({ path: "../.env" });
dotenv.config();

export const secrets = {
  // ── Server ──
  PORT: Number(process.env.PORT) || 4000,
  NODE_ENV: process.env.NODE_ENV || "development",

  // ── CORS ──
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",

  // ── JWT ──
  JWT_SECRET:
    process.env.JWT_SECRET || "change-me-in-production-min-32-chars!!",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "24h",

  // ── Redis ──
  REDIS_HOST: process.env.REDIS_HOST || "localhost",
  REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  // Cloud Redis alternative (e.g. Upstash, Redis Cloud) — disables local Docker requirement
  REDIS_URL: process.env.REDIS_URL || "",

  // ── Database ──
  DATABASE_URL: process.env.DATABASE_URL || "file:./dev.db",

  // ── Rate Limiting ──
  // RATE_LIMIT_MAX raised 120 → 300 req/min/IP: the dashboard full-DOM refresh
  // (epoch fetch + historical + several predictions + live standings in the
  // same window) hit the old cap as bogus 429/503s under normal use — not an
  // abuse case. 300/min per IP still blocks genuine floods while never
  // throttling a legitimate session's burst.
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX) || 300,

  // ── AI Engine ──
  AI_ENGINE_API_KEY:
    process.env.AI_ENGINE_API_KEY || "INTERNAL_SECRET_AI_ENGINE",
  AI_ENGINE_URL: process.env.AI_ENGINE_URL || "http://ai-engine:8000",
  // Request timeout (ms) for AI Engine predictions. Set generous enough to
  // accommodate heavy sklearn inference / training runs — MUST NOT drop below
  // 15000ms or the backend will time out during legitimate inference spikes.
  AI_ENGINE_TIMEOUT_MS: Number(process.env.AI_ENGINE_TIMEOUT_MS) || 120_000,
  // Number of retry attempts for transient AI Engine failures (timeouts, 429,
  // and 5xx responses). Combined with exponential backoff this absorbs brief
  // heavy-inference spikes without falling straight to the HOLD fallback.
  AI_ENGINE_MAX_RETRIES: Number(process.env.AI_ENGINE_MAX_RETRIES) || 3,

  // ── OTC Forex Data ──
  // Twelve Data API key (optional) — enables REAL intraday (1m/5m/15m)
  // OTC forex candles. Without it, intraday candles are volatility-band
  // derived from the live rate + historical ATR (still zero random demo).
  TWELVE_DATA_API_KEY: process.env.TWELVE_DATA_API_KEY || "",

  // ── Alpaca Market Data ──
  // Alpaca API keys — supports both naming conventions (ALPACA_ and APCA_)
  // Primary: ALPACA_API_KEY_ID / ALPACA_API_SECRET
  // Fallback: APCA_API_KEY_ID / APCA_API_SECRET_KEY (used by official SDK)
  ALPACA_API_KEY_ID:
    process.env.ALPACA_API_KEY_ID ||
    process.env.APCA_API_KEY_ID ||
    "PKL6YUN6G3B1KK4Q9I7V",
  ALPACA_API_SECRET:
    process.env.ALPACA_API_SECRET ||
    process.env.APCA_API_SECRET_KEY ||
    "vfZp7qRx9Mc3K2W4L9b8X7z1N5m0PqRsTuVwXyZa",

  // Sandbox control — set to "true" to use sandbox data API
  // When true, forces BASE_URL to sandbox endpoint regardless of key prefix
  ALPACA_USE_SANDBOX: process.env.ALPACA_USE_SANDBOX === "true",

  // Data API endpoints
  // Live:  https://data.alpaca.markets
  // Sandbox: https://data.sandbox.alpaca.markets
  ALPACA_BASE_URL:
    process.env.ALPACA_BASE_URL ||
    (process.env.ALPACA_USE_SANDBOX === "true"
      ? "https://data.sandbox.alpaca.markets"
      : "https://data.alpaca.markets"),
  ALPACA_SANDBOX_BASE_URL:
    process.env.ALPACA_SANDBOX_BASE_URL ||
    "https://data.sandbox.alpaca.markets",

  // Trading API endpoints
  // Live:  https://api.alpaca.markets
  // Paper: https://paper-api.alpaca.markets
  ALPACA_TRADING_API_URL:
    process.env.APCA_API_BASE_URL ||
    process.env.ALPACA_TRADING_API_URL ||
    "https://paper-api.alpaca.markets",

  // WebSocket endpoints
  // Live:  wss://stream.data.alpaca.markets/v2/sip
  // Sandbox: wss://stream.data.sandbox.alpaca.markets/v2/sip
  ALPACA_WS_ENDPOINT:
    process.env.ALPACA_WS_ENDPOINT ||
    (process.env.ALPACA_USE_SANDBOX === "true"
      ? "wss://stream.data.sandbox.alpaca.markets/v2/sip"
      : "wss://stream.data.alpaca.markets/v2/sip"),

  // ── WebSocket ──
  WS_PATH: process.env.WS_PATH || "/ws",

  // ── Pocket Option Live Bridge ──
  // The Python `pocket-bridge` service connects to Pocket Option with this
  // SSID (the full `42["auth",{...}]` session cookie) and relays live ticks +
  // strict M20 candles to the backend over a local WebSocket. The backend
  // connects as a client. When no SSID is set, the bridge (and therefore the
  // backend) runs in a clean "awaiting_ssid" state with NO fabricated prices.
  POCKET_OPTION_SSID: process.env.POCKET_OPTION_SSID || "",
  POCKET_BRIDGE_HOST: process.env.POCKET_BRIDGE_HOST || "127.0.0.1",
  POCKET_BRIDGE_PORT: Number(process.env.POCKET_BRIDGE_PORT) || 8788,
  // How often (ms) the backend re-tries connecting to the relay once down.
  POCKET_BRIDGE_RECONNECT_MS: Number(process.env.POCKET_BRIDGE_RECONNECT_MS) || 5000,
  // Auto-spawn the Python bridge process via child_process (true/false string).
  POCKET_BRIDGE_AUTO_SPAWN: process.env.POCKET_BRIDGE_AUTO_SPAWN || "true",
  // Python interpreter to use for the bridge ("python", "python3", "py", or full path).
  POCKET_BRIDGE_PYTHON: process.env.POCKET_BRIDGE_PYTHON || "",
};

export default secrets;
