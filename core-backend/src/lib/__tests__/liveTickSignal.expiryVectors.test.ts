/**
 * liveTickSignal.expiryVectors.test.ts — PART 52 socket emission.
 *
 * Drives the dispatcher's broadcast path with a mocked AI-Engine verdict + a
 * real-looking tick tape and asserts the emitted `live_quant_signal` payload
 * carries the deterministic expiry/strike vectors (entry → aligned expiry,
 * projected endpoint, modeled probability + basis). This is the "backend
 * streams real calculated target prediction vectors to the WebSocket
 * broadcast" contract, proven at the emission boundary instead of assumed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  broadcastLiveQuantSignal: vi.fn(),
  broadcastHighConfidenceSignal: vi.fn(),
  getRecentWindow: vi.fn(),
  getLatestSpread: vi.fn(),
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/secrets", () => ({
  secrets: {
    AI_ENGINE_URL: "http://127.0.0.1:8000",
    AI_ENGINE_API_KEY: "test",
    TICK_SIGNAL_TIMEOUT_MS: "1000",
  },
}));

vi.mock("../../utils/aiEngineHttp", () => ({ AI_ENGINE_HTTP_AGENT: {} }));

vi.mock("../../messaging/signalStream", () => ({ publishDurableSignal: vi.fn() }));

vi.mock("../../lib/alertGate", () => ({ isAlertEligible: vi.fn(() => false) }));

vi.mock("../../services/websocket.service", () => ({
  websocketService: {
    broadcastLiveQuantSignal: mocks.broadcastLiveQuantSignal,
    broadcastHighConfidenceSignal: mocks.broadcastHighConfidenceSignal,
  },
}));

vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    getRecentWindow: mocks.getRecentWindow,
    getLatestSpread: mocks.getLatestSpread,
  },
}));

import { liveTickSignalDispatcher } from "../../services/liveTickSignal.dispatch";
import { alignExpiryMs } from "../expiryEngine";

const ENTRY_MS = Date.parse("2026-10-14T12:00:00.000Z");

const noisyTape = (base = 1.1, step = 0.0001, amp = 0.00005, n = 40) =>
  Array.from({ length: n }, (_, i) => base + step * i + (i % 2 ? amp : -amp));

const driveBroadcast = (symbol: string, data: Record<string, unknown>) => {
  (liveTickSignalDispatcher as unknown as {
    broadcast: (s: string, d: Record<string, unknown>) => void;
  }).broadcast(symbol, data);
  return mocks.broadcastLiveQuantSignal.mock.calls.at(-1)?.[0] as Record<
    string,
    any
  >;
};

beforeEach(() => {
  mocks.broadcastLiveQuantSignal.mockClear();
  mocks.getRecentWindow.mockReturnValue(
    noisyTape().map((price, i) => ({ price, tsMs: ENTRY_MS + i * 1000 })),
  );
});

describe("live_quant_signal expiry vectors", () => {
  it("carries entry/expiry timestamps, strike status and raw vectors", () => {
    const payload = driveBroadcast("EUR/USD", {
      signal: "BUY",
      confidence: 71.5,
      current_price: 1.1,
      target_price: 1.105,
      horizon_minutes: 1,
      timestamp: "2026-10-14T12:00:00.000Z",
    });

    expect(payload.entry_timestamp).toBe("2026-10-14T12:00:00.000Z");
    expect(payload.entry_price).toBe(1.1);
    expect(Date.parse(payload.expiry_timestamp)).toBe(alignExpiryMs(ENTRY_MS, 60));
    expect(payload.predicted_target_price).toBe(1.105);
    expect(payload.target_status).toBe("ABOVE");

    const vectors = payload.prediction_vectors;
    expect(vectors.start_price).toBe(1.1);
    expect(typeof vectors.predicted_end_price).toBe("number");
    expect(vectors.predicted_end_price).toBeGreaterThan(1.1);
    expect(vectors.probability_score).toBeGreaterThanOrEqual(0);
    expect(vectors.probability_score).toBeLessThanOrEqual(1);
    expect(vectors.probability_basis).toBe("regression_residual_gaussian");
    expect(vectors.direction).toBe("BUY");
    expect(vectors.horizon_seconds).toBe(60);
  });

  it("prefers the AI Engine's own regression block when present", () => {
    const payload = driveBroadcast("GBP/USD", {
      signal: "SELL",
      confidence: 80,
      current_price: 1.27,
      horizon_minutes: 1,
      timestamp: "2026-10-14T12:00:00.000Z",
      horizon: {
        target_regression: {
          available: true,
          predicted_end_price: 1.26512,
          hold_probability: 0.83,
          probability_basis: "regression_residual_gaussian",
        },
      },
    });

    expect(payload.predicted_target_price).toBe(1.26512);
    expect(payload.target_status).toBe("BELOW");
    expect(payload.prediction_vectors.predicted_end_price).toBe(1.26512);
    expect(payload.prediction_vectors.probability_score).toBe(0.83);
  });

  it("withholds the endpoint (null) when no tape and no engine value exist", () => {
    mocks.getRecentWindow.mockReturnValue([]);
    const payload = driveBroadcast("USD/JPY", {
      signal: "BUY",
      confidence: 65,
      current_price: 150.123,
      horizon_minutes: 1,
      timestamp: "2026-10-14T12:00:00.000Z",
    });

    expect(payload.predicted_target_price).toBeNull();
    expect(payload.target_status).toBeNull();
    expect(payload.prediction_vectors.predicted_end_price).toBeNull();
    expect(payload.prediction_vectors.probability_score).toBeNull();
    expect(payload.prediction_vectors.probability_basis).toBeNull();
  });
});
