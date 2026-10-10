/**
 * server.js — custom Next.js server with a RUNTIME reverse proxy.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS (the build-time rewrite trap)
 * ════════════════════════════════════════════════════════════════════════════
 * `next.config.js` `rewrites()` is evaluated ONCE, at config-load time — i.e.
 * DURING `next build` — and the fully-expanded result is serialised into
 * `.next/routes-manifest.json`. `npm start` never re-reads `process.env` for
 * those destinations.
 *
 * So the previous arrangement was broken in a way that looked correct:
 *
 *   $ docker build ...            # API_PROXY_URL is NOT set here
 *   $ ...rewrites() baked in:  http://localhost:4000   ← the fallback
 *   $ docker compose up          # API_PROXY_URL=http://core-backend:4000
 *                                # ...and is silently IGNORED
 *
 * Inside the client-app container `localhost:4000` is *client-app itself*, so
 * every `/api/*` request looped back into the Next server and 404'd. Setting
 * `API_PROXY_URL` in `docker-compose.prod.yml` therefore did nothing at all,
 * no matter how it was spelled. The only reason local dev "worked" is that the
 * fallback `http://localhost:4000` happens to be correct on a host machine.
 *
 * The fix is to resolve the upstream PER REQUEST, in a process that starts
 * AFTER the environment is final. This file is that process. `next build`
 * still produces a perfectly normal `.next`; only the HTTP entrypoint changes.
 *
 * WebSockets: `next.config.js` rewrites could never be relied on for the
 * Socket.IO handshake anyway (a rewrite cannot survive an HTTP Upgrade, and
 * `skipTrailingSlashRedirect` had to be hand-tuned around it). Here the
 * `upgrade` event is handled by opening a raw TCP tunnel to the upstream, which
 * is exactly what a reverse proxy must do — 101 + bidirectional byte copy.
 *
 * Zero new dependencies: `http` and `net` are Node built-ins.
 */

"use strict";

const http = require("http");
const net = require("net");
const next = require("next");

const DEV = process.env.NODE_ENV !== "production";
const HOSTNAME = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3000;

/** Set PROXY_ENABLED=false to bypass the proxy entirely (Next handles routing). */
const PROXY_ENABLED = process.env.PROXY_ENABLED !== "false";

// ─────────────────────────────────────────────────────────────────────────────
// UPSTREAM CONNECTION POOL + FAULT TOLERANCE
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY A DEDICATED AGENT (the intermittent 502)
// ─────────────────────────────────────────────────────────────────────────────
// `http.request` with no `agent` falls back to `http.globalAgent`, which is
// unbounded (`maxSockets: Infinity`). Under a 1 Hz dashboard tick plus repeated
// /predict calls that opens a NEW TCP connection per request, and each one pays
// a fresh handshake — and, more importantly, the *stale-socket race* below
// becomes a daily event rather than a rare one.
//
// The race: this server keeps idle upstream sockets pooled (keep-alive). The
// upstream closes an idle socket after its OWN keepAliveTimeout. If we pick
// that socket out of the pool in the same instant, the write succeeds and the
// read returns ECONNRESET. That is an infrastructural artefact, NOT an upstream
// fault — the upstream never saw the request. Without an agent-level retry the
// client sees a bare 502 and the UI flashes "transport error".
//
// So: a bounded pool (fewer stale sockets to race) + one replay on a
// connection-phase reset that never produced a response byte.

const AGENT_KEEPALIVE_MSECS = Number(process.env.PROXY_KEEPALIVE_MS) || 30_000;
const AGENT_MAX_SOCKETS = Number(process.env.PROXY_MAX_SOCKETS) || 256;
const AGENT_MAX_FREE_SOCKETS = Number(process.env.PROXY_MAX_FREE_SOCKETS) || 32;
const RETRY_ENABLED = process.env.PROXY_RETRY_ENABLED !== "false";
const DEFAULT_RETRY_ATTEMPTS = RETRY_ENABLED ? 1 : 0;

