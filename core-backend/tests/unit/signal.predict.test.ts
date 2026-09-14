import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    signal = { findMany: vi.fn(), findUnique: vi.fn() };
  },
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../src/config/secrets", () => ({
  secrets: {
    AI_ENGINE_URL: "http://127.0.0.1:8000",
    AI_ENGINE_TIMEOUT_MS: 2_000,
    AI_ENGINE_MAX_RETRIES: 1,
    AI_ENGINE_API_KEY: "test",
  },
}));
vi.mock("../../src/services/symbolRegistry.service", () => ({
  symbolRegistry: {
    normalizeSymbol: (symbol: string) => symbol.trim().toUpperCase(),
    isValidSymbolSync: () => true,
    getAll: vi.fn(async () => [{ symbol: "EUR/USD" }]),
    getDigits: () => 5,
  },
}));
vi.mock("../../src/services/forexData.service", () => ({
  forexDataService: {
    getLiveSpotFresh: vi.fn(async () => ({
      success: true,
      price: 1.1,
      source: "live",
    })),
    getHistoricalCandles: vi.fn(async () => ({
      success: true,
      bars: Array.from({ length: 30 }, (_, index) => ({
        timestamp: new Date(Date.now() - (30 - index) * 86_400_000),
        open: 1.1,
        high: 1.11,
        low: 1.09,
        close: 1.1,
        volume: 1,
      })),
      source: "test",
    })),
    getBufferedCandles: vi.fn(async () => []),
    computeAtr: vi.fn(() => ({ atr: 0.01 })),
    computeTargetPrice: vi.fn(() => 1.11),
    syncPayouts: vi.fn(async () => undefined),
  },
}));
vi.mock("../../src/services/websocket.service", () => ({
  websocketService: { broadcastHighConfidenceSignal: vi.fn() },
}));
vi.mock("../../src/services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    getLatestEntry: vi.fn(() => ({ price: 1.1, tsMs: Date.now() })),
    getLatestSpread: vi.fn(() => ({ bid: 1.0999, ask: 1.1001 })),
  },
}));

type ResponseStub = {
  statusCode: number;
  status: (code: number) => ResponseStub;
  setHeader: () => ResponseStub;
  json: (body: unknown) => ResponseStub;
};

const responseStub = (): ResponseStub => {
  const response = {
    statusCode: 200,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    setHeader() {
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
    body: undefined as unknown,
  } as ResponseStub & { body: unknown };
  return response;
};

const request = (body: unknown) => ({ body }) as never;

const { predictSignal } =
  await import("../../src/controllers/signal.controller");

describe("POST /api/v1/predict contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("test_predict_returns_400_on_missing_symbol", async () => {
    const response = responseStub();
    await predictSignal(request({ timeframe: "1m" }), response as never);
    expect(response.statusCode).toBe(400);
    expect(
      (response as ResponseStub & { body: { message: string } }).body.message,
    ).toContain("symbol");
  });

  it("test_predict_returns_503_with_body_on_ai_timeout", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(
      new axios.AxiosError("timeout", "ECONNABORTED"),
    );
    const response = responseStub();
    await predictSignal(
      request({ symbol: "GBP/USD", timeframe: "1m" }),
      response as never,
    );
    expect(response.statusCode).toBe(503);
    expect(
      (
        response as ResponseStub & {
          body: { error: string; retryAfterMs: number };
        }
      ).body,
    ).toEqual(
      expect.objectContaining({ error: "ai_timeout", retryAfterMs: 1000 }),
    );
  });

  it("test_predict_returns_200_on_success", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      data: { signal: "BUY", confidence: 0.9 },
    } as never);
    const response = responseStub();
    await predictSignal(
      request({ symbol: "EUR/USD", timeframe: "1m" }),
      response as never,
    );
    expect(response.statusCode).toBe(200);
    expect(
      (response as ResponseStub & { body: { target_price: number } }).body
        .target_price,
    ).toBe(1.11);
  });
});
