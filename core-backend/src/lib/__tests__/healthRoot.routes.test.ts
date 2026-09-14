import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import express from "express";
import http from "node:http";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {},
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../config/secrets", () => ({
  secrets: {
    AI_ENGINE_URL: "http://127.0.0.1:8000",
    AI_ENGINE_API_KEY: "test",
  },
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
}));
vi.mock("axios", () => ({
  default: { get: axiosMock.get },
}));

import { rootHealthBody, rootHealthRouter } from "../../routes/health.routes";

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
});