/**
 * Retry budget, resolved PER REQUEST like the upstreams are.
 *
 * A module-load const would make this knob untestable and would contradict the
 * "read the environment at request time" contract the rest of this file keeps.
 */
function retryBudget() {
  const raw = process.env.PROXY_RETRY_ATTEMPTS;
  if (raw === undefined || raw === "") return DEFAULT_RETRY_ATTEMPTS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RETRY_ATTEMPTS;
}
/**
 * Bodies at or below this are buffered so a failed attempt can be replayed.
 * Above it (or when the length is unknown) the body is streamed and the request
 * is simply not retried — a spent stream cannot be rewound.
 */
const RETRYABLE_BODY_LIMIT = Number(process.env.PROXY_RETRY_BODY_LIMIT) || 1_048_576;

/**
 * Connection-phase failures that are safe to replay: the upstream never
 * returned a response byte, so it either never received the request or dropped
 * it while idle. Deliberately excludes errors that can occur mid-response.
 */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ESOCKETTIMEDOUT",
  "UND_ERR_SOCKET",
]);

/** One pool per upstream origin, created on first use and reused thereafter. */
const AGENTS = new Map();

function agentFor(upstream) {
  const key = `${upstream.protocol}//${upstream.host}:${upstream.port}`;
  let agent = AGENTS.get(key);
  if (!agent) {
    agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: AGENT_KEEPALIVE_MSECS,
      maxSockets: AGENT_MAX_SOCKETS,
      maxFreeSockets: AGENT_MAX_FREE_SOCKETS,
      // Sits ABOVE the upstream's own keepAliveTimeout so a pooled socket is
      // retired by the upstream first and we simply open a fresh one, rather
      // than us holding sockets the upstream considers dead.
      timeout: Number(process.env.PROXY_AGENT_TIMEOUT_MS) || 65_000,
    });
    AGENTS.set(key, agent);
  }
  return agent;
}


// ─────────────────────────────────────────────────────────────────────────────
// UPSTREAM RESOLUTION — read at REQUEST time, never at build time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip a trailing slash so `${base}${path}` never produces `//`.
 * Tolerates a missing scheme (`core-backend:4000`) by defaulting to http,
 * which is what compose service names produce.
 */
