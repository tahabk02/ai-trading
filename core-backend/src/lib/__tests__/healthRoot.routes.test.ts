import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import express from "express";
import http from "node:http";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {},
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const secretsMock = vi.hoisted(() => {
  const value: Record<string, string> = {
    AI_ENGINE_URL: "http://127.0.0.1:8000",
    AI_ENGINE_API_KEY: "test",
    PO_HEALTH_ADMIN_KEY: "",
    PO_HEALTH_HOSTED: "",
  };
  return { value };
});
vi.mock("../../config/secrets", () => ({
  secrets: secretsMock.value,
}));
vi.mock("../../services/cache.service", () => ({
  CacheService: { getInstance: () => ({ isConnected: () => false }) },
}));
vi.mock("../../services/forexData.service", () => ({
  forexDataService: {
    getSourceHealth: () => [
      { name: "pocket_option", ok: true, lastCheck: "2026-09-14T00:00:00Z", lastError: null },
    ],
  },
}));

const axiosMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  create: vi.fn(() => ({
    get: axiosMock.get,
    post: axiosMock.post,
    put: axiosMock.put,
    delete: axiosMock.delete,
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  })),
}));
vi.mock("axios", () => ({
  default: {
    get: axiosMock.get,
    post: axiosMock.post,
    put: axiosMock.put,
    delete: axiosMock.delete,
    create: axiosMock.create,
  },
}));

import { poAuthRefreshGuard, rootHealthBody, rootHealthRouter } from "../../routes/health.routes";
import { realtimeTickBuffer } from "../../services/realtimeTickBuffer.service";

type JsonBody = Record<string, unknown>;
const capture = (): {
  res: Response;
  calls: { code: number; body: JsonBody }[];
  done: Promise<void>;
} => {
  const calls: { code: number; body: JsonBody }[] = [];
  let statusCode = 200;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    statusCode,
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: JsonBody) {
      calls.push({ code: statusCode, body });
      resolveDone();
      return res;
    },
  } as unknown as Response;
  return { res, calls, done };
};

function findLayer(path: string) {
  return rootHealthRouter.stack.find(
    (layer) =>
      layer.route &&
      (layer.route.path === path ||
        (path === "/" && layer.route.path === "")) &&
      layer.route.methods?.get === true,
  );
}

async function dispatch(
  path: string,
  axiosReply?: { data: unknown },
): Promise<{ calls: { code: number; body: JsonBody }[] }> {
  if (axiosReply) axiosMock.get.mockResolvedValue(axiosReply);
  const target = capture();
  const layer = findLayer(path);
  expect(layer).toBeDefined();
  const handle = layer!.route!.stack[0].handle;
  await (handle as (req: Request, res: Response, next: () => void) => void)(
    {} as Request,
    target.res,
    () => {},
  );
  await target.done;
  return { calls: target.calls };
}

