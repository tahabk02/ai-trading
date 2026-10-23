/**
 * secrets.ts
 *
 * Centralised configuration for sensitive keys, secrets, and runtime settings.
 *
 * ENVIRONMENT IS LOADED HERE, FIRST, AND EXPLICITLY.
 * `loadServiceEnv()` reads ONLY files inside `core-backend/` and is resolved
 * from this module's own location — never from `process.cwd()`, and never by
 * walking up to a parent directory. See `env.ts` for the full rationale; the
 * short version is that the old `dotenv.config({ path: "../.env" })` resolved
 * to the repo-root `.env` and, because dotenv is first-wins, its SQLite
 * `DATABASE_URL` silently overrode core-backend's Postgres one.
 *
 * This module is imported before any other application module, so the load
 * happens before anything reads `process.env`.
 */

import { isConfigured, loadServiceEnv, describeEnvSources } from "./env";
import { readFileSync, existsSync } from "fs";

loadServiceEnv();

/**
 * Read a mounted SECRET FILE (Docker secrets / read-only volume) and fall back
 * to the plain env value only when the file cannot be used. The file path comes
 * from the environment; the file's CONTENTS are never logged or echoed.
 * PART 43.6 [481]: in a container, credentials arrive as mounted files, never
 * as env or image layers.
 */