function normaliseTarget(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    // A path on the base (e.g. "http://core-backend:4000/api") is a
    // misconfiguration for a proxy base: joining paths would double it.
    const basePath = url.pathname.replace(/\/+$/, "");
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      // "" for the default, so `${prefix}${path}` is a clean join.
      prefix: basePath,
      protocol: url.protocol,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the upstream for a request from the CURRENT process environment.
 *
 * Called on every proxied request, so a `docker compose up -d` with different
 * env — or a plain `docker exec` change — takes effect with no rebuild. This
 * is the whole point of the file.
 */
function resolveUpstreams() {
  return {
    api: normaliseTarget(
      process.env.API_PROXY_URL || process.env.BACKEND_INTERNAL_URL,
    ),
    ai: normaliseTarget(
      process.env.AI_PROXY_URL || process.env.AI_ENGINE_INTERNAL_URL,
    ),
  };
}

/**
 * Paths under the proxied prefixes that Next.js itself must answer.
 *
 * `/api/healthz` is the container HEALTHCHECK target (see client-app/Dockerfile).
 * It MUST stay local: if it were proxied to core-backend, a slow or restarting
 * backend would report the FRONTEND unhealthy, and compose would restart the
 * frontend — a restart loop where a backend blip takes the UI down with it.
 */
const LOCAL_PATHS = new Set(["/api/healthz"]);

function isLocalPath(pathname) {
  return LOCAL_PATHS.has(pathname);
}

/**
 * Which upstream (if any) owns this request path?
 */
function matchRoute(pathname) {
  if (isLocalPath(pathname)) return null;
  if (pathname === "/health" || pathname === "/health/") {
    return { kind: "api", target: "api", rewrite: "/health" };
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return { kind: "api", target: "api", passthrough: true };
  }
  // engine.io-client ALWAYS requests "/socket.io/?EIO=4&transport=…". Both the
  // bare and the trailing-slash form are matched so the rewrite is independent
  // of the caller's slash habits.
  if (pathname === "/socket.io" || pathname.startsWith("/socket.io/")) {
    return { kind: "api", target: "api", passthrough: true };
  }
  // The AI engine's own paths are rooted ("/health", "/predict"), so "/ai/x"
  // maps to "/x" — NOT "/ai/x".
  if (pathname === "/ai" || pathname.startsWith("/ai/")) {
    return { kind: "ai", target: "ai", strip: "/ai", passthrough: true };
  }
  return null;
}

/** Rewrite the incoming URL for the chosen upstream. */
function rewriteUrl(rawUrl, route) {
  const [pathPart = "/", rawQuery] = String(rawUrl).split("?");
  if (route.rewrite) {
    return route.rewrite + (rawQuery ? `?${rawQuery}` : "");
  }
  let out = pathPart;
  if (route.strip && out.startsWith(route.strip)) {
    out = out.slice(route.strip.length) || "/";
  }
  if (route.passthrough) {
    return out + (rawQuery ? `?${rawQuery}` : "");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// HOP-BY-HOP HEADERS
// ─────────────────────────────────────────────────────────────────────────────
// RFC 9110 §7.6.1 / RFC 2616 §13.5.1: these are meaningful only for a single
// transport hop and MUST NOT be forwarded. Forwarding `connection: keep-alive`
// in particular desynchronises the two connections and yields hangs.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function buildForwardHeaders(req, upstream, isUpgrade = false) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (value !== undefined) headers[key] = value;
  }
  // The upstream must see ITS own Host, not the browser's, or vhost routing
  // and absolute-URL redirects are wrong.
  headers.host = upstream.port
    ? `${upstream.host}:${upstream.port}`
    : upstream.host;
  // Identify ourselves so upstream access logs stay readable.
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] =
    req.headers["x-forwarded-proto"] ||
    (req.socket.encrypted ? "https" : "http");
  // APPEND, do not overwrite. A CDN or tunnel (devtunnels, nginx) in front of
  // this proxy has already recorded the real client address; replacing the
  // chain with our immediate peer erases it, so upstream rate limiting and
  // abuse controls end up throttling the proxy instead of the client.
  const prior = req.headers["x-forwarded-for"];
  const peer = req.socket.remoteAddress || "";
  headers["x-forwarded-for"] = prior ? `${prior}, ${peer}` : peer;

  if (isUpgrade) {
    // ── HOP-BY-HOP HEADERS ARE REQUIRED ON THE UPGRADE PATH ──
    // Stripping them (correct for plain HTTP) would delete the very headers
    // that make this an upgrade: the upstream would never emit its 'upgrade'
    // event and would answer the handshake as an ordinary request — observed
    // as a bare HTTP 426 with no WebSocket. Restore them verbatim, and pin
    // `Connection: Upgrade` so a keep-alive Connection header from the
    // browser cannot override the upgrade.
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade || "websocket";
  }

  return headers;
}

/**
 * Loop guard.
 *
 * If an upstream resolves back to THIS server, proxying it would recurse until
 * the process dies of stack/memory exhaustion — the exact failure the
 * build-time rewrite caused (localhost:4000 == client-app). Refuse loudly
 * instead. `PROXY_ALLOW_SELF=true` is the escape hatch for a deliberate setup.
 */
function isSelf(upstream) {
  if (process.env.PROXY_ALLOW_SELF === "true") return false;
  if (upstream.port !== PORT) return false;
  return (
    upstream.host === "localhost" ||
    upstream.host === "127.0.0.1" ||
    upstream.host === "::1" ||
    upstream.host === HOSTNAME
  );
}

