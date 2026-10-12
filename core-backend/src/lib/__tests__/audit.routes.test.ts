/**
 * audit.routes.test.ts — PART 44 [456] GET /api/v1/audit/execution-logs.
 * Pins the read-only query surface (filters + shape) over the real audit log.
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { Request, Response } from "express";
import {
  recordExecutionAudit,
  clearExecutionAuditForTests,
} from "../../lib/auditLogger";
import auditRouter from "../../routes/audit.routes";
import { requireAdminKey } from "../../middlewares/internalAuth.middleware";

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

function routeHandler(path: string) {
  const layer = auditRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods?.get === true,
  );
  expect(layer).toBeDefined();
  // PART 44.1 [503] — the admin-key guard is mounted FIRST; the controller is
  // the last handler in the route stack.
  expect((layer!.route!.stack[0].handle as unknown)).toBe(requireAdminKey);
  return layer!.route!.stack[layer!.route!.stack.length - 1].handle as (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
}

async function get(
  path: string,
  query: Record<string, string>,
): Promise<{ code: number; body: JsonBody }> {
  const target = capture();
  const handle = routeHandler(path);
  await handle({ query } as unknown as Request, target.res, () => {});
  await target.done;
  return target.calls[0];
}

describe("GET /audit/execution-logs ([456])", () => {
  beforeEach(() => {
    clearExecutionAuditForTests();
  });

  it("returns the log page with count/total/filters", async () => {
    recordExecutionAudit({
      source: "trade",
      symbol: "EUR/USD",
      decision: "executed",
      status: "executed",
    });
    const { code, body } = await get("/audit/execution-logs", {});
    expect(code).toBe(200);
    expect(Array.isArray(body.logs)).toBe(true);
    expect(body.count).toBe(1);
    expect(body.total).toBe(1);
    expect(body.filters).toBeTruthy();
    expect(typeof body.timestamp).toBe("string");
  });

  it("filters by symbol and decision and reports the applied filters", async () => {
    recordExecutionAudit({
      source: "trade",
      symbol: "EUR/USD",
      decision: "rejected",
      status: "rejected",
    });
    recordExecutionAudit({
      source: "signal",
      symbol: "USD/JPY",
      decision: "executed",
      status: "executed",
    });
    const { body } = await get("/audit/execution-logs", {
      symbol: "eur/usd",
      decision: "rejected",
      limit: "10",
    });
    expect(body.count).toBe(1);
    expect((body.filters as JsonBody).symbol).toBe("EUR/USD");
    expect((body.filters as JsonBody).decision).toBe("rejected");
    expect((body.logs as JsonBody[])[0].symbol).toBe("EUR/USD");
  });

  it("is empty (200) before any decision is recorded", async () => {
    const { code, body } = await get("/audit/execution-logs", {});
    expect(code).toBe(200);
    expect(body.count).toBe(0);
    expect(body.total).toBe(0);
  });
});
