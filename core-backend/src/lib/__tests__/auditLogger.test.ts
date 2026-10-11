import { describe, expect, it, beforeEach } from "vitest";
import {
  recordExecutionAudit,
  queryExecutionLogs,
  clearExecutionAuditForTests,
} from "../auditLogger";

describe("PART 44 [456] auditLogger — signal/trade execution log", () => {
  beforeEach(() => {
    clearExecutionAuditForTests();
  });

  it("records entries newest-first and normalises the symbol", () => {
    recordExecutionAudit({
      source: "signal",
      symbol: "eur/usd",
      decision: "executed",
      status: "executed",
      confidence: 97.2,
      riskRules: { whitelistPassed: true },
    });
    recordExecutionAudit({
      source: "trade",
      symbol: "gbp/usd",
      direction: "CALL",
      decision: "rejected",
      status: "rejected",
      error: "kill switch",
      riskRules: { killSwitchLocked: true, drawdownPct: 3.5 },
    });

    const { logs, count, total } = queryExecutionLogs();
    expect(total).toBe(2);
    expect(count).toBe(2);
    expect(logs[0].symbol).toBe("GBP/USD"); // newest first
    expect(logs[1].symbol).toBe("EUR/USD");
    expect(logs[0].error).toBe("kill switch");
    expect(logs[0].riskRules.killSwitchLocked).toBe(true);
    expect(logs[1].confidence).toBe(97.2);
  });

  it("filters by symbol, decision and since; honours limit", () => {
    recordExecutionAudit({
      source: "trade",
      symbol: "EUR/USD",
      decision: "executed",
      status: "executed",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    recordExecutionAudit({
      source: "trade",
      symbol: "EUR/USD",
      decision: "rejected",
      status: "rejected",
      timestamp: "2026-06-01T00:00:00.000Z",
    });
    recordExecutionAudit({
      source: "trade",
      symbol: "USD/JPY",
      decision: "executed",
      status: "executed",
      timestamp: "2026-06-02T00:00:00.000Z",
    });

    expect(queryExecutionLogs({ symbol: "eur/usd" }).count).toBe(2);
    expect(queryExecutionLogs({ decision: "executed" }).count).toBe(2);
    expect(
      queryExecutionLogs({ since: "2026-05-01T00:00:00.000Z" }).count,
    ).toBe(2);
    expect(
      queryExecutionLogs({
        symbol: "EUR/USD",
        decision: "rejected",
        since: "2026-01-01T00:00:00.000Z",
      }).count,
    ).toBe(1);
    expect(
      queryExecutionLogs({ since: "2026-01-01T00:00:00.000Z", limit: 1 }).logs
        .length,
    ).toBe(1);
  });

  it("never throws and defaults missing optional fields", () => {
    const entry = recordExecutionAudit({
      source: "signal",
      symbol: "",
      decision: "skipped",
      status: "dry_run",
    });
    expect(entry.symbol).toBe("");
    expect(entry.timeframe).toBeNull();
    expect(entry.direction).toBeNull();
    expect(entry.confidence).toBeNull();
    expect(entry.latencyMs).toBeNull();
    expect(entry.error).toBeNull();
    expect(entry.provenance).toBe("none");
    expect(entry.riskRules).toEqual({});
  });

  it("clearExecutionAuditForTests empties the store", () => {
    recordExecutionAudit({
      source: "signal",
      symbol: "EUR/USD",
      decision: "executed",
      status: "executed",
    });
    expect(queryExecutionLogs().total).toBe(1);
    clearExecutionAuditForTests();
    expect(queryExecutionLogs().total).toBe(0);
  });
});