function sendProxyError(res, status, code, detail) {
  const body = JSON.stringify({ error: code, detail });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP PROXY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a transport failure onto an honest status.
 *
 * The previous code answered 502 for EVERY error, which is how a restarting
 * backend presented to users as "Bad Gateway". Refused and timed-out mean
 * "upstream not serving right now" (retryable, 503/504); only a genuinely
 * malformed exchange is a 502.
 */
function statusForError(err) {
  const code = (err && err.code) || "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || err.timedOut) {
    return { status: 504, code: "upstream_timeout" };
  }
  if (code === "ECONNREFUSED" || code === "EAI_AGAIN" || code === "ENOTFOUND") {
    return { status: 503, code: "upstream_unavailable" };
  }
  return { status: 502, code: "upstream_error" };
}

/**
 * Read the request body so a failed attempt can be replayed.
 *
 * A piped request stream is single-use, so a connection-phase failure could
 * only ever be surfaced as a 502. Buffering small bodies (the entire API
 * surface here is JSON — a /predict payload is tens of KB) buys a safe single
 * retry. Anything larger than the cap, or a chunked body, is streamed through
 * untouched and marked non-retryable rather than buffered without bound.
 */
function readRetryableBody(req) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return Promise.resolve({ body: Buffer.alloc(0), replayable: true });
  }

  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > RETRYABLE_BODY_LIMIT) {
    return Promise.resolve({ body: null, replayable: false, oversized: true });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;

    req.on("data", (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > RETRYABLE_BODY_LIMIT) {
        // Past the cap: stop accumulating and hand the request back for
        // streaming. Already-read bytes are retained by the caller.
        overflowed = true;
        chunks.length = 0;
        resolve({ body: null, replayable: false, overflowChunks: true, partialSize: size });
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) return;
      resolve({ body: Buffer.concat(chunks), replayable: true });
    });
    req.on("error", reject);
  });
}

/**
 * Perform one upstream attempt.
 *
 * `attempt` counts from 1 so the retry budget is enforced in one place.
 * Returns true when the request was dispatched (success OR a retryable
 * failure already scheduled) and false when the caller should stop.
 */
