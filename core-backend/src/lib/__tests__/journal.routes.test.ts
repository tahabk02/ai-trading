/**
 * journal.routes.test.ts — PART 50 [537]/[539] local trade journal.
 *
 * Pins the HTTP boundary: 400 on a missing symbol / bad side / non-positive
 * entry price, 201 with the created row (BigInt serialized), 200 list, and the
 * settlement PATCH. The service is mocked so only the validation + status
 * contract is under test.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  recordEntry: vi.fn(),
  listEntries: vi.fn(),
  settleEntry: vi.fn(),
}));

vi.mock("../../services/journal.service", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/journal.service")
  >("../../services/journal.service");
  return {
    ...actual,
    journalService: {
      recordEntry: mocks.recordEntry,
      listEntries: mocks.listEntries,
      settleEntry: mocks.settleEntry,
    },
  };
});
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import journalRouter from "../../routes/journal.routes";

type JsonBody = Record<string, unknown>;

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
    json(body: JsonBody) {
      calls.push({ code: statusCode, body });
      resolveDone();
      return res;
    },
  } as unknown as Response;
  return { res, calls, done };
}

function routeHandler(path: string, method: string) {
  const layer = journalRouter.stack.find(
    (l) =>
      l.route &&
      l.route.path === path &&
      (l.route.methods as Record<string, boolean>)[method] === true,
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
  await handle({ params: {}, ...(req as Request) }, target.res, () => {});
  await target.done;
  return { calls: target.calls };
}

const VALID = {
  symbol: "eur/usd",
  side: "CALL",
  entryTs: 1_000_000,
  entryPrice: 1.085,
  durationSec: 60,
  entrySource: "pocket_option_ssot:live",
};

describe("POST /journal", () => {
  beforeEach(() => {
    mocks.recordEntry.mockReset();
    mocks.listEntries.mockReset();
    mocks.settleEntry.mockReset();
    mocks.recordEntry.mockResolvedValue({
      id: "j1",
      symbol: "EUR/USD",
      side: "CALL",
      entryTs: BigInt(1_000_000),
      expiryTs: BigInt(1_060_000),
      impliesSignal: false,
    });
    mocks.listEntries.mockResolvedValue([]);
    mocks.settleEntry.mockResolvedValue({ id: "j1", status: "WIN" });
  });

  it("400 when symbol is missing", async () => {
    const { calls } = await dispatch("/journal", "post", {
      body: { ...VALID, symbol: "" },
    });
    expect(calls[0].code).toBe(400);
    expect(calls[0].body.error).toContain("symbol");
  });

  it("400 when side is not CALL/PUT", async () => {
    const { calls } = await dispatch("/journal", "post", {
      body: { ...VALID, side: "BUY" },
    });
    expect(calls[0].code).toBe(400);
    expect(calls[0].body.error).toContain("CALL");
  });

  it("400 when entryPrice is not positive", async () => {
    const { calls } = await dispatch("/journal", "post", {
      body: { ...VALID, entryPrice: 0 },
    });
    expect(calls[0].code).toBe(400);
    expect(calls[0].body.error).toContain("entryPrice");
  });

  it("400 when entrySource is missing", async () => {
    const { calls } = await dispatch("/journal", "post", {
      body: { ...VALID, entrySource: "" },
    });
    expect(calls[0].code).toBe(400);
    expect(calls[0].body.error).toContain("entrySource");
  });

  it("201 with a BigInt-safe serialized row", async () => {
    const { calls } = await dispatch("/journal", "post", { body: VALID });
    expect(calls[0].code).toBe(201);
    expect(calls[0].body.entryTs).toBe(1_000_000);
    expect(calls[0].body.expiryTs).toBe(1_060_000);
    expect(mocks.recordEntry).toHaveBeenCalledTimes(1);
    expect(mocks.recordEntry.mock.calls[0][0].symbol).toBe("EUR/USD");
  });

  it("200 list with count", async () => {
    const { calls } = await dispatch("/journal", "get", {
      query: { limit: "25", symbol: "EUR/USD" },
    });
    expect(calls[0].code).toBe(200);
    expect(calls[0].body).toHaveProperty("count", 0);
    expect(mocks.listEntries).toHaveBeenCalledWith(25, "EUR/USD");
  });

  it("clamps a bad/garbage limit instead of failing", async () => {
    await dispatch("/journal", "get", { query: { limit: "abc" } });
    expect(mocks.listEntries).toHaveBeenCalledWith(100, undefined);

    mocks.listEntries.mockClear();
    await dispatch("/journal", "get", { query: { limit: "0" } });
    expect(mocks.listEntries).toHaveBeenCalledWith(1, undefined);

    mocks.listEntries.mockClear();
    await dispatch("/journal", "get", { query: { limit: "99999" } });
    expect(mocks.listEntries).toHaveBeenCalledWith(500, undefined);
  });

  it("clamps a repeated-param limit array safely", async () => {
    await dispatch("/journal", "get", {
      query: { limit: ["1", "2", "300"] },
    });
    expect(mocks.listEntries).toHaveBeenCalledWith(300, undefined);
  });

  it("PATCH settle rejects an invalid status", async () => {
    const { calls } = await dispatch("/journal/:id/settle", "patch", {
      params: { id: "j1" } as unknown as Request["params"],
      body: { status: "MAYBE" },
    });
    expect(calls[0].code).toBe(400);
    expect(calls[0].body.error).toContain("WIN");
  });

  it("PATCH settle writes WIN/LOSS/VOID", async () => {
    const { calls } = await dispatch("/journal/:id/settle", "patch", {
      params: { id: "j1" } as unknown as Request["params"],
      body: { status: "WIN", settlementPrice: 1.09, settlementTs: 1_059_000 },
    });
    expect(calls[0].code).toBe(200);
    expect(mocks.settleEntry).toHaveBeenCalledWith("j1", {
      status: "WIN",
      settlementPrice: 1.09,
      settlementTs: 1_059_000,
      voidReason: null,
      settlementSource: null,
    });
  });
});
