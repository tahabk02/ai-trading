/**
 * dbFallback.routes.test.ts — PHASE 5 read-surface resilience.
 *
 * A cold Postgres must NOT take the terminal down: the signals feed, the
 * risk-state poller and the journal list all degrade to a NEUTRAL 200 payload
 * rather than a 500. This pins the exact fallback SHAPES the client types
 * depend on (bare array / default snapshot / empty journal) while proving a
 * genuine (non-infra) error still surfaces as a 500.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  signalFindMany: vi.fn(),
  listEntries: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    signal = { findMany: mocks.signalFindMany };
  },
}));

vi.mock("../../services/journal.service", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/journal.service")
  >("../../services/journal.service");
  return {
    ...actual,
    journalService: { ...actual.journalService, listEntries: mocks.listEntries },
  };
});

vi.mock("../../services/riskState.service", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/riskState.service")
  >("../../services/riskState.service");
  return {
    ...actual,
    riskStateService: { ...actual.riskStateService, getState: mocks.getState },
  };
});

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getSignals } from "../../controllers/signal.controller";
import { listJournalEntries } from "../../controllers/journal.controller";
import { getRiskState } from "../../controllers/riskState.controller";

type JsonBody = Record<string, unknown> | unknown[];

function capture() {
  const calls: { code: number; body: JsonBody }[] = [];
  let statusCode = 200;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader() {
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

async function run(
  handler: (req: Request, res: Response) => unknown,
  req: Partial<Request> = {},
): Promise<{ code: number; body: JsonBody }> {
  const target = capture();
  await handler({ query: {}, ...(req as Request) }, target.res);
  await target.done;
  return target.calls[0];
}

const dbDown = () =>
  Object.assign(new Error("Can't reach database server at 127.0.0.1:5433"), {
    code: "P1001",
  });

beforeEach(() => {
  mocks.signalFindMany.mockReset();
  mocks.listEntries.mockReset();
  mocks.getState.mockReset();
});

describe("getSignals — cold DB serves an empty feed, not a 503", () => {
  it("returns 200 with a bare [] array", async () => {
    mocks.signalFindMany.mockRejectedValue(dbDown());
    const res = await run(getSignals);
    expect(res.code).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([]);
  });

  it("still surfaces a genuine query bug as 500", async () => {
    mocks.signalFindMany.mockRejectedValue(new Error("Unique constraint failed"));
    const res = await run(getSignals);
    expect(res.code).toBe(500);
  });

  it("passes a healthy read through untouched", async () => {
    mocks.signalFindMany.mockResolvedValue([{ id: "s1", symbol: "EUR/USD" }]);
    const res = await run(getSignals);
    expect(res.code).toBe(200);
    expect(res.body).toEqual([{ id: "s1", symbol: "EUR/USD" }]);
  });
});

describe("getRiskState — cold DB serves a neutral unlocked snapshot", () => {
  it("returns 200 with an honest zeroed snapshot", async () => {
    mocks.getState.mockRejectedValue(dbDown());
    const res = await run(getRiskState);
    expect(res.code).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.startingEquity).toBe(0);
    expect(body.drawdownPct).toBe(0);
    expect(body.killSwitchLocked).toBe(false);
    expect(body.maxDailyDrawdownPct).toBe(3);
    expect(String(body.dayKey)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("still surfaces a genuine error as 500", async () => {
    mocks.getState.mockRejectedValue(new Error("bad arithmetic"));
    const res = await run(getRiskState);
    expect(res.code).toBe(500);
  });
});

describe("listJournalEntries — cold DB serves an empty journal", () => {
  it("returns 200 with the native { entries, count } shape", async () => {
    mocks.listEntries.mockRejectedValue(dbDown());
    const res = await run(listJournalEntries);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ entries: [], count: 0 });
  });

  it("still surfaces a genuine error as 500", async () => {
    mocks.listEntries.mockRejectedValue(new Error("serialization exploded"));
    const res = await run(listJournalEntries);
    expect(res.code).toBe(500);
  });
});
