/**
 * receiver.controller.test.ts — PART 44 [455]/[456].
 * The signal-evaluation endpoint (AI-engine HTTP fallback) must answer with the
 * unified envelope and audit each decision.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  isValidSymbolSync: vi.fn(),
  broadcastSignal: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    signal = { create: mocks.create };
  },
}));
vi.mock("../../services/websocket.service", () => ({
  WebSocketService: { getInstance: () => ({ broadcastSignal: mocks.broadcastSignal }) },
}));
vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: { isValidSymbolSync: mocks.isValidSymbolSync },
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { receiveSignal } from "../../controllers/receiver.controller";
import {
  clearExecutionAuditForTests,
  queryExecutionLogs,
} from "../../lib/auditLogger";

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

async function receive(body: JsonBody): Promise<{ code: number; body: JsonBody }> {
  const target = capture();
  await receiveSignal({ body } as unknown as Request, target.res);
  await target.done;
  return target.calls[0];
}

beforeEach(() => {
  clearExecutionAuditForTests();
  mocks.create.mockReset().mockResolvedValue({ id: "sig_1", symbol: "EUR/USD" });
  mocks.isValidSymbolSync.mockReset().mockReturnValue(true);
  mocks.broadcastSignal.mockReset();
});

describe("POST /signals/receive ([455] envelope + [456] audit)", () => {
  it("executed: 200 envelope with nested persisted signal", async () => {
    const { code, body } = await receive({
      symbol: "EUR/USD",
      signal_type: "BUY",
      price: 1.23,
      confidence: 96.5,
      timeframe: "5m",
    });
    expect(code).toBe(200);
    expect(body.status).toBe("executed");
    expect(typeof body.executionId).toBe("string");
    expect(body.error).toBeNull();
    expect((body.result as JsonBody).id).toBe("sig_1");

    const log = queryExecutionLogs().logs[0];
    expect(log).toMatchObject({
      source: "signal",
      symbol: "EUR/USD",
      direction: "BUY",
      decision: "executed",
    });
    expect(log.confidence).toBe(96.5);
    expect(log.timeframe).toBe("5m");
  });

  it("rejected non-whitelist symbol: 400, no persist, audited", async () => {
    mocks.isValidSymbolSync.mockReturnValue(false);
    const { code, body } = await receive({ symbol: "AAPL", signal_type: "BUY" });
    expect(code).toBe(400);
    expect(body.status).toBe("rejected");
    expect(body.code).toBe("symbol_not_allowed");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(queryExecutionLogs().logs[0].decision).toBe("rejected");
  });

  it("rejected missing symbol: 400 validation_error", async () => {
    const { code, body } = await receive({ signal_type: "BUY" });
    expect(code).toBe(400);
    expect(body.code).toBe("validation_error");
  });
});
