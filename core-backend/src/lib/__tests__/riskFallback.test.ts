import { describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {},
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildDegradedRiskState } from "../../controllers/riskState.controller";

describe("degraded risk-state snapshot", () => {
  it("is a complete, fail-closed payload when storage is unavailable", () => {
    const snapshot = buildDegradedRiskState(4.5);
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.riskStateAvailable).toBe(false);
    expect(snapshot.killSwitchLocked).toBe(true);
    expect(snapshot.lockedReason).toMatch(/RISK STATE UNAVAILABLE/i);
    expect(snapshot.maxDailyDrawdownPct).toBe(4.5);
    expect(snapshot.startingEquity).toBeNull();
    expect(snapshot.equity).toBeNull();
    expect(snapshot.peakEquity).toBeNull();
    expect(snapshot.drawdownPct).toBeNull();
    expect(snapshot.realizedPnl).toBe(0);
    expect(snapshot.lockedAt).not.toBeNull();
  });
});
