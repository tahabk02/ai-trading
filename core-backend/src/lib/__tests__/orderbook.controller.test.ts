import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

const handlers = vi.hoisted(() => ({
  getLiveSpot: vi.fn(),
  getHistoricalCandles: vi.fn(),
  computeAtr: vi.fn(),
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../services/forexData.service", () => ({
  forexDataService: {
    getLiveSpot: handlers.getLiveSpot,
    getHistoricalCandles: handlers.getHistoricalCandles,
    computeAtr: handlers.computeAtr,
  },
}));

import {
  getOrderBook,
  orderbookHealth,
} from "../../controllers/orderbook.controller";

type JsonBody = Record<string, unknown>;
const capture = (): {
  res: Response;
  calls: { code: number; body: JsonBody }[];
  done: Promise<void>;
} => {
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
};

const reqWith = (query: Record<string, unknown> = {}): Request =>
  ({ query }) as unknown as Request;

describe("GET /api/v1/orderbook (MASTER MISSION part 1)", () => {
  beforeEach(() => {
    handlers.getLiveSpot.mockReset();
    handlers.getHistoricalCandles.mockReset();
    handlers.computeAtr.mockReset();
    handlers.computeAtr.mockReturnValue({ atr: 0, volatilityPct: 0 });
    orderbookHealth.last_error = null;
    orderbookHealth.last_latency_ms = 0;
    orderbookHealth.last_ok_ts = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("test_orderbook_returns_400_json_on_missing_symbol", async () => {
    const target = capture();
    await getOrderBook(reqWith({}), target.res);
    await target.done;
    expect(target.calls.length).toBe(1);
    const { code, body } = target.calls[0];
    expect(code).toBe(400);
    expect(body.error).toBe("Validation Error");
    expect(typeof body.message).toBe("string");
  });

  it("test_orderbook_returns_400_json_on_non_whitelisted_symbol", async () => {
    const target = capture();
    await getOrderBook(reqWith({ symbol: "AAPL" }), target.res);
    await target.done;
    expect(target.calls.length).toBe(1);
    const { code, body } = target.calls[0];
    expect(code).toBe(400);
    expect(body.error).toBe("Symbol not permitted");
  });

  it("test_orderbook_returns_504_json_on_upstream_timeout", async () => {
    vi.useFakeTimers();
    // Upstream never settles → the controller's 3s hard cap must answer 504.
    handlers.getLiveSpot.mockReturnValue(new Promise(() => {}));
    handlers.getHistoricalCandles.mockReturnValue(new Promise(() => {}));
    const target = capture();
    getOrderBook(reqWith({ symbol: "EUR/USD" }), target.res);
    await vi.advanceTimersByTimeAsync(3_000);
    await target.done;
    expect(target.calls.length).toBe(1);
    const { code, body } = target.calls[0];
    expect(code).toBe(504);
    expect(body.error).toBe("orderbook_timeout");
    expect(body.retryAfterMs).toBe(1_000);
    // Structured body — never the bare proxy-style status page.
    expect(typeof body.message).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  it("test_orderbook_returns_502_json_with_body_on_upstream_error", async () => {
    handlers.getLiveSpot.mockRejectedValue(
      new Error("ECONNREFUSED upstream rate source"),
    );
    handlers.getHistoricalCandles.mockResolvedValue({
      success: true,
      source: "mock",
      bars: [],
    });
    const target = capture();
    await getOrderBook(reqWith({ symbol: "EUR/USD" }), target.res);
    await target.done;
    expect(target.calls.length).toBe(1);
    const { code, body } = target.calls[0];
    expect(code).toBe(502);
    expect(body.error).toBe("orderbook_upstream");
    expect(typeof body.detail).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  it("test_orderbook_returns_200_real_quote_on_success", async () => {
    handlers.getLiveSpot.mockResolvedValue({
      success: true,
      price: 1.12345,
      source: "mock",
    });
    handlers.getHistoricalCandles.mockResolvedValue({
      success: true,
      source: "mock",
      bars: [],
    });
    const target = capture();
    await getOrderBook(reqWith({ symbol: "EUR/USD" }), target.res);
    await target.done;
    expect(target.calls.length).toBe(1);
    const { code, body } = target.calls[0];
    expect(code).toBe(200);
    expect(body.symbol).toBe("EUR/USD");
    expect(body.hasDepth).toBe(false);
    expect(body.bids).toEqual([]);
    expect(body.asks).toEqual([]);
    expect(typeof body.midPrice).toBe("number");
    expect(orderbookHealth.last_error).toBeNull();
  });

  it("test_health_orderbook_surfaces_last_outcome", async () => {
    handlers.getLiveSpot.mockRejectedValue(new Error("boom"));
    handlers.getHistoricalCandles.mockResolvedValue({
      success: true,
      source: "mock",
      bars: [],
    });
    const target = capture();
    await getOrderBook(reqWith({ symbol: "EUR/USD" }), target.res);
    await target.done;
    expect(orderbookHealth.last_error).toContain("boom");
    expect(orderbookHealth.last_latency_ms).toBeGreaterThanOrEqual(0);
  });
});