describe("ROOT GET /health (MASTER MISSION 1.3 — autopilot probe)", () => {
  beforeEach(() => {
    axiosMock.get.mockReset();
  });

  it("test_health_returns_200 — root /health answers 200 with status ok + uptime + version", async () => {
    const body = rootHealthBody();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);

    const { calls } = await dispatch("/");
    expect(calls.length).toBe(1);
    const { code, body: dispatched } = calls[0];
    expect(code).toBe(200);
    expect(dispatched.status).toBe("ok");
    expect(typeof dispatched.uptime).toBe("number");
    expect(dispatched.version).toBe(body.version);
  });

  it("test_health_ai_returns_200 — root /health/ai answers 200 JSON {status, latency_ms, last_error}", async () => {
    const { calls } = await dispatch("/ai", { data: { status: "up" } });
    expect(calls.length).toBe(1);
    const { code, body } = calls[0];
    expect(code).toBe(200);
    expect(body.status).toBe("up");
    expect(typeof body.latency_ms).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });

  it("test_health_mount_end_to_end — app.use('/health', rootHealthRouter) answers /health, /health/ai", async () => {
    expect(axiosMock.get).toBeTruthy();
    const request =
      (await import("node:http")).request as typeof http.request;
    const app = express();
    app.use("/health", rootHealthRouter);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const get = (path: string): Promise<{ status: number; body: unknown }> =>
      new Promise((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path, method: "GET" },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      axiosMock.get.mockResolvedValue({ data: { status: "up" } });
      const root = await get("/health");
      expect(root.status).toBe(200);
      expect((root.body as JsonBody).status).toBe("ok");
      expect(typeof (root.body as JsonBody).version).toBe("string");
      const ai = await get("/health/ai");
      expect(ai.status).toBe(200);
      expect((ai.body as JsonBody).status).toBe("up");
      const data = await get("/health/data");
      expect(data.status).toBe(200);
      expect(Array.isArray((data.body as JsonBody).sources)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("test_health_data_returns_200 — root /health/data answers 200 JSON {status, sources}", async () => {
    const { calls } = await dispatch("/data");
    expect(calls.length).toBe(1);
    const { code, body } = calls[0];
    expect(code).toBe(200);
    expect(body.status).toBe("ok");
    expect(Array.isArray(body.sources)).toBe(true);
  });

  it("test_health_orderbook_returns_200 — root /health/orderbook answers 200 JSON {status, latency_ms, last_ok_ts}", async () => {
    const { calls } = await dispatch("/orderbook");
    expect(calls.length).toBe(1);
    const { code, body } = calls[0];
    expect(code).toBe(200);
    expect(typeof body.latency_ms).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });

  it("test_health_ticks_returns_tape — root /health/ticks dumps the last-N tape (PART 43.5 [472])", async () => {
    const sym = "TICKS/TEST";
    realtimeTickBuffer.clearSymbol(sym);
    // A static market proxy re-served: constant price, non-PO source.
    realtimeTickBuffer.append(sym, 1.2345, { source: "frankfurter" });
    realtimeTickBuffer.append(sym, 1.2345, { source: "frankfurter" });
    const layer = findLayer("/ticks");
    expect(layer).toBeDefined();
    const target = capture();
    const handle = layer!.route!.stack[0].handle as (
      req: Request,
      res: Response,
      next: () => void,
    ) => void;
    handle(
      { query: { symbol: sym, n: "2" } } as unknown as Request,
      target.res,
      () => {},
    );
    await target.done;
    const { code, body } = target.calls[0];
    const tape = body as {
      count: number;
      allPricesConstant: boolean;
      newestSourceIsPo: boolean;
      ticks: unknown[];
    };
    expect(code).toBe(200);
    expect(tape.count).toBe(2);
    expect(tape.allPricesConstant).toBe(true);
    expect(tape.newestSourceIsPo).toBe(false);
    expect(Array.isArray(tape.ticks)).toBe(true);
  });

  it("test_health_po_auth_returns_snapshot — root /health/po-auth returns the SSID self-healing posture", async () => {
    const { calls } = await dispatch("/po-auth");
    expect(calls.length).toBe(1);
    const { code, body } = calls[0];
    expect(code).toBe(200);
    const snap = body as {
      credentialFallback: { available: boolean; emailMasked: unknown };
      session: { filePresent: boolean };
      refreshScript: { present: boolean };
      refresh: { inFlight: boolean };
    };
    expect(typeof snap.credentialFallback.available).toBe("boolean");
    expect(typeof snap.session.filePresent).toBe("boolean");
    expect(typeof snap.refreshScript.present).toBe("boolean");
    expect(typeof snap.refresh.inFlight).toBe("boolean");
  });
});

describe("PART 43.6 [480] — po-auth mutating endpoints are gated", () => {
  afterEach(() => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "";
    secretsMock.value.PO_HEALTH_HOSTED = "";
  });

  const routeStack = (method: string, path: string) => {
    const layer = rootHealthRouter.stack.find(
      (l) =>
        l.route !== undefined &&
        l.route.path === path &&
        l.route.methods?.[method] === true,
    );
    return layer?.route?.stack ?? [];
  };

  it("POST /po-auth/refresh mounts the guard as its FIRST middleware", () => {
    const stack = routeStack("post", "/po-auth/refresh");
    expect(stack.length).toBeGreaterThanOrEqual(2);
    expect(stack[0].handle).toBe(poAuthRefreshGuard);
  });

  it("POST /po-auth/reset mounts the guard as its FIRST middleware", () => {
    const stack = routeStack("post", "/po-auth/reset");
    expect(stack.length).toBeGreaterThanOrEqual(2);
    expect(stack[0].handle).toBe(poAuthRefreshGuard);
  });

  function guarded(args: { ip?: string; key?: string }): {
    passed: boolean;
    status: number;
  } {
    const req = {
      ip: args.ip ?? "127.0.0.1",
      get: (name: string) =>
        name.toLowerCase() === "x-po-admin-key" ? args.key ?? "" : undefined,
    } as unknown as Request;
    let passed = false;
    let status = 0;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json() {
        return res;
      },
    } as unknown as Response;
    poAuthRefreshGuard(req, res, () => {
      passed = true;
    });
    return { passed, status };
  }

  it("returns 401 when an admin key is configured but none is supplied", () => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "secret-key";
    const r = guarded({ ip: "203.0.113.7", key: "" });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
  });

  it("returns 403 when the supplied admin key does not match", () => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "secret-key";
    const r = guarded({ ip: "203.0.113.7", key: "wrong-key" });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  it("passes through when the timing-safe admin key matches", () => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "secret-key";
    const r = guarded({ ip: "203.0.113.7", key: "secret-key" });
    expect(r.passed).toBe(true);
  });

  it("returns 403 for a remote caller when NO admin key is configured (internal-only)", () => {
    const r = guarded({ ip: "203.0.113.7", key: "" });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  it("passes through for loopback when NO admin key is configured", () => {
    const r = guarded({ ip: "::ffff:127.0.0.1", key: "" });
    expect(r.passed).toBe(true);
  });
});

describe("PART 43.7 [486] — po-auth guard FAILS CLOSED when hosted", () => {
  afterEach(() => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "";
    secretsMock.value.PO_HEALTH_HOSTED = "";
  });

  function guarded(args: {
    ip?: string;
    key?: string;
    hosted?: boolean;
  }): { passed: boolean; status: number } {
    secretsMock.value.PO_HEALTH_HOSTED = args.hosted ? "true" : "";
    const req = {
      ip: args.ip ?? "127.0.0.1",
      get: (name: string) =>
        name.toLowerCase() === "x-po-admin-key" ? args.key ?? "" : undefined,
    } as unknown as Request;
    let passed = false;
    let status = 0;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json() {
        return res;
      },
    } as unknown as Response;
    poAuthRefreshGuard(req, res, () => {
      passed = true;
    });
    return { passed, status };
  }

  it("hosted + NO key → 404 for a remote caller (routes disabled)", () => {
    const r = guarded({ hosted: true, ip: "203.0.113.7", key: "" });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(404);
  });

  it("hosted + NO key → 404 even for LOOPBACK (no loopback fallback)", () => {
    const r = guarded({ hosted: true, ip: "127.0.0.1", key: "" });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(404);
  });

  it("hosted + key set → 401 with no key even from loopback (no bypass)", () => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "secret-key";
    const r = guarded({ hosted: true, ip: "127.0.0.1", key: "" });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
  });

  it("hosted + key set → passes for a remote caller presenting the key", () => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "secret-key";
    const r = guarded({ hosted: true, ip: "203.0.113.7", key: "secret-key" });
    expect(r.passed).toBe(true);
  });

  it("non-hosted + NO key → 403 remote, pass loopback (dev convenience)", () => {
    const remote = guarded({ hosted: false, ip: "203.0.113.7", key: "" });
    expect(remote.passed).toBe(false);
    expect(remote.status).toBe(403);
    const local = guarded({ hosted: false, ip: "::1", key: "" });
    expect(local.passed).toBe(true);
  });

  // Real HTTP through the SAME trust-proxy boundary index.ts installs, so the
  // X-Forwarded-For → req.ip derivation is exercised end-to-end, not mocked.
  it("real HTTP (trust proxy=1): XFF remote cannot reach hosted routes without a key, loopback 404s, and the key unlocks both", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.post("/health/po-auth/refresh", poAuthRefreshGuard, (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const post = (
      headers: Record<string, string>,
    ): Promise<{ status: number; body: JsonBody }> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/health/po-auth/refresh",
            method: "POST",
            headers,
          },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: JSON.parse(raw || "{}") as JsonBody,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });

    try {
      secretsMock.value.PO_HEALTH_HOSTED = "true";
      secretsMock.value.PO_HEALTH_ADMIN_KEY = "";
      // A caller arriving via the trusted proxy with a real public IP.
      const remote = await post({ "x-forwarded-for": "203.0.113.7" });
      expect(remote.status).toBe(404);
      // A caller the proxy forwarded with no XFF is seen as loopback — still 404.
      const direct = await post({});
      expect(direct.status).toBe(404);

      // Configure a key: the XFF-derived remote caller must present it.
      secretsMock.value.PO_HEALTH_ADMIN_KEY = "secret-key";
      const remoteNoKey = await post({ "x-forwarded-for": "203.0.113.7" });
      expect(remoteNoKey.status).toBe(401);
      const remoteBadKey = await post({
        "x-forwarded-for": "203.0.113.7",
        "x-po-admin-key": "nope",
      });
      expect(remoteBadKey.status).toBe(403);
      const remoteGoodKey = await post({
        "x-forwarded-for": "203.0.113.7",
        "x-po-admin-key": "secret-key",
      });
      expect(remoteGoodKey.status).toBe(200);
      // Loopback also needs the key now (no bypass).
      const loopbackNoKey = await post({});
      expect(loopbackNoKey.status).toBe(401);
    } finally {
      server.close();
    }
  });
});