function dispatchUpstream({ req, res, route, upstream, targetPath, body, replayable, attempt }) {
  const headers = buildForwardHeaders(req, upstream);

  if (body) {
    // A replayed body must carry an accurate length: the original
    // `transfer-encoding: chunked` is hop-by-hop and was stripped, so without
    // this the upstream would wait for a body that never comes.
    headers["content-length"] = String(body.length);
    delete headers["transfer-encoding"];
  }

  const options = {
    host: upstream.host,
    port: upstream.port,
    method: req.method,
    path: `${upstream.prefix}${targetPath}`,
    headers,
    agent: agentFor(upstream),
  };

  let responded = false;
  let settled = false;
  const budget = retryBudget();

  const proxyReq = http.request(options, (proxyRes) => {
    responded = true;
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("response", () => {
    responded = true;
  });

  proxyReq.on("error", (err) => {
    if (settled) return;
    settled = true;

    if (res.headersSent || responded) {
      // The upstream already committed. Retrying could duplicate a processed
      // request, and any bytes already buffered downstream must be cut rather
      // than appended to — so tear the client connection down.
      res.destroy(err);
      return;
    }

    const canRetry =
      attempt <= budget &&
      replayable &&
      RETRYABLE_CODES.has((err && err.code) || "");

    if (canRetry) {
      // Connection-phase failure with no response byte: the upstream never
      // processed it (typically a pooled socket the upstream had just closed).
      // Replay once on a fresh socket.
      dispatchUpstream({
        req,
        res,
        route,
        upstream,
        targetPath,
        body,
        replayable,
        attempt: attempt + 1,
      });
      return;
    }

    const { status, code } = statusForError(err);
    sendProxyError(
      res,
      status,
      code,
      `${route.target} upstream ${upstream.host}:${upstream.port} failed: ${err.code || err.message}`,
    );
  });

  if (body) {
    proxyReq.end(body);
  } else {
    req.pipe(proxyReq);
  }
  return true;
}

function proxyHttp(req, res) {
  const pathname = String(req.url || "/").split("?")[0];
  const route = matchRoute(pathname);
  if (!route) return null;

  const upstreams = resolveUpstreams();
  const upstream = upstreams[route.target];

  if (!upstream) {
    sendProxyError(
      res,
      503,
      "upstream_not_configured",
      `${route.target.toUpperCase()} proxy target is not set. ` +
        `Set ${route.target === "api" ? "API_PROXY_URL" : "AI_PROXY_URL"} in the runtime environment.`,
    );
    return true;
  }
  if (isSelf(upstream)) {
    sendProxyError(
      res,
      500,
      "upstream_is_self",
      `${route.target.toUpperCase()} proxy target ${upstream.host}:${upstream.port} points at this server — refusing to proxy to self.`,
    );
    return true;
  }

  const targetPath = rewriteUrl(req.url, route);

  readRetryableBody(req).then(
    ({ body, replayable }) => {
      dispatchUpstream({
        req,
        res,
        route,
        upstream,
        targetPath,
        body,
        // A streamed body can never be rewound, so a retry is unsafe.
        replayable: replayable && Boolean(body),
        attempt: 1,
      });
    },
    (err) => {
      if (res.headersSent) return res.destroy(err);
      sendProxyError(res, 400, "request_body_error", String(err));
    },
  );

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET / UPGRADE TUNNEL
// ─────────────────────────────────────────────────────────────────────────────

function proxyUpgrade(req, socket, head) {
  const pathname = String(req.url || "/").split("?")[0];
  const route = matchRoute(pathname);
  if (!route) return false;

  const upstreams = resolveUpstreams();
  const upstream = upstreams[route.target];
  if (!upstream || isSelf(upstream)) {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n\r\n",
    );
    return true;
  }

  // `net.connect` (not `http.request`) because a WS upgrade is an opaque byte
  // tunnel: we forward the original handshake verbatim and thereafter copy
  // bytes both ways until either side closes.
  const upstreamSocket = net.connect(
    { host: upstream.host, port: upstream.port },
    () => {
      const requestLine = `GET ${upstream.prefix}${rewriteUrl(req.url, route)} HTTP/1.1\r\n`;
      // isUpgrade=true: the handshake NEEDS Connection/Upgrade forwarded.
      const headers = buildForwardHeaders(req, upstream, true);
      const raw = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      upstreamSocket.write(`${requestLine}${raw}\r\n\r\n`);
      if (head && head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    },
  );

  // ── IDLE TIMERS: the reconnect-storm fix ──────────────────────────────────
  // Socket.IO's engine pings every 25s (pingInterval, socket.config.ts) and
  // prunes after 20s (pingTimeout), so a healthy tunnel can legitimately be
  // silent for up to ~25s. The previous 30s upstream timer left only 5s of
  // margin: one event-loop stall or one slow hop made the proxy destroy a
  // perfectly good connection, the client saw `transport close`, and the whole
  // terminal reconnected — repeatedly, since each reconnect re-armed the race.
  //
  // The timeout must sit ABOVE the heartbeat with real headroom, and it must
  // only ever prune a genuinely wedged pipe. 75s clears a full
  // pingInterval+pingTimeout cycle (45s) even if several beats are late.
  const wsIdleTimeout = Number(process.env.PROXY_WS_IDLE_TIMEOUT_MS) || 75_000;
  upstreamSocket.setTimeout(wsIdleTimeout, () => upstreamSocket.destroy());
  socket.setTimeout(wsIdleTimeout, () => socket.destroy());
  // Nagle would coalesce small Socket.IO frames behind a 40ms delay, adding
  // visible latency to every tick; the tunnel is latency-sensitive, not
  // bandwidth-sensitive.
  upstreamSocket.setNoDelay(true);
  socket.setNoDelay?.(true);

  const teardown = () => {
    upstreamSocket.destroy();
    socket.destroy();
  };
  upstreamSocket.on("error", (err) => {
    console.error(
      `[proxy] websocket upstream error for ${pathname} → ` +
        `${upstream.host}:${upstream.port}: ${err.code || err.message}`,
    );
    teardown();
  });
  socket.on("error", teardown);
  upstreamSocket.on("close", () => socket.end());
  socket.on("close", () => upstreamSocket.end());
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

function start() {
  const app = next({ dev: DEV, hostname: HOSTNAME, port: PORT });

  // Next 15.5: getRequestHandler()/getUpgradeHandler() throw "prepare() must
  // be called" unless app.prepare() resolved first (Next 14 allowed lazy
  // prepare). The handlers are built AFTER prepare completes.
  return app.prepare().then(() => {
    const handle = app.getRequestHandler();
    const nextUpgradeHandler =
      typeof app.getUpgradeHandler === "function" ? app.getUpgradeHandler() : null;

    const server = http.createServer((req, res) => {
      if (PROXY_ENABLED) {
        try {
          if (proxyHttp(req, res)) return;
        } catch (err) {
          console.error(`[proxy] internal error: ${err && err.stack}`);
          if (!res.headersSent) {
            sendProxyError(res, 500, "proxy_internal_error", String(err));
          } else {
            res.end();
          }
          return;
        }
      }
      handle(req, res);
    });

    server.on("upgrade", (req, socket, head) => {
      if (PROXY_ENABLED) {
        try {
          if (proxyUpgrade(req, socket, head)) return;
        } catch (err) {
          console.error(`[proxy] upgrade error: ${err && err.stack}`);
          socket.destroy();
          return;
        }
      }
      // Not a proxied path: let Next own it (dev HMR, or nothing in prod).
      if (nextUpgradeHandler) nextUpgradeHandler(req, socket, head);
      else socket.destroy();
    });

    // 4 GB VPS: cap the accept backlog and keep sockets from lingering forever.
    server.maxConnections = 512;
    server.headersTimeout = 65_000;
    server.requestTimeout = 300_000;
    server.keepAliveTimeout = 61_000;

    server.listen(PORT, HOSTNAME, () => {
      const { api, ai } = resolveUpstreams();
      console.log(
        [
          "",
          "  ▸ Next.js runtime proxy ready",
          `    mode           : ${DEV ? "development" : "production"}`,
          `    listening      : http://${HOSTNAME}:${PORT}`,
          `    API_PROXY_URL  : ${api ? `${api.protocol}//${api.host}:${api.port}${api.prefix}` : "(unset)"}`,
          `    AI_PROXY_URL   : ${ai ? `${ai.protocol}//${ai.host}:${ai.port}${ai.prefix}` : "(unset)"}`,
          `    proxying       : /api/*  /socket.io/*  /ai/*  /health  (resolved per request)`,
          "",
        ].join("\n"),
      );
    });

    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.on(signal, () => {
        console.log(`[server] ${signal} received — draining`);
        server.close(() => process.exit(0));
        // Do not wait forever on lingering keep-alive sockets.
        setTimeout(() => process.exit(0), 10_000).unref();
      });
    }

    return server;
  });
}

// Pure helpers are exported for unit tests; requiring this file must NOT boot
// a server as a side effect.
module.exports = {
  start,
  matchRoute,
  rewriteUrl,
  normaliseTarget,
  resolveUpstreams,
  buildForwardHeaders,
  isSelf,
  statusForError,
  agentFor,
  proxyHttp,
  retryBudget,
  RETRYABLE_CODES,
  DEFAULT_RETRY_ATTEMPTS,
  RETRYABLE_BODY_LIMIT,
  AGENTS,
  LOCAL_PATHS,
};

if (require.main === module) {
  start().catch((err) => {
    console.error("[server] fatal startup error:", err);
    process.exit(1);
  });
}
