/**
 * aiEngineHttp.ts — shared HTTP agent for outbound calls to the AI Engine.
 *
 * Every /tick-signal and /predict request previously used axios' default agent
 * (keep-alive OFF), so each of the ~1 Hz × 44-symbol live-quant dispatches
 * opened and tore down a NEW TCP connection to port 8000. Under a dashboard
 * session the engine's accept-side sockets piled up in CLOSE_WAIT until the
 * listener starved (predicts and /health timed out or refused).
 *
 * A single pooled agent keeps a small set of reusable connections open and
 * reuses them per request, eliminating the churn. `maxSockets` bounds engine
 * exposure; `timeout` drops a silent idle socket so the pool self-heals.
 * Mirrored on the engine side by uvicorn `timeout_keep_alive=5` so idle
 * pooled sockets are closed promptly instead of lingering.
 */
import http from "http";

export const AI_ENGINE_HTTP_AGENT = new http.Agent({
  keepAlive: true,
  maxSockets: 16,
  maxFreeSockets: 8,
  keepAliveMsecs: 2_000,
  timeout: 4_000,
});