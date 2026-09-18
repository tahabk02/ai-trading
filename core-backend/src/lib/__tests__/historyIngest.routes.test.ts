/**
 * historyIngest.routes.test.ts — POST /history/ingest (Alpha.5 Pro, Part 6.3).
 * Validates the ai-engine 60s AssetHistory upsert contract: 400 on missing
 * symbol/bars, 200 + { ingested } once the store accepted the real bars.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  getRecentWindow: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    assetHistory = { upsert: mocks.upsert };
    tickHistory = { findMany: vi.fn(), createMany: vi.fn(), count: vi.fn() };
  },
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: { getRecentWindow: mocks.getRecentWindow },
}));

import historyRouter from "../../routes/history.routes";

type JsonBody = Record<string, unknown>;

function capture() {
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
}

function postLayer() {
  return historyRouter.stack.find(
    (layer) => layer.route && layer.route.path === "/history/ingest" && layer.route.methods?.post === true,
  );
}

async function dispatch(body: unknown): Promise<{ calls: { code: number; body: JsonBody }[] }> {
  const target = capture();
  const layer = postLayer();
  expect(layer).toBeDefined();
  const handle = layer!.route!.stack[0].handle;
  await (handle as (req: Request, res: Response, next: () => void) => void)(
    { body } as Request,
    target.res,
    () => {},
  );
  await target.done;
  return { calls: target.calls };
}

describe("POST /api/v1/history/ingest (Alpha.5 Pro, Part 6.3)", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({ id: "x" });
  });

  it("answers 400 when symbol is missing", async () => {
    const { calls } = await dispatch({ bars: [{ bucketStartMs: 1, open: 1, high: 1, low: 1, close: 1 }] });
    expect(calls[0].code).toBe(400);
    expect(calls[0].body.error).toBe("symbol is required");
  });

  it("answers 400 when bars is empty", async () => {
    const { calls } = await dispatch({ symbol: "EUR/USD", bars: [] });
    expect(calls[0].code).toBe(400);
    expect(calls[0].body.error).toBe("bars is required");
  });

  it("answers 400 when a bar carries a non-finite bucket or OHLC", async () => {
    const badBucket = await dispatch({ symbol: "EUR/USD", bars: [{ bucketStartMs: "x", open: 1, high: 1, low: 1, close: 1 }] });
    expect(badBucket.calls[0].code).toBe(400);
    const badOhlc = await dispatch({ symbol: "EUR/USD", bars: [{ bucketStartMs: 1, open: 1, high: Number.NaN, low: 1, close: 1 }] });
    expect(badOhlc.calls[0].code).toBe(400);
  });

  it("answers 200 { ingested } after upserting real bars", async () => {
    const bucketStartMs = Date.now();
    const { calls } = await dispatch({
      symbol: "eur/usd",
      timeframe: "1m",
      bars: [
        { bucketStartMs, open: 1.085, high: 1.085, low: 1.085, close: 1.085, tickCount: 1 },
        { bucketStartMs: bucketStartMs - 60_000, open: 1.084, high: 1.084, low: 1.084, close: 1.084, tickCount: 1 },
      ],
    });
    expect(calls[0].code).toBe(200);
    expect(calls[0].body.ingested).toBe(2);
    expect(calls[0].body.symbol).toBe("EUR/USD");
    expect(calls[0].body.window).toBe("30m");
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    const first = mocks.upsert.mock.calls[0][0];
    expect(first.where.symbol_timeframe_bucketStartMs.symbol).toBe("EUR/USD");
    expect(first.where.symbol_timeframe_bucketStartMs.bucketStartMs.toString()).toBe(String(bucketStartMs));
  });

  it("answers 500 surfaced as an honest failed ingest", async () => {
    mocks.upsert.mockRejectedValue(new Error("db down"));
    const { calls } = await dispatch({
      symbol: "GBP/USD",
      bars: [{ bucketStartMs: 1, open: 1.2, high: 1.2, low: 1.2, close: 1.2 }],
    });
    expect(calls[0].code).toBe(500);
    expect(calls[0].body.error).toBe("History ingest failed");
  });
});