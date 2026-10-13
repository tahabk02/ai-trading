/**
 * trades.controller.test.ts — PART 44 [455]/[456].
 * Pins the unified execution envelope on POST /trades and the audit entry each
 * decision writes. Services are mocked; the HTTP layer + contract are real.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  isValidSymbolSync: vi.fn(),
  findBySymbol: vi.fn(),
  getLiveSpot: vi.fn(),
  evaluateAndEnforce: vi.fn(),
}));

vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: {
    isValidSymbolSync: mocks.isValidSymbolSync,
    findBySymbol: mocks.findBySymbol,
  },
}));
vi.mock("../../services/forexData.service", () => ({
  forexDataService: { getLiveSpot: mocks.getLiveSpot },
}));
vi.mock("../../services/riskState.service", () => ({
  riskStateService: { evaluateAndEnforce: mocks.evaluateAndEnforce },
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { executeTrade } from "../../controllers/trades.controller";
import {
  clearExecutionAuditForTests,
  queryExecutionLogs,
} from "../../lib/auditLogger";

type JsonBody = Record<string, unknown>;

function capture(): {
  res: Response;
  calls: { code: number; body: JsonBody }[];
  done: Promise<void>;
} {
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

async function post(body: JsonBody): Promise<{ code: number; body: JsonBody }> {
  const target = capture();
  await executeTrade({ body } as unknown as Request, target.res);
  await target.done;
  return target.calls[0];
}

beforeEach(() => {
  clearExecutionAuditForTests();
  // PART 46.2 [514] — dry-run is now the FAIL-CLOSED default. The live-path
  // cases below exercise `status:"executed"`, so they must EXPLICITLY opt out,
  // exactly as a deployment would. The dedicated unset case lives at the end.
  process.env.EXECUTION_DRY_RUN = "false";
  mocks.isValidSymbolSync.mockReset().mockReturnValue(true);
  mocks.findBySymbol.mockReset().mockResolvedValue({ payout: 92 });
  mocks.getLiveSpot
    .mockReset()
    .mockResolvedValue({
      success: true,
      price: 1.2345,
      source: "pocket_option_ssot",
      stale: false,
    });
  mocks.evaluateAndEnforce.mockReset().mockResolvedValue({
    killSwitchLocked: false,
    drawdownPct: 0,
    maxDailyDrawdownPct: 3,
    tradesToday: 0,
    lossesToday: 0,
    equity: 10000,
    peakEquity: 10000,
    realizedPnl: 0,
    lockedReason: null,
  });
});

const VALID = {
  symbol: "EUR/USD",
  direction: "CALL",
  investment: 0,
  expiration: 60,
};

describe("POST /trades ([455] envelope + [456] audit)", () => {
  it("executed: 201 with the unified envelope + nested trade record", async () => {
    const { code, body } = await post(VALID);
    expect(code).toBe(201);
    expect(body.status).toBe("executed");
    expect(typeof body.executionId).toBe("string");
    expect(body.provenance).toBe("pocket_option_ws");
    expect(typeof body.latencyMs).toBe("number");
    expect(body.error).toBeNull();
    const trade = body.result as JsonBody;
    expect(trade.symbol).toBe("EUR/USD");
    expect(trade.direction).toBe("CALL");
    expect(trade.entry_price).toBe(1.2345);
    expect(trade.status).toBe("OPEN");

    const logs = queryExecutionLogs().logs;
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatchObject({
      source: "trade",
      symbol: "EUR/USD",
      decision: "executed",
      status: "executed",
      provenance: "pocket_option_ws",
    });
    expect(logs[0].riskRules.killSwitchLocked).toBe(false);
  });

  it("rejected validation: 400 envelope with error + code, audited", async () => {
    const { code, body } = await post({ symbol: "EUR/USD" });
    expect(code).toBe(400);
    expect(body.status).toBe("rejected");
    expect(body.error).toContain("required");
    expect(body.code).toBe("validation_error");
    expect(body.executionId).toBeTruthy();
    expect(queryExecutionLogs().logs[0].decision).toBe("rejected");
  });

  it("rejected non-whitelist symbol: 400 symbol_not_allowed", async () => {
    mocks.isValidSymbolSync.mockReturnValue(false);
    const { code, body } = await post({ ...VALID, symbol: "AAPL" });
    expect(code).toBe(400);
    expect(body.status).toBe("rejected");
    expect(body.code).toBe("symbol_not_allowed");
    expect(mocks.evaluateAndEnforce).not.toHaveBeenCalled();
  });

  it("rejected kill switch: 423 with riskState + reason, audited with rules", async () => {
    mocks.evaluateAndEnforce.mockResolvedValue({
      killSwitchLocked: true,
      drawdownPct: 3.4,
      maxDailyDrawdownPct: 3,
      tradesToday: 5,
      lossesToday: 3,
      equity: 9660,
      peakEquity: 10000,
      realizedPnl: -340,
      lockedReason: "Daily drawdown 3.40% breached the 3% limit",
    });
    const { code, body } = await post(VALID);
    expect(code).toBe(423);
    expect(body.status).toBe("rejected");
    expect(body.code).toBe("kill_switch_engaged");
    expect(body.error).toContain("drawdown");
    expect(body.riskState).toBeTruthy();
    expect(queryExecutionLogs().logs[0].riskRules.killSwitchLocked).toBe(true);
  });

  it("held price → provenance held_price and entry_price 0", async () => {
    mocks.getLiveSpot.mockResolvedValue({
      success: true,
      price: 1.2,
      source: "pocket_option_held",
      stale: true,
    });
    const { code, body } = await post(VALID);
    expect(code).toBe(201);
    expect(body.provenance).toBe("held_price");
    expect((body.result as JsonBody).entry_price).toBe(0);
  });

  it("dryRun: 200 dry_run envelope, decision skipped, no persisted trade", async () => {
    const { code, body } = await post({ ...VALID, dryRun: true });
    expect(code).toBe(200);
    expect(body.status).toBe("dry_run");
    expect(body.result).toBeTruthy();
    expect(queryExecutionLogs().logs[0].decision).toBe("skipped");
  });

  it("unexpected failure: 500 failed envelope", async () => {
    mocks.evaluateAndEnforce.mockRejectedValue(new Error("db down"));
    const { code, body } = await post(VALID);
    expect(code).toBe(500);
    expect(body.status).toBe("failed");
    expect(body.error).toBe("Internal Server Error");
    expect(queryExecutionLogs().logs[0].status).toBe("failed");
  });

  it("PART 46.2 [514] — UNSET env fails closed: 200 dry_run, nothing persisted, nothing sent", async () => {
    const before = process.env.EXECUTION_DRY_RUN;
    delete process.env.EXECUTION_DRY_RUN;
    try {
      const { code, body } = await post(VALID);
      expect(code).toBe(200);
      expect(body.status).toBe("dry_run");
      expect(body.result).toBeTruthy();
      expect(queryExecutionLogs().logs[0].decision).toBe("skipped");
      expect(queryExecutionLogs().logs[0].riskRules.dryRun).toBe(true);
    } finally {
      if (before === undefined) delete process.env.EXECUTION_DRY_RUN;
      else process.env.EXECUTION_DRY_RUN = before;
    }
  });

  it("PART 46.2 [514] — explicit false is the only way to the live path", async () => {
    process.env.EXECUTION_DRY_RUN = "false";
    const { code, body } = await post(VALID);
    expect(code).toBe(201);
    expect(body.status).toBe("executed");
    expect(queryExecutionLogs().logs[0].decision).toBe("executed");
  });
});
