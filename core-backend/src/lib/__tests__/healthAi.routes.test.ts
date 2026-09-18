import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

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
    getSourceHealth: () => [],
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

import healthRouter from "../../routes/health.routes";

type JsonBody = Record<string, unknown>;
const capture = (): {
  res: Response;
  calls: { code: number; body: JsonBody }[];
  done: Promise<void>;
} => {
  const calls: { code: number; body: JsonBody }[] = [];
  let statusCode = 200; // Express default — json() without .status() answers 200
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
      resolveDone(); // terminal call — the handler ends at the response
      return res;
    },
  } as unknown as Response;
  return { res, calls, done };
};

/** Dispatch GET /ai through the real mounted Express router (no supertest). */
async function dispatchAi(
  reply: { data: unknown } | { reject: () => Promise<never> },
): Promise<{ calls: { code: number; body: JsonBody }[] }> {
  if ("reject" in reply) {
    axiosMock.get.mockRejectedValue(new Error("ECONNREFUSED to ai-engine"));
  } else {
    axiosMock.get.mockResolvedValue(reply.data !== undefined ? reply : { data: {} });
  }
  const target = capture();
  const req = {} as Request;
  // health.routes mounts "/ai" FIRST (before /data, /, /ready, /live).
  const aiLayer = healthRouter.stack.find(
    (layer) =>
      layer.route &&
      layer.route.path === "/ai" &&
      layer.route.methods?.get === true,
  );
  expect(aiLayer).toBeDefined();
  const handle = aiLayer!.route!.stack[0].handle;
  (handle as (req: Request, res: Response, next: () => void) => void)(
    req,
    target.res,
    () => {},
  );
  await target.done;
  return { calls: target.calls };
}

describe("GET /api/v1/health/ai (FINAL MISSION part 2)", () => {
  beforeEach(() => {
    axiosMock.get.mockReset();
  });

  it("test_health_ai_up — engine replies {status:'up'} → endpoint 200 with status up + latency", async () => {
    const { calls } = await dispatchAi({ data: { status: "up" } });
    expect(calls.length).toBe(1);
    const { code, body } = calls[0];
    expect(code).toBe(200);
    expect(body.status).toBe("up");
    expect(typeof body.latency_ms).toBe("number");
    expect(body.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof body.timestamp).toBe("string");
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
    const [url] = axiosMock.get.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/v1\/health$/);
  });

  it("test_health_ai_down_is_json_not_bare_503 — refused engine → 200 JSON {status:'down', last_error}", async () => {
    const { calls } = await dispatchAi({
      reject: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    // The endpoint answers 200 with a structured DOWN body — never a bare 503.
    expect(calls.length).toBe(1);
    const { code, body } = calls[0];
    expect(code).toBe(200);
    expect(body.status).toBe("down");
    expect(typeof body.last_error).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  it("test_health_ai_surfaces_previous_error — last_error persists after a failed probe then clears on recovery", async () => {
    await dispatchAi({ reject: () => Promise.reject(new Error("ECONNREFUSED")) });
    const { calls } = await dispatchAi({ data: { status: "up" } });
    // The recovery probe clears last_error (null back on the healthy path).
    const { code, body } = calls[0];
    expect(code).toBe(200);
    expect(body.status).toBe("up");
    expect(body.last_error).toBeNull();
  });
});