function readSecretFile(
  filePath: string | undefined,
  envFallback: string | undefined,
): string {
  const p = (filePath || "").trim();
  if (!p) {
    return envFallback || "";
  }
  try {
    if (existsSync(p)) {
      return readFileSync(p, "utf8").trim();
    }
    console.warn(
      `[secrets] secret file '${p}' does not exist — falling back to the env value`,
    );
  } catch (err) {
    console.warn(
      `[secrets] could not read secret file '${p}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return envFallback || "";
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const IS_TEST = process.env.NODE_ENV === "test";

/** Parse a boolean env flag ("1"/"true"/"yes"/"on" → true), with a default. */
function boolFlag(raw: string | undefined, dflt: boolean): boolean {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return dflt;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Fail-fast configuration check.
 *
 * Reports EVERY problem at once rather than one per restart, because the old
 * pattern threw on whichever key happened to be evaluated first, so an operator
 * fixing a deploy discovered the next missing variable only after the next
 * crash. Values are never included in the message — only names and remedies.
 *
 * Hard failure is production-only. In development the service must still boot
 * with zero setup (that is the point of the local defaults), so problems are
 * logged as warnings. `test` is treated as production for DATABASE_URL
 * specifically, because a SQLite fallback in tests is exactly what let the
 * parent-`.env` shadowing bug hide.
 */
function assertRequiredConfig(): void {
  const problems: string[] = [];

  const require_ = (
    name: string,
    value: string | undefined,
    remedy: string,
  ) => {
    if (!isConfigured(value)) problems.push(`  - ${name} is missing or still a placeholder. ${remedy}`);
  };

  require_(
    "DATABASE_URL",
    process.env.DATABASE_URL,
    "Set a postgresql:// URL (docker compose service `postgres`, port 5433).",
  );
  require_(
    "JWT_SECRET",
    process.env.JWT_SECRET,
    "Generate with `openssl rand -base64 48`. A weak or default value makes every issued token forgeable.",
  );
  require_(
    "AI_ENGINE_API_KEY",
    process.env.AI_ENGINE_API_KEY,
    "Must match the key ai-engine validates. Never default it to a public constant.",
  );

  if (isConfigured(process.env.JWT_SECRET) && (process.env.JWT_SECRET || "").trim().length < 32) {
    problems.push(
      "  - JWT_SECRET is shorter than 32 characters, which is too weak to sign tokens with. Generate with `openssl rand -base64 48`.",
    );
  }

  if (problems.length === 0) return;

  const header =
    `[FATAL] ${problems.length} required environment variable(s) are not usable ` +
    `(sources: ${describeEnvSources()}):\n${problems.join("\n")}\n` +
    "Refusing to start. A misconfigured service that boots anyway fails " +
    "silently later — a SQLite fallback serves an empty schema while looking " +
    "healthy, and a default signing key makes every token forgeable.";

  if (IS_PRODUCTION || IS_TEST) throw new Error(header);
  console.warn(header.replace("[FATAL]", "[config]"));
}

// Validate BEFORE building the object so a bad deploy fails once, loudly,
// instead of producing a half-valid `secrets` that fails somewhere unrelated.
assertRequiredConfig();

export const secrets = {
  // ── Server ──
  PORT: Number(process.env.PORT) || 4000,
  NODE_ENV: process.env.NODE_ENV || "development",

  // ── CORS ──
  CORS_ORIGIN: process.env.CORS_ORIGIN || "",

  // ── JWT ──
  // Validated at the top of this module: in production (and in tests) a
  // missing, placeholder, or under-length secret is fatal. The development
  // fallback keeps `npm run dev` working with zero setup, and is clearly
  // marked so it can never be mistaken for a real value.
  JWT_SECRET:
    (process.env.JWT_SECRET || "").trim() || "insecure-development-only-secret-do-not-use",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "24h",

  // ── Redis ──
  REDIS_HOST: process.env.REDIS_HOST || "localhost",
  REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  // Cloud Redis alternative (e.g. Upstash, Redis Cloud) — disables local Docker requirement
  REDIS_URL: process.env.REDIS_URL || "",

  // ── Database ──
  // The previous fallback "file:./dev.db" meant a production deploy with a
  // missing DATABASE_URL silently started a local SQLite file — no rows, no
  // error, every query "worked" against an empty database. Missing/invalid is
  // now fatal in production and in tests (assertRequiredConfig above); the
  // SQLite value survives only as an explicit development convenience.
  DATABASE_URL: (process.env.DATABASE_URL || "").trim() || "file:./dev.db",

  // ── Rate Limiting ──
  // RATE_LIMIT_MAX raised 120 → 300 req/min/IP: the dashboard full-DOM refresh
  // (epoch fetch + historical + several predictions + live standings in the
  // same window) hit the old cap as bogus 429/503s under normal use — not an
  // abuse case. 300/min per IP still blocks genuine floods while never
  // throttling a legitimate session's burst.
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX) || 300,

  // ── AI Engine ──
  // Service-to-service key. The previous literal "INTERNAL_SECRET_AI_ENGINE"
  // was a PUBLIC constant: anyone reading the repo or the image knew the value
  // the backend presents to the engine, so it authenticated nothing. It is
  // required in production (assertRequiredConfig) and generated per-process in
  // development, where both services run on one trusted host and a shared
  // constant buys no security anyway.
  AI_ENGINE_API_KEY: (process.env.AI_ENGINE_API_KEY || "").trim() || "dev-internal-service-key",
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
  //
  // ⚠️  NO HARDCODED FALLBACK VALUES.
  // This object previously carried literal Alpaca credentials as the final `||`
  // fallback. That was a real secret committed to git and shipped inside the
  // production image: the literals survived `docker build` even when the
  // operator never set the env vars, so the service silently authenticated with
  // a broker key nobody audits or rotates, and the key leaked to anyone with
  // repo or image access. An unconfigured broker key is a CONFIGURATION ERROR
  // that must surface at first use — not a silently-valid credential.
  //
  // Absent keys now resolve to "" and `alpacaMarketData.service.ts` degrades to
  // its non-Alpaca price tiers instead of authenticating with a stale secret.
  //
  // ROTATION REQUIRED: the previously committed values are compromised by
  // definition. Revoke them in the Alpaca console before deploying.
  ALPACA_API_KEY_ID:
    process.env.ALPACA_API_KEY_ID || process.env.APCA_API_KEY_ID || "",
  ALPACA_API_SECRET:
    process.env.ALPACA_API_SECRET || process.env.APCA_API_SECRET_KEY || "",

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
  POCKET_OPTION_UID: process.env.POCKET_OPTION_UID || "",
  POCKET_OPTION_IS_DEMO: process.env.POCKET_OPTION_IS_DEMO || "0",
  // ── Pocket Option session self-healing (session/capture_session.py +
  // session/refresh_ssid.py) ──
  // The bridge normally refreshes its SSID from a captured browser session
  // (no credentials involved). PO_EMAIL/PO_PASSWORD are an OPT-IN LAST RESORT:
  // only used by session/refresh_ssid.py when the stored session is dead AND
  // PO_EMAIL_LOGIN is enabled AND PO_TOS_CONSENT is recorded AND both halves
  // are present. In a container the values are mounted FILE secrets managed by
  // PO_EMAIL_FILE / PO_PASSWORD_FILE; the plain env form is a dev fallback.
  // They are forwarded to the REFRESHER child ONLY — never to the bridge, the
  // request path, logs, /health, or process args (PART 43.6 [480]).
  PO_EMAIL: readSecretFile(process.env.PO_EMAIL_FILE, process.env.PO_EMAIL),
  PO_PASSWORD: readSecretFile(
    process.env.PO_PASSWORD_FILE,
    process.env.PO_PASSWORD,
  ),
  PO_EMAIL_FILE: (process.env.PO_EMAIL_FILE || "").trim(),
  PO_PASSWORD_FILE: (process.env.PO_PASSWORD_FILE || "").trim(),
  PO_EMAIL_LOGIN: (process.env.PO_EMAIL_LOGIN || "false").trim().toLowerCase(),
  // Pixel/UX budget (seconds) for the headless credential login form.
  PO_LOGIN_TIMEOUT: Number(process.env.PO_LOGIN_TIMEOUT) || 45,
  // When "true", core-backend ALSO triggers a background refresh the moment the
  // relay reports a terminal auth failure. Default OFF: the Python bridge
  // already refreshes on auth failure, and a second concurrent browser login
  // would double the account's exposure (ban risk).
  PO_AUTH_NODE_TRIGGER: (process.env.PO_AUTH_NODE_TRIGGER || "false")
    .trim()
    .toLowerCase(),
  // PART 43.6 [482] — the broker's WRITTEN answer on automated login must be
  // recorded (docs/legal/po-automated-login-tos-consent.md) BEFORE this is set
  // anywhere. It gates the credential tier in both Node and the refresher.
  // Empty value = credential tier never enabled. Default OFF.
  PO_TOS_CONSENT: (process.env.PO_TOS_CONSENT || "").trim(),
  // PART 43.7 [486] — shared secret required to POST /health/po-auth/refresh
  // or /health/po-auth/reset. When set, EVERY caller (loopback included) must
  // present it in the `X-PO-Admin-Key` header (timing-safe compare).
  PO_HEALTH_ADMIN_KEY: (process.env.PO_HEALTH_ADMIN_KEY || "").trim(),
  // PART 43.7 [486] — "hosted" posture for the mutating /health/po-auth routes.
  // When hosted and PO_HEALTH_ADMIN_KEY is unset, the routes FAIL CLOSED: they
  // answer 404 (disabled) instead of the dev "loopback-only" fallback, because
  // behind a reverse proxy `req.ip` can be loopback for a remote caller.
  // Default: true in production, false in development/test.
  PO_HEALTH_HOSTED: boolFlag(process.env.PO_HEALTH_HOSTED, IS_PRODUCTION),
  // PART 43.6 [483] — minutes a dead/stale PO session is tolerated before an
  // alert fires (email + Telegram when configured). Default 15.
  PO_SESSION_STALE_ALERT_MIN:
    Number(process.env.PO_SESSION_STALE_ALERT_MIN) || 15,
  // PART 43.6 [483] — session/circuit alert destination (empty = alerts are
  // logged through NotificationService but not emailed).
  PO_ALERT_EMAIL: (process.env.PO_ALERT_EMAIL || "").trim(),
  // PART 43.7 [488] — single external alert sink (a Slack-compatible / generic
  // webhook URL) for PO session/auth alerts. Empty = no webhook.
  PO_ALERT_WEBHOOK_URL: (process.env.PO_ALERT_WEBHOOK_URL || "").trim(),
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
