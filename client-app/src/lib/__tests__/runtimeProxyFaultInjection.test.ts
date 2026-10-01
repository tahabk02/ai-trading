/**
 * FUNCTIONAL fault-injection test for the 502 fix.
 *
 * ── The intermittent 502 this locks out ──────────────────────────────────────
 * The proxy pools idle upstream sockets for keep-alive. The upstream closes an
 * idle socket after ITS own keepAliveTimeout. If the proxy picks that socket
 * out of the pool in the same instant, the write lands and the read returns
 * ECONNRESET. The upstream never saw the request — it is an infrastructural
 * race, not an upstream fault — yet the user saw a bare 502 and the UI flashed
 * "transport error".
 *
 * These tests drive the REAL `proxyHttp` against a REAL upstream that reproduces
 * the race, so the retry is proven rather than assumed. Unit tests of the pure
 * helpers cannot catch a wiring mistake here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const proxy = require("../../../server.js") as {
  proxyHttp: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  AGENTS: Map<string, unknown>;
};

// Every server/socket opened by these tests, torn down afterwards.
const closers: Array<() => void> = [];

afterEach(async () => {
  while (closers.length) {
    try {
      closers.pop()!();
    } catch {
      /* already closed */
    }
  }
  // Drop pooled sockets so one test's dead upstream cannot leak into the next.
  for (const agent of proxy.AGENTS.values()) {
    (agent as { destroy?: () => void }).destroy?.();
  }
  proxy.AGENTS.clear();
  for (const key of ["API_PROXY_URL", "PROXY_RETRY_ATTEMPTS", "PROXY_RETRY_ENABLED"]) {
    delete process.env[key];
  }
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** A proxy in front of `upstreamPort`, exposing the real proxyHttp. */
async function startProxy(upstreamPort: number): Promise<number> {
  process.env.API_PROXY_URL = `http://127.0.0.1:${upstreamPort}`;
  const server = http.createServer((req, res) => {
    if (!proxy.proxyHttp(req, res)) {
      res.writeHead(404).end("unrouted");
    }
  });
  closers.push(() => server.close());
  return listen(server);
}

/** Send one request through the proxy and capture the response. */
function request(
  port: number,
  opts: { method?: string; path?: string; body?: string } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/api/thing",
        headers: opts.body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("proxy 502 fault tolerance — live connection reset", () => {
  it("REPLAYS a request when the upstream resets a pooled socket", async () => {
    let upstreamHits = 0;
    const seenBodies: string[] = [];

    const upstream = http.createServer((req, res) => {
      upstreamHits++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seenBodies.push(body);
        // First contact: destroy the socket WITHOUT responding — exactly what
        // a server retiring an idle keep-alive connection looks like.
        if (upstreamHits === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, hits: upstreamHits }));
      });
    });
    closers.push(() => upstream.close());
    const upstreamPort = await listen(upstream);
    const proxyPort = await startProxy(upstreamPort);

    const res = await request(proxyPort, {
      method: "POST",
      path: "/api/v1/predict",
      body: JSON.stringify({ symbol: "EUR/USD" }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, hits: 2 });
    // The replayed request must carry the ORIGINAL body intact — this is the
    // whole reason the body is buffered rather than piped.
    expect(seenBodies).toHaveLength(2);
    for (const b of seenBodies) expect(b).toBe(JSON.stringify({ symbol: "EUR/USD" }));
  });

  it("sends a correct content-length on the replayed body", async () => {
    // `transfer-encoding: chunked` is hop-by-hop and is stripped, so without an
    // explicit content-length the upstream waits forever for a body that never
    // comes — a hang instead of a 502.
    const lengths: Array<string | undefined> = [];
    let hits = 0;
    const upstream = http.createServer((req, res) => {
      hits++;
      lengths.push(req.headers["content-length"]);
      req.on("data", () => {});
      req.on("end", () => {
        if (hits === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    closers.push(() => upstream.close());
    const proxyPort = await startProxy(await listen(upstream));

    const res = await request(proxyPort, {
      method: "POST",
      body: JSON.stringify({ symbol: "EUR/USD", timeframe: "1m" }),
    });

    expect(res.status).toBe(200);
    const expected = String(Buffer.byteLength(JSON.stringify({ symbol: "EUR/USD", timeframe: "1m" })));
    expect(lengths).toHaveLength(2);
    for (const l of lengths) expect(l).toBe(expected);
  });

  it("stops after the retry budget instead of retrying forever", async () => {
    // A genuinely dead upstream must not be retried indefinitely. An accepted
    // connection that is then reset is NOT "unavailable" (503) — the upstream
    // took the request and died mid-exchange, which is a 502.
    let hits = 0;
    const upstream = http.createServer((req, res) => {
      hits++;
      req.socket.destroy();
      void res;
    });
    closers.push(() => upstream.close());
    const proxyPort = await startProxy(await listen(upstream));

    const res = await request(proxyPort, { path: "/api/thing" });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toBe("upstream_error");
    // Initial attempt + exactly one replay, then it gives up.
    expect(hits).toBe(2);
  });

  it("reports 503 immediately when the upstream refuses connections", async () => {
    // Bind then immediately release a port so nothing is listening on it.
    const dead = net.createServer();
    const deadPort = await new Promise<number>((resolve) => {
      dead.listen(0, "127.0.0.1", () => resolve((dead.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const proxyPort = await startProxy(deadPort);

    const res = await request(proxyPort, { path: "/api/thing" });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toBe("upstream_unavailable");
  });

  it("passes a healthy request straight through, and reuses the pool", async () => {
    let hits = 0;
    const upstream = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
    closers.push(() => upstream.close());
    const proxyPort = await startProxy(await listen(upstream));

    for (let i = 0; i < 5; i++) {
      const res = await request(proxyPort, { path: "/api/thing" });
      expect(res.status).toBe(200);
    }
    expect(hits).toBe(5);
    // One pooled agent for this origin, reused across all five calls.
    expect(proxy.AGENTS.size).toBe(1);
  });

  it("honours PROXY_RETRY_ATTEMPTS=0 by disabling replay", async () => {
    process.env.PROXY_RETRY_ATTEMPTS = "0";
    let hits = 0;
    const upstream = http.createServer((req, res) => {
      hits++;
      req.socket.destroy();
      void res;
    });
    closers.push(() => upstream.close());
    const proxyPort = await startProxy(await listen(upstream));

    const res = await request(proxyPort, { path: "/api/thing" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(hits).toBe(1);
  });

  it("never proxies the container HEALTHCHECK to the backend", async () => {
    let hits = 0;
    const upstream = http.createServer((req, res) => {
      hits++;
      res.writeHead(200).end("upstream");
    });
    closers.push(() => upstream.close());
    const proxyPort = await startProxy(await listen(upstream));

    const res = await request(proxyPort, { path: "/api/healthz" });
    // Not routed upstream — the caller (Next) answers it locally.
    expect(hits).toBe(0);
    expect(res.status).toBe(404);
  });
});
