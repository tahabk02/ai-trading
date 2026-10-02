/**
 * PART 32.5a [261] — /orderbook upstream deadline must cover the WHOLE forex
 * cascade, not just its first hop.
 *
 * THE BUG THIS PINS: UPSTREAM_TIMEOUT_MS used to be a flat 5_000, which is
 * exactly REQUEST_TIMEOUT_MS — the primary tier's own budget. So when the
 * primary tier was slow it consumed the whole outer deadline by itself, the
 * 504 fired in the same instant the primary gave up, and the three fallback
 * tiers that exist to cover exactly that situation never got to run.
 *
 * These tests drive the real controller with a stubbed forexDataService, so
 * they exercise the actual withTimeout wiring rather than a restatement of the
 * arithmetic.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const orderbookHealth = { recordStart: vi.fn(), recordOk: vi.fn(), recordError: vi.fn() };

// The controller reads these off the module object at call time, so a stub is
// enough — no module mocking machinery needed.
vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: { isValidSymbolSync: (s: string) => s === "EUR/USD" },
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../services/orderbookHealth", () => ({ orderbookHealth }), { virtual: true });

import { getOrderBook } from "../../controllers/orderbook.controller";
import {
  FOREX_CHAIN_BUDGET_MS,
  FOREX_FALLBACK_TIER_COUNT,
  FOREX_PRIMARY_TIMEOUT_MS,
} from "../../controllers/orderbook.controller";
import { forexDataService } from "../../services/forexData.service";

/** Minimal express-like req/res pair that records the JSON verdict.
 *  Mirrors Express semantics: a bare res.json() with no prior .status() is a
 *  200 — the controller's success path returns res.json({...}) directly. */
function mockRes() {
  const state: { status?: number; body?: any } = {};
  const res: any = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: any) {
      state.body = payload;
      state.status ??= 200;
      return res;
    },
  };
  return { res, state };
}

const okSpot = { success: true, price: 1.1355, source: "pocket_option_ssot" };
const okBars = { success: true, bars: [] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(forexDataService, "getLiveSpot");
  vi.spyOn(forexDataService, "getHistoricalCandles");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PART 32.5a [261] — orderbook deadline covers the whole cascade", () => {
  it("sizes the outer cap above primary + every fallback tier", () => {
    // 5s primary + 3 x 2s fallback = 11s of possible work.
    expect(FOREX_FALLBACK_TIER_COUNT).toBe(3);
    expect(FOREX_CHAIN_BUDGET_MS).toBe(FOREX_PRIMARY_TIMEOUT_MS + 3 * 2_000);
    expect(FOREX_PRIMARY_TIMEOUT_MS).toBe(5_000);
    expect(FOREX_CHAIN_BUDGET_MS).toBe(11_000);
  });

  it("gives fallback tiers their full budget when the PRIMARY tier stalls", async () => {
    // The primary burns its entire 5s, then the chain recovers on a later tier.
    // A 5s outer cap would 504 here; the fixed cap must let the answer through.
    (forexDataService.getLiveSpot as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(okSpot), FOREX_PRIMARY_TIMEOUT_MS + 250);
        }),
    );
    (forexDataService.getHistoricalCandles as any).mockResolvedValue(okBars);

    const { res, state } = mockRes();
    const p = getOrderBook({ query: { symbol: "EUR/USD" } } as any, res);

    // Run the primary past its 5s budget but well inside the new 12s cap.
    await vi.advanceTimersByTimeAsync(FOREX_PRIMARY_TIMEOUT_MS + 500);
    await p;

    expect(state.status).toBe(200);
    expect(state.body.midPrice).toBe(1.1355);
  });

  it("still returns a bounded 504 when the ENTIRE cascade is exhausted", async () => {
    // Nothing ever resolves: the cap must fire — later than the old 5s, but
    // still bounded, and it must be a JSON 504 not a bare proxy failure.
    (forexDataService.getLiveSpot as any).mockImplementation(() => new Promise(() => {}));
    (forexDataService.getHistoricalCandles as any).mockImplementation(
      () => new Promise(() => {}),
    );

    const { res, state } = mockRes();
    const p = getOrderBook({ query: { symbol: "EUR/USD" } } as any, res);

    // At the OLD 5s deadline this would already have rejected.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.status).toBeUndefined(); // not cut off at 5s any more

    await vi.advanceTimersByTimeAsync(FOREX_CHAIN_BUDGET_MS);
    await p;

    expect(state.status).toBe(504);
    expect(state.body.error).toBe("orderbook_timeout");
    // The message must not still claim the old 5s deadline.
    expect(String(state.body.message)).not.toMatch(/\b5s\b/);
  });

  it("reports a 502 (not a timeout) when the chain finishes but has no rate", async () => {
    // Fast, well-formed "no live rate" verdict from an exhausted-but-returned
    // cascade must NOT be mislabelled as a 504.
    (forexDataService.getLiveSpot as any).mockResolvedValue({
      success: false,
      price: null,
      error: "all spot sources exhausted",
    });
    (forexDataService.getHistoricalCandles as any).mockResolvedValue(okBars);

    const { res, state } = mockRes();
    await getOrderBook({ query: { symbol: "EUR/USD" } } as any, res);

    expect(state.status).toBe(502);
    expect(state.body.error).toBe("orderbook_upstream");
  });
});