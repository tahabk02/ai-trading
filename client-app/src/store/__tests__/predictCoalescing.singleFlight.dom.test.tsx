/**
 * PART 41 [401b] — /predict SINGLE-FLIGHT + SHORT-TTL (store level).
 *
 * Faster must never mean looser gates or more requests. The store coalesces:
 *   1) identity single-flight — N concurrent callers for the SAME
 *      (symbol, timeframe) share ONE network fetch (one promise, no duplicate
 *      sockets, no ERR_INSUFFICIENT_RESOURCES);
 *   2) short-TTL debounce — a repeat dispatch for the same key within the 5s
 *      window starts NO new request (server re-verdict already cached).
 * Different symbols/keys must NOT collide.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import apiClient from "@/services/api";
import { useTradingStore } from "@/store/useTradingStore";

vi.mock("@/services/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return { ...actual, default: { getPrediction: vi.fn() } };
});

const state = () => useTradingStore.getState();

function predictPayload(symbol: string, over: Record<string, unknown> = {}) {
  return {
    symbol,
    signal: "BUY",
    confidence: 96.5,
    current_price: 1.1051,
    target_price: 1.12,
    rf_probability: 0.61,
    ml_probability: 0.59,
    model_accuracy: 0.57,
    timeframe: "M3",
    candles: [
      { time: 1, open: 1.1, high: 1.11, low: 1.09, close: 1.105 },
      { time: 2, open: 1.105, high: 1.12, low: 1.1, close: 1.1058 },
    ],
    timestamp: new Date().toISOString(),
    ...over,
  };
}

describe("PART 41 [401b] single-flight + short-TTL /predict coalescing", () => {
  beforeEach(() => {
    (vi.mocked(apiClient.getPrediction) as ReturnType<typeof vi.fn>).mockResolvedValue(
      predictPayload("EUR/USD") as never,
    );
    useTradingStore.setState({
      activeSymbol: "EUR/USD",
      selectedTimeframe: "M3",
      selectedHorizonMinutes: 3,
      selectedExpirationSeconds: 180,
      predictionData: null,
      predictionBySymbol: {},
    });
  });

  it("fans N concurrent callers for ONE key onto a single network fetch", async () => {
    let networkCalls = 0;
    (vi.mocked(apiClient.getPrediction as never) as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        networkCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return predictPayload("EUR/USD");
      },
    );

    const p1 = state().getPrediction("EUR/USD", "M3", undefined, true);
    const p2 = state().getPrediction("EUR/USD", "M3", undefined, true);
    const p3 = state().getPrediction("EUR/USD", "M3", undefined, true);

    // Coalescing happens synchronously at dispatch: exactly one network fetch
    // was started for the three concurrent, identical callers.
    expect(networkCalls).toBe(1);

    await Promise.all([p1, p2, p3]);
    expect(networkCalls).toBe(1);
  });

  it("re-dispatches within the 5s TTL window with NO new request", async () => {
    let networkCalls = 0;
    (vi.mocked(apiClient.getPrediction as never) as ReturnType<typeof vi.fn>).mockImplementation(
      async (symbol: string) => {
        networkCalls += 1;
        return predictPayload(symbol);
      },
    );

    await state().getPrediction("GBP/USD", "M3"); // staged → stamps the 5s window
    expect(networkCalls).toBe(1);

    await state().getPrediction("GBP/USD", "M3"); // inside TTL → no new request
    expect(networkCalls).toBe(1);
  });

  it("never coalesces across DIFFERENT keys", async () => {
    let networkCalls = 0;
    (vi.mocked(apiClient.getPrediction as never) as ReturnType<typeof vi.fn>).mockImplementation(
      async (symbol: string) => {
        networkCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return predictPayload(symbol);
      },
    );

    const p1 = state().getPrediction("AUD/USD", "M3", undefined, true);
    const p2 = state().getPrediction("USD/JPY", "M3", undefined, true);
    const p3 = state().getPrediction("GBP/USD", "M5", undefined, true);

    expect(networkCalls).toBe(3);

    await Promise.all([p1, p2, p3]);
    expect(networkCalls).toBe(3);
  });
});