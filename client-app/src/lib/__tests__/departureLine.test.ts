/**
 * departureLine.test.ts — EXACT DEPARTURE ("Ligne du Départ") resolver.
 *
 * Pins the non-fabricating contract: the resolver NEVER invents a level, it
 * withholds the line when the engine had no valid basis, and its live status
 * precedence mirrors the engine
 * (WAITING → EXPIRED_ZONE → MISSED_ENTRY → PENDING → ACTIVE).
 */
import { describe, it, expect } from "vitest";

import type { DepartureContract } from "@/services/api";
import {
  DEPARTURE_COPY,
  resolveDepartureLine,
} from "@/lib/departureLine";

function contract(
  overrides: Partial<DepartureContract> = {},
): DepartureContract {
  return {
    available: true,
    status: "ACTIVE",
    reason: null,
    side: "CALL",
    strike_price: 1.1,
    target_price: 1.1005,
    entry_window_start_ms: 1_000_000,
    entry_window_end_ms: 1_060_000,
    max_allowed_slippage: 0.005,
    slippage: 0,
    ...overrides,
  };
}

describe("resolveDepartureLine — honest waiting state", () => {
  it("withholds the line when there is no contract", () => {
    const view = resolveDepartureLine(null, { nowMs: 1_000_000 });
    expect(view.available).toBe(false);
    expect(view.renderLine).toBe(false);
    expect(view.status).toBe("WAITING_FOR_VALID_ENTRY_LEVEL");
    expect(view.label).toBe("WAITING FOR VALID ENTRY LEVEL");
    expect(view.strikePrice).toBeNull();
    expect(view.targetPrice).toBeNull();
    expect(view.side).toBeNull();
  });

  it("withholds when the engine marked it unavailable", () => {
    const view = resolveDepartureLine(
      contract({ available: false, strike_price: null, target_price: null }),
      { nowMs: 1_000_000 },
    );
    expect(view.available).toBe(false);
    expect(view.renderLine).toBe(false);
    expect(view.status).toBe("WAITING_FOR_VALID_ENTRY_LEVEL");
  });

  it("withholds when a level is missing even though available=true", () => {
    const view = resolveDepartureLine(
      contract({ strike_price: null }),
      { nowMs: 1_000_000 },
    );
    expect(view.available).toBe(false);
    expect(view.renderLine).toBe(false);
  });

  it("never emits a synthetic level (all null) while waiting", () => {
    const view = resolveDepartureLine(undefined, { nowMs: 5 });
    expect(view).toMatchObject({
      strikePrice: null,
      targetPrice: null,
      maxAllowedSlippage: null,
      slippage: null,
      entryWindowStartMs: null,
      entryWindowEndMs: null,
    });
  });
});

describe("resolveDepartureLine — real levels", () => {
  it("maps strike/target from the contract and renders the line", () => {
    const view = resolveDepartureLine(contract(), { nowMs: 1_010_000 });
    expect(view.available).toBe(true);
    expect(view.renderLine).toBe(true);
    expect(view.strikePrice).toBe(1.1);
    expect(view.targetPrice).toBe(1.1005);
    expect(view.side).toBe("CALL");
    expect(view.entryWindowStartMs).toBe(1_000_000);
    expect(view.entryWindowEndMs).toBe(1_060_000);
    expect(view.maxAllowedSlippage).toBe(0.005);
  });

  it("normalises an unknown side to null", () => {
    const view = resolveDepartureLine(
      contract({ side: null }),
      { nowMs: 1_010_000 },
    );
    expect(view.side).toBeNull();
  });
});

describe("resolveDepartureLine — live status precedence", () => {
  it("ACTIVE inside the window within tolerance", () => {
    const view = resolveDepartureLine(contract(), {
      livePrice: 1.1001,
      nowMs: 1_010_000,
    });
    expect(view.status).toBe("ACTIVE");
    expect(view.style).toBe("solid");
    expect(view.slippage).toBe(0.0001);
  });

  it("PENDING before the window opens (dashed)", () => {
    const view = resolveDepartureLine(contract(), {
      livePrice: 1.1,
      nowMs: 999_000,
    });
    expect(view.status).toBe("PENDING");
    expect(view.style).toBe("dashed");
    expect(view.entryCountdownSec).toBeCloseTo(1, 5);
  });

  it("EXPIRED_ZONE after the window closes", () => {
    const view = resolveDepartureLine(contract(), {
      livePrice: 1.1,
      nowMs: 1_060_001,
    });
    expect(view.status).toBe("EXPIRED_ZONE");
    expect(view.zoneValidRemainingSec).toBe(0);
  });

  it("MISSED_ENTRY when live price drifts past the tolerance", () => {
    const view = resolveDepartureLine(contract(), {
      livePrice: 1.2,
      nowMs: 1_010_000,
    });
    expect(view.status).toBe("MISSED_ENTRY");
    expect(view.slippage).toBeCloseTo(0.1, 5);
  });

  it("EXPIRED_ZONE outranks MISSED_ENTRY", () => {
    const view = resolveDepartureLine(contract(), {
      livePrice: 1.2,
      nowMs: 1_060_001,
    });
    expect(view.status).toBe("EXPIRED_ZONE");
  });

  it("MISSED_ENTRY outranks PENDING", () => {
    const view = resolveDepartureLine(contract(), {
      livePrice: 1.2,
      nowMs: 999_000,
    });
    expect(view.status).toBe("MISSED_ENTRY");
  });

  it("stays ACTIVE without a live price (nothing to breach)", () => {
    const view = resolveDepartureLine(contract(), { nowMs: 1_010_000 });
    expect(view.status).toBe("ACTIVE");
    expect(view.slippage).toBeNull();
  });

  it("stays ACTIVE without an ATR-derived tolerance", () => {
    const view = resolveDepartureLine(
      contract({ max_allowed_slippage: null }),
      { livePrice: 1.2, nowMs: 1_010_000 },
    );
    expect(view.status).toBe("ACTIVE");
  });

  it("is deterministic for the same inputs", () => {
    const a = resolveDepartureLine(contract(), { livePrice: 1.1001, nowMs: 5 });
    const b = resolveDepartureLine(contract(), { livePrice: 1.1001, nowMs: 5 });
    expect(a).toEqual(b);
  });
});

describe("DEPARTURE_COPY", () => {
  it("covers the exact engine status vocabulary", () => {
    expect(Object.keys(DEPARTURE_COPY).sort()).toEqual(
      [
        "ACTIVE",
        "EXPIRED_ZONE",
        "MISSED_ENTRY",
        "PENDING",
        "WAITING_FOR_VALID_ENTRY_LEVEL",
      ].sort(),
    );
  });
});
