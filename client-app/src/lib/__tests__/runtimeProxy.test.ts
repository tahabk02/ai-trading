/**
 * Runtime proxy resolution — regression guard for the BUILD-TIME REWRITE BLOCKER.
 *
 * ── The failure this locks out ──────────────────────────────────────────────
 * `next.config.js` `rewrites()` is evaluated once, during `next build`, and the
 * expanded destinations are frozen into `.next/routes-manifest.json`. Setting
 * `API_PROXY_URL` in `docker-compose.prod.yml` therefore had NO effect: the
 * build-time fallback `http://localhost:4000` was baked in, and inside the
 * client-app container `localhost:4000` is client-app itself, so every
 * `/api/*` request looped back into the Next server and 404'd.
 *
 * The proxy now lives in `client-app/server.js` and resolves its upstreams
 * from the live process environment PER REQUEST. These tests pin that
 * contract, plus the routing table and the self-proxy loop guard.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// server.js is CommonJS. Requiring it must NOT boot a server (guarded by
// `require.main === module`), so it is safe to import here.
// Path: src/lib/__tests__/ -> ../../../  ==  client-app/
const proxy = require("../../../server.js") as {
  matchRoute: (pathname: string) => null | Record<string, unknown>;
  rewriteUrl: (rawUrl: string, route: Record<string, unknown>) => string;
  normaliseTarget: (raw: string) => null | Record<string, unknown>;
  resolveUpstreams: () => { api: unknown; ai: unknown };
  buildForwardHeaders: (
    req: unknown,
    upstream: unknown,
    isUpgrade?: boolean,
  ) => Record<string, string>;
  isSelf: (upstream: unknown) => boolean;
  statusForError: (err: unknown) => { status: number; code: string };
  agentFor: (upstream: unknown) => unknown;
  RETRYABLE_CODES: Set<string>;
  retryBudget: () => number;
  DEFAULT_RETRY_ATTEMPTS: number;
};

const ENV_KEYS = ["API_PROXY_URL", "AI_PROXY_URL"] as const;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => setEnv({}));

describe("normaliseTarget", () => {
  it("parses a compose service target", () => {
    expect(proxy.normaliseTarget("http://core-backend:4000")).toEqual({
      host: "core-backend",
      port: 4000,
      prefix: "",
      protocol: "http:",
    });
  });

  it("defaults a scheme-less service name to http (compose style)", () => {
    expect(proxy.normaliseTarget("ai-engine:8000")).toEqual({
      host: "ai-engine",
      port: 8000,
      prefix: "",
      protocol: "http:",
    });
  });

  it("strips a trailing slash from a base path so joins stay clean", () => {
    const t = proxy.normaliseTarget("http://core-backend:4000/");
    expect(t?.prefix).toBe("");
  });

  it("returns null for empty/garbage input instead of throwing", () => {
    expect(proxy.normaliseTarget("")).toBeNull();
    expect(proxy.normaliseTarget("   ")).toBeNull();
    expect(proxy.normaliseTarget("http://")).toBeNull();
  });
});

describe("upstreams resolve at REQUEST time, not build time", () => {
  it("reflects an env change immediately, with no rebuild", () => {
    setEnv({ API_PROXY_URL: "http://core-backend:4000" });
    expect(proxy.resolveUpstreams().api).toMatchObject({
      host: "core-backend",
      port: 4000,
    });

    // Same process, same module instance — only the environment changed.
    setEnv({ API_PROXY_URL: "http://10.0.0.5:4000" });
    expect(proxy.resolveUpstreams().api).toMatchObject({
      host: "10.0.0.5",
      port: 4000,
    });
  });

  it("reports an unset upstream as null so the proxy can 503 loudly", () => {
    setEnv({});
    expect(proxy.resolveUpstreams().api).toBeNull();
    expect(proxy.resolveUpstreams().ai).toBeNull();
  });
});

describe("routing table", () => {
  it("routes the REST API to the api upstream", () => {
    const route = proxy.matchRoute("/api/v1/predict");
    expect(route).toMatchObject({ target: "api", passthrough: true });
  });

  it("routes BOTH socket.io forms, incl. the trailing-slash handshake", () => {
    // engine.io-client always requests "/socket.io/?EIO=4&transport=polling".
    expect(proxy.matchRoute("/socket.io/")).toMatchObject({ target: "api" });
    expect(proxy.matchRoute("/socket.io")).toMatchObject({ target: "api" });
    expect(proxy.matchRoute("/socket.io/?EIO=4")).toMatchObject({
      target: "api",
    });
  });

  it("routes /ai to the ai upstream and strips the /ai prefix", () => {
    const route = proxy.matchRoute("/ai/api/v1/predict");
    expect(route).toMatchObject({ target: "ai", strip: "/ai" });
    expect(proxy.rewriteUrl("/ai/api/v1/predict?x=1", route!)).toBe(
      "/api/v1/predict?x=1",
    );
  });

  it("maps bare /health to the backend root health, not /api/v1/health", () => {
    const route = proxy.matchRoute("/health");
    expect(route).toMatchObject({ target: "api", rewrite: "/health" });
    expect(proxy.rewriteUrl("/health", route!)).toBe("/health");
  });

  it("keeps /api/healthz LOCAL so a backend blip cannot restart the frontend", () => {
    // It is the Docker HEALTHCHECK target. If proxied, a slow core-backend
    // would mark client-app unhealthy and compose would restart the UI.
    expect(proxy.matchRoute("/api/healthz")).toBeNull();
  });

  it("does not hijack the app's own routes", () => {
    for (const p of ["/", "/dashboard", "/pro", "/_next/static/chunk.js", "/favicon.ico"]) {
      expect(proxy.matchRoute(p)).toBeNull();
    }
  });

  it("preserves the query string on a passthrough rewrite", () => {
    const route = proxy.matchRoute("/api/v1/ticks")!;
    expect(proxy.rewriteUrl("/api/v1/ticks?symbols=EUR%2FUSD&limit=50", route)).toBe(
      "/api/v1/ticks?symbols=EUR%2FUSD&limit=50",
    );
  });
});

describe("hop-by-hop header handling", () => {
  const upstream = { host: "core-backend", port: 4000, prefix: "" };
  const fakeReq = (headers: Record<string, string>) =>
    ({
      headers,
      socket: { remoteAddress: "10.0.0.9", encrypted: false },
    }) as never;

  it("strips hop-by-hop headers on the PLAIN HTTP path (RFC 9110 7.6.1)", () => {
    // Forwarding connection/transfer-encoding desynchronises the two
    // connections and produces hangs.
    const h = proxy.buildForwardHeaders(
      fakeReq({
        host: "trade.example.com",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        "content-type": "application/json",
      }),
      upstream,
    );
    expect(h["transfer-encoding"]).toBeUndefined();
    expect(h.connection).toBeUndefined();
    // End-to-end headers survive.
    expect(h["content-type"]).toBe("application/json");
  });

  it("RE-FORWARDS Connection/Upgrade on the UPGRADE path", () => {
    // REGRESSION GUARD. Stripping hop-by-hop headers is correct for plain HTTP
    // but WRONG for an upgrade: the upstream never sees `Upgrade: websocket`,
    // so it never emits its 'upgrade' event and answers the handshake as an
    // ordinary request. Observed end to end as a bare `HTTP 426 upgrade
    // required` with no WebSocket — the live Socket.IO feed silently dead.
    const h = proxy.buildForwardHeaders(
      fakeReq({
        host: "trade.example.com",
        connection: "keep-alive",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      }),
      upstream,
      true,
    );
    expect(h.connection).toBe("Upgrade");
    expect(h.upgrade).toBe("websocket");
    // The handshake credentials MUST survive untouched.
    expect(h["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(h["sec-websocket-version"]).toBe("13");
  });

  it("rewrites Host to the upstream and keeps X-Forwarded-*", () => {
    const h = proxy.buildForwardHeaders(
      fakeReq({ host: "trade.example.com" }),
      upstream,
    );
    expect(h.host).toBe("core-backend:4000");
    expect(h["x-forwarded-host"]).toBe("trade.example.com");
    expect(h["x-forwarded-for"]).toBe("10.0.0.9");
    expect(h["x-forwarded-proto"]).toBe("http");
  });
});

describe("self-proxy loop guard", () => {
  it("refuses an upstream that points back at this server", () => {
    // This is precisely the build-time-rewrite failure mode: the baked default
    // http://localhost:4000 is client-app ITSELF, so proxying it recursed
    // until the process died.
    process.env.PORT = "3000";
    expect(proxy.isSelf({ host: "localhost", port: 3000 })).toBe(true);
    expect(proxy.isSelf({ host: "127.0.0.1", port: 3000 })).toBe(true);
    // A genuinely different backend is fine.
    expect(proxy.isSelf({ host: "core-backend", port: 4000 })).toBe(false);
    // Same host, different port, is not a loop.
    expect(proxy.isSelf({ host: "localhost", port: 4000 })).toBe(false);
  });
});

describe("502 fault tolerance", () => {
  it("reports a refused upstream as 503, not 502", () => {
    // A restarting backend is "unavailable", not a bad gateway. The previous
    // blanket 502 made every restart look like a proxy fault.
    expect(proxy.statusForError({ code: "ECONNREFUSED" })).toEqual({
      status: 503,
      code: "upstream_unavailable",
    });
    expect(proxy.statusForError({ code: "EAI_AGAIN" }).status).toBe(503);
    expect(proxy.statusForError({ code: "ENOTFOUND" }).status).toBe(503);
  });

  it("reports a timed-out upstream as 504", () => {
    expect(proxy.statusForError({ code: "ETIMEDOUT" })).toEqual({
      status: 504,
      code: "upstream_timeout",
    });
    expect(proxy.statusForError({ timedOut: true }).status).toBe(504);
  });

  it("reserves 502 for a genuinely malformed exchange", () => {
    expect(proxy.statusForError({ code: "EPROTO" }).status).toBe(502);
    expect(proxy.statusForError({}).status).toBe(502);
  });

  it("classifies connection-phase resets as replayable", () => {
    // The stale-keep-alive race: the upstream closed a pooled socket and the
    // write landed in the same instant. The request never reached the app.
    for (const code of ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"]) {
      expect(proxy.RETRYABLE_CODES.has(code), code).toBe(true);
    }
  });

  it("excludes errors that can only occur MID-response", () => {
    // Retrying after the upstream committed risks duplicating a processed
    // request, so these are never replayed.
    for (const code of ["ECONNRESET_MID", "ERR_STREAM", "EADDRINUSE"]) {
      expect(proxy.RETRYABLE_CODES.has(code), code).toBe(false);
    }
  });

  it("enables a bounded retry budget by default (one replay)", () => {
    expect(proxy.DEFAULT_RETRY_ATTEMPTS).toBe(1);
  });

  it("resolves the retry budget per request, not at module load", () => {
    expect(proxy.retryBudget()).toBe(1);
    process.env.PROXY_RETRY_ATTEMPTS = "0";
    expect(proxy.retryBudget()).toBe(0);
    process.env.PROXY_RETRY_ATTEMPTS = "3";
    expect(proxy.retryBudget()).toBe(3);
    // Garbage falls back to the default rather than disabling safety.
    process.env.PROXY_RETRY_ATTEMPTS = "banana";
    expect(proxy.retryBudget()).toBe(1);
    delete process.env.PROXY_RETRY_ATTEMPTS;
  });

  it("reuses ONE pooled keep-alive agent per upstream origin", () => {
    // An unbounded global agent opened a new TCP connection per dashboard
    // tick, which is what made the stale-socket race frequent.
    const a = proxy.agentFor({ host: "core-backend", port: 4000, prefix: "" });
    const b = proxy.agentFor({ host: "core-backend", port: 4000, prefix: "" });
    const c = proxy.agentFor({ host: "ai-engine", port: 8000, prefix: "" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("forwarded-chain integrity", () => {
  const upstream = { host: "core-backend", port: 4000, prefix: "" };
  const fakeReq = (headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress: "10.0.0.9", encrypted: false } }) as never;

  it("APPENDS to an existing X-Forwarded-For instead of overwriting it", () => {
    // A tunnel/CDN in front of the proxy already recorded the real client.
    // Overwriting collapsed the chain to our immediate peer, so upstream rate
    // limiting throttled the PROXY rather than the client.
    const h = proxy.buildForwardHeaders(
      fakeReq({ host: "h", "x-forwarded-for": "203.0.113.7" }),
      upstream,
    );
    expect(h["x-forwarded-for"]).toBe("203.0.113.7, 10.0.0.9");
  });

  it("sets X-Forwarded-For when no prior chain exists", () => {
    const h = proxy.buildForwardHeaders(fakeReq({ host: "h" }), upstream);
    expect(h["x-forwarded-for"]).toBe("10.0.0.9");
  });
});

describe("build-time rewrite guard", () => {
  it("next.config.js must not reintroduce baked proxy destinations", () => {
    // A non-empty rewrites() would re-freeze destinations into
    // routes-manifest.json and reintroduce Blocker 1.
    const src = require("node:fs").readFileSync(
      new URL("../../../next.config.js", import.meta.url),
      "utf8",
    ) as string;

    // Strip comments so the documentation block does not trip the assertion.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // No destination template may be built from process.env here.
    expect(code, "next.config.js must not interpolate env into rewrites()").not.toMatch(
      /destination\s*:/,
    );
    // The routing table lives in server.js, not next.config.js.
    expect(code).not.toMatch(/API_PROXY_URL/);
    expect(code).not.toMatch(/AI_PROXY_URL/);
  });
});
