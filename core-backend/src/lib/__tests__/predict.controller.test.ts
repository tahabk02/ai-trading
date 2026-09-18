/**
 * predict.controller.test.ts — /predict 503 CONTRACT (QUICK FIX mission [1]).
 *
 * Two hard rules under test:
 *   1. The AI timeout NEVER yields a bare 503 — it answers
 *      { error: "ai_timeout", ... } with a JSON body.
 *   2. A successful AI pass-through answers 200 with the full prediction
 *      payload (signal, confidence, target, candles, latency metadata).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {},
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../config/secrets", () => ({
  secrets: {
    AI_ENGINE_URL: "http://127.0.0.1:8000",
    AI_ENGINE_API_KEY: "test",
    POCKET_OPTION_SSID: "",
    POCKET_BRIDGE_HOST: "127.0.0.1",
    POCKET_BRIDGE_PORT: 8788,
    POCKET_BRIDGE_RECONNECT_MS: 5000,
    POCKET_BRIDGE_AUTO_SPAWN: "true",
    POCKET_BRIDGE_PYTHON: "",
  },
}));

vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: {
    normalizeSymbol: (s: string) =>
      typeof s === "string" ? s.trim().toUpperCase().replace(/-/g, "/") : null,
    isValidSymbolSync: () => true,
    getAll: async () => [],
    getDigits: () => 5,
  },
}));

// ── forexDataService scan (each test re-shapes the mocked methods) ──
const forex = vi.hoisted(() => ({
  getLiveSpotFresh: vi.fn(),
  getHistoricalCandles: vi.fn(),
  getBufferedCandles: vi.fn(),
  computeAtr: vi.fn(),
  computeTargetPrice: vi.fn(),
  syncPayouts: vi.fn(),
}));
vi.mock("../../services/forexData.service", () => ({
  forexDataService: {
    getLiveSpotFresh: forex.getLiveSpotFresh,
    getHistoricalCandles: forex.getHistoricalCandles,
    getBufferedCandles: forex.getBufferedCandles,
    computeAtr: forex.computeAtr,
    computeTargetPrice: forex.computeTargetPrice,
    syncPayouts: forex.syncPayouts,
  },
}));

const tickBuffer = vi.hoisted(() => ({
  getLatestEntry: vi.fn(),
  getLatestSpread: vi.fn(),
}));
vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    getLatestEntry: tickBuffer.getLatestEntry,
    getLatestSpread: tickBuffer.getLatestSpread,
  },
}));

vi.mock("../../services/websocket.service", () => ({
  websocketService: {
    broadcastHighConfidenceSignal: vi.fn(),
    broadcastLiveTick: vi.fn(),
    broadcastEngineStatus: vi.fn(),
    broadcastFeedStatus: vi.fn(),
  },
}));

// Partial axios mock — keep the REAL AxiosError/isAxiosError (needed by the
// failure classifier) while controlling `axios.post` (the AI Engine call).
const axiosPost = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      post: axiosPost.post,
    },
  };
});

import { AxiosError } from "axios";
import { predictSignal } from "../../controllers/signal.controller";

// ── Express capture shim (mirrors the established test harness) ──
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
    setHeader() {
      return res;
    },
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

const req = (body: Record<string, unknown>): Request =>
  ({ body }) as unknown as Request;

const makeBars = (n = 60): Record<string, unknown>[] => {
  const now = Date.now();
  const bars: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const price = 1.15 + i * 0.0001;
    bars.push({
      timestamp: new Date(now - (n - i) * 60_000).toISOString(),
      open: price,
      high: price + 0.0002,
      low: price - 0.0002,
      close: price,
      volume: 1,
    });
  }
  return bars;
};

const FRESH_TICK = { price: 1.1525, tsMs: Date.now() - 100 };
const AI_PAYLOAD = {
  symbol: "EUR/USD",
  signal: "BUY",
  confidence: 99,
  market_waiting: false,
  target_price: 1.16,
  current_price: 1.1525,
  timeframe: "1d",
  diagnostics: { book: {} },
  book_confluence: { book_confirm: 0.98 },
};

describe("POST /api/v1/predict — 503 body contract (QUICK FIX [1])", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axiosPost.post.mockReset();
    forex.getLiveSpotFresh.mockResolvedValue({
      success: true,
      price: 1.1525,
      source: "test_live",
      error: "",
    });
    forex.getHistoricalCandles.mockResolvedValue({
      success: true,
      symbol: "EUR/USD",
      bars: makeBars(),
      source: "test",
    });
    forex.getBufferedCandles.mockResolvedValue([]);
    forex.computeAtr.mockReturnValue({ atr: 0.004 });
    forex.computeTargetPrice.mockReturnValue(1.16);
    forex.syncPayouts.mockResolvedValue(undefined);
    tickBuffer.getLatestEntry.mockReturnValue(FRESH_TICK);
    tickBuffer.getLatestSpread.mockReturnValue({ bid: 1.1524, ask: 1.1526 });
  });

  it("test_predict_returns_503_with_body_on_timeout", async () => {
    // The AI Engine exceeds the 3s budget and axios surfaces ECONNABORTED.
    axiosPost.post.mockRejectedValue(
      new AxiosError(
        "timeout of 3000ms exceeded",
        "ECONNABORTED",
        undefined,
        undefined,
        undefined,
      ),
    );

    const { res, calls, done } = capture();
    await predictSignal(req({ symbol: "EUR/USD", timeframe: "1d" }), res);
    await done;

    expect(calls.length).toBe(1);
    const [response] = calls;
    expect(response.code).toBe(503);
    // NEVER a bare 503 — ALWAYS a JSON body with a structured error.
    expect(response.body).toBeTruthy();
    expect(response.body.error).toBe("ai_timeout");
    expect(response.body.retryAfterMs).toBe(1000);
    expect(response.body.symbol).toBe("EUR/USD");
    expect(typeof response.body.proxyLatencyMs).toBe("number");
  });

  it("test_predict_returns_200_on_success", async () => {
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    const { res, calls, done } = capture();
    await predictSignal(req({ symbol: "EUR/USD", timeframe: "1d" }), res);
    await done;

    expect(calls.length).toBe(1);
    const [response] = calls;
    expect(response.code).toBe(200);
    // Full prediction payload surfaces verbatim with authoritative metadata.
    expect(response.body.signal).toBe("BUY");
    expect(response.body.confidence).toBe(99);
    expect(response.body.target_price).toBe(1.16);
    expect(response.body.current_price).toBe(1.1525);
    expect(response.body.symbol).toBe("EUR/USD");
    expect(response.body.proxied).toBe(true);
    expect(response.body.market_waiting).toBe(false);
    expect(Array.isArray(response.body.candles)).toBe(true);
    expect(response.body.candles).toHaveLength(60);
    expect(response.body.barCount).toBe(60);
    expect(typeof response.body.proxyLatencyMs).toBe("number");
  });
});