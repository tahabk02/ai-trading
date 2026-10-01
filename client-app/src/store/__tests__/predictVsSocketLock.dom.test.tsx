/**
 * HTTP /predict MUST NOT BREAK THE EXPIRY-SCOPED SIGNAL LOCK.
 *
 * Regression cover for a live money-losing race:
 *
 *   t0  A /predict request goes in flight (debounced, ≤1 in flight per key).
 *   t1  A WebSocket dispatch arrives and `applyLiveSignal` COMMITS the lock —
 *       direction BUY, TGT 1.1200, confidence 97.2 — for the operator's
 *       (symbol, horizon, expiry).
 *   t2  The /predict response from t0 resolves. It carries a DIFFERENT verdict
 *       (SELL / 1.0900 / 88%) because it was graded on an older snapshot.
 *
 * `applyLiveSignal` deliberately reads the committed verdict back out of the
 * lock so per-tick dispatches cannot repaint the entry contract, but the HTTP
 * path wrote `predictionData` outright and never consulted the lock. So at t2
 * the panel showed SELL while the operator had already been committed to BUY —
 * and `trading-panel.tsx` reads `predictionData.signal` to enable the rings,
 * so the BUY button and the displayed direction could disagree.
 *
 * `requestId` only orders /predict against /predict. It cannot order an HTTP
 * response against a WebSocket commit, which is why this hole existed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import apiClient from "@/services/api";
import { LOCK_MIN_CONFIDENCE_PCT } from "@/lib/signalLock";
import { useTradingStore } from "@/store/useTradingStore";

vi.mock("@/services/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return { ...actual, default: { getPrediction: vi.fn() } };
});

const SYMBOL = "EUR/USD";
const HORIZON = 3;
const EXPIRY = 180;

const LOCKED = {
  direction: "BUY",
  price: 1.1058,
  targetPrice: 1.12,
  confidence: LOCK_MIN_CONFIDENCE_PCT + 1.2,
};

const STALE_HTTP_VERDICT = {
  direction: "SELL",
  confidence: 88,
  target_price: 1.09,
};

function predictPayload(over: Record<string, unknown> = {}) {
  return {
    symbol: SYMBOL,
    signal: "SELL",
    confidence: STALE_HTTP_VERDICT.confidence,
    current_price: 1.1051,
    target_price: STALE_HTTP_VERDICT.target_price,
    rf_probability: 0.61,
    rf_holdout_accuracy: 0.58,
    ml_probability: 0.59,
    model_accuracy: 0.57,
    timeframe: "M3",
    candles: [
      { time: 1, open: 1.1, high: 1.11, low: 1.09, close: 1.105 },
      { time: 2, open: 1.105, high: 1.12, low: 1.1, close: 1.1058 },
    ],
    indicators: { rsi_14: 58, sma_20: 1.1, sma_50: 1.09 },
    timestamp: new Date().toISOString(),
    ...over,
  };
}

const state = () => useTradingStore.getState();

/** Commit the lock exactly the way a live WS dispatch does. */
function commitViaWebSocket() {
  state().applyLiveSignal({
    symbol: SYMBOL,
    direction: LOCKED.direction,
    price: LOCKED.price,
    target_price: LOCKED.targetPrice,
    confidence: LOCKED.confidence,
    timestamp: new Date().toISOString(),
  } as never);
}

beforeEach(() => {
  // A benign default: `setActiveSymbol` below kicks off its own /predict, and
  // an unstubbed mock would reject that with `undefined.symbol`.
  vi.mocked(apiClient.getPrediction).mockResolvedValue(
    predictPayload() as never,
  );
  useTradingStore.setState({
    activeSymbol: SYMBOL,
    selectedTimeframe: "M3",
    selectedHorizonMinutes: HORIZON,
    selectedExpirationSeconds: EXPIRY,
    predictionData: null,
    predictionBySymbol: {},
    liveSignals: [],
    currentPrice: LOCKED.price,
    error: null,
  });
  // The lock is a module-level singleton; a symbol change is what clears it, so
  // no test can inherit a verdict committed by the previous one.
  state().setActiveSymbol?.(SYMBOL);
});

describe("a stale /predict response cannot overwrite a locked WS verdict", () => {
  it("keeps the committed direction, target and confidence", async () => {
    commitViaWebSocket();
    const locked = state().predictionData;
    expect(locked?.signal).toBe(LOCKED.direction);
    expect(locked?.target_price).toBe(LOCKED.targetPrice);

    // t2: the in-flight HTTP response finally lands, carrying the OPPOSITE
    // direction it graded before the lock existed.
    vi.mocked(apiClient.getPrediction).mockResolvedValue(
      predictPayload() as never,
    );
    await state().getPrediction(SYMBOL, "M3", undefined, true);

    const after = state().predictionData;
    expect(after?.signal).toBe("BUY");
    expect(after?.confidence).toBe(LOCKED.confidence);
    expect(after?.target_price).toBe(LOCKED.targetPrice);
  });

  it("keeps the per-symbol snapshot consistent with the panel", async () => {
    commitViaWebSocket();
    vi.mocked(apiClient.getPrediction).mockResolvedValue(
      predictPayload() as never,
    );
    await state().getPrediction(SYMBOL, "M3", undefined, true);

    // Switching back to the pair restores from `predictionBySymbol`; if the two
    // writers disagree the operator sees the verdict change on a re-select.
    const snapshot = state().predictionBySymbol[SYMBOL];
    expect(snapshot?.signal).toBe("BUY");
    expect(snapshot).toEqual(state().predictionData);
  });

  it("still refreshes the non-verdict diagnostics from the fresh response", async () => {
    commitViaWebSocket();
    vi.mocked(apiClient.getPrediction).mockResolvedValue(
      predictPayload({
        market_waiting: true,
        waiting_reason: "cluster_alignment_below_gate",
        rf_probability: 0.77,
      }) as never,
    );
    await state().getPrediction(SYMBOL, "M3", undefined, true);

    const after = state().predictionData;
    // Verdict frozen...
    expect(after?.signal).toBe("BUY");
    // ...but newer, non-contract information still reaches the operator.
    expect(after?.market_waiting).toBe(true);
    expect(after?.waiting_reason).toBe("cluster_alignment_below_gate");
    expect(after?.rf_probability).toBe(0.77);
  });
});

describe("with no lock held, /predict still owns the verdict", () => {
  it("applies the HTTP verdict verbatim", async () => {
    vi.mocked(apiClient.getPrediction).mockResolvedValue(
      predictPayload() as never,
    );
    await state().getPrediction(SYMBOL, "M3", undefined, true);

    expect(state().predictionData?.signal).toBe("SELL");
    expect(state().predictionData?.target_price).toBe(1.09);
  });
});

describe("a horizon or expiry switch re-opens the contract", () => {
  it("lets the HTTP verdict through after the expiry changes", async () => {
    commitViaWebSocket();
    vi.mocked(apiClient.getPrediction).mockResolvedValue(
      predictPayload() as never,
    );
    // A different expiry is a different contract: the old verdict must not
    // survive, so /predict is free to publish the new evaluation.
    useTradingStore.setState({ selectedExpirationSeconds: 300 });
    await state().getPrediction(SYMBOL, "M3", undefined, true);

    expect(state().predictionData?.signal).toBe("SELL");
  });
});
