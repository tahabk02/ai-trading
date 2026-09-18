/**
 * signalOutcome.routes.test.ts — POST/GET /signal-outcomes (PART 5).
 * Validates the persisted-accuracy contract: 400 on missing symbol / bad
 * outcome, 201 with the created row, 200 list + stats. Service is mocked so
 * these tests pin the HTTP layer (validation + status codes) only.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  recordOutcome: vi.fn(),
  listOutcomes: vi.fn(),
  stats: vi.fn(),
  cacheUnavailable: new Error("redis down"),
}));

vi.mock("../../services/signalOutcome.service", () => ({
  signalOutcomeService: {
    recordOutcome: mocks.recordOutcome,
    listOutcomes: mocks.listOutcomes,
    stats: mocks.stats,
  },
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import signalOutcomeRouter from "../../routes/signalOutcome.routes";

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

function routeHandler(path: string, method: string) {
  const layer = signalOutcomeRouter.stack.find(
    (l) =>
      l.route &&
      l.route.path === path &&
      ((l.route.methods as Record<string, boolean>)[method] === true),
  );
  expect(layer).toBeDefined();
  return layer!.route!.stack[0].handle as (
    req: Request,
    res: Response,
    next: () => void
  ) => void;
}

async function dispatch(
  path: string,
  method: string,
  req: Partial<Request>,
): Promise<{ calls: { code: number; body: JsonBody }[] }> {
  const target = capture();
  const handle = routeHandler(path, method);
  await handle({ ...(req as Request) }, target.res, () => {});
  await target.done;
  return { calls: target.calls };
}

describe("POST /signal-outcomes (PART 5 persisted accuracy ledger)", () => {
  beforeEach(() => {
    mocks.recordOutcome.mockReset();
    mocks.listOutcomes.mockReset();
    mocks.stats.mockReset();
    mocks.recordOutcome.mockResolvedValue({ id: "so_123", symbol: "EUR/USD", outcome: "WIN", tier: "T1" });
    mocks.listOutcomes.mockResolvedValue([]);
    mocks.stats.mockResolvedValue({
      total: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      byTier: {
        T1: { count: 0, wins: 0, winRate: null },
        T2: { count: 0, wins: 0, winRate: null },
        T3: { count: 0, wins: 0, winRate: null },
        T4: { count: 0, wins: 0, winRate: null },
        T5: { count: 0, wins: 0, winRate: null },
      },
      bySymbol: {},
    });
  });

  it("answers 400 when symbol is missing", async () => {
    const { calls } = await dispatch("/signal-outcomes", "post", { body: { outcome: "WIN" } });
    expect(calls[0].code).toBe(400);
    expect(calls[0].body.message).toContain("symbol");
  });

  it("answers 400 when outcome is not WIN/LOSS", async () => {
    const { calls } = await dispatch("/signal-outcomes", "post", { body: { symbol: "EUR/USD", outcome: "MAYBE" } });
    expect(calls[0].code).toBe(400);
    expect(calls[0].body.message).toContain("WIN");
  });

  it("answers 201 + row when a real outcome is recorded", async () => {
    const { calls } = await dispatch("/signal-outcomes", "post", {
      body: { symbol: "eur/usd", outcome: "WIN", tier: "T1", confidence: 97.2, factors: { mtf: 1 } },
    });
    expect(calls[0].code).toBe(201);
    expect(calls[0].body.symbol).toBe("EUR/USD");
    expect(calls[1]).toBeUndefined();
    expect(mocks.recordOutcome).toHaveBeenCalledTimes(1);
    const input = mocks.recordOutcome.mock.calls[0][0];
    expect(input.symbol).toBe("eur/usd");
    expect(input.tier).toBe("T1");
  });

  it("answers 200 list + stats for the dashboard", async () => {
    const listed = await dispatch("/signal-outcomes", "get", { query: { symbol: "EUR/USD", limit: "50" } });
    expect(listed.calls[0].code).toBe(200);
    expect(listed.calls[0].body).toHaveProperty("count", 0);
    expect(mocks.listOutcomes).toHaveBeenCalledWith(50, "EUR/USD");

    const stats = await dispatch("/signal-outcomes/stats", "get", { query: { windowDays: "7" } });
    expect(stats.calls[0].code).toBe(200);
    expect(stats.calls[0].body).toHaveProperty("winRate", null);
    expect(mocks.stats).toHaveBeenCalledWith(7);
  });
});