/**
 * n8nDispatch.dom.test.tsx — PHASE 5 external n8n ingress, end to end through
 * the store.
 *
 * Two contracts meet here:
 *
 *  1. `applyLiveSignal` must PRESERVE external provenance. The `/signals/
 *     n8n-ingress` broadcast speaks Pocket's CALL/PUT vocabulary and carries a
 *     `departure` horizon; the store must map CALL→BUY / PUT→SELL and merge
 *     `dataSource: "n8n"` + the horizon instead of dropping them.
 *
 *  2. `executeTrade` must respect the external 60% floor. An n8n 65% verdict is
 *     DISPATCHABLE while an engine 65% verdict still hits the strict T1 (96.5%)
 *     floor — proving the carve-out is scoped to n8n, not a global relaxation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import apiClient from "@/services/api";
import { useTradingStore } from "@/store/useTradingStore";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { buildSignalView } from "@/lib/realtimeCandleAggregator";

vi.mock("@/services/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    default: {
      getPrediction: vi.fn(),
      getRiskState: vi.fn(),
      getRiskRules: vi.fn(),
      executeTrade: vi.fn(),
    },
  };
});

const SYMBOL = "GBP/USD";
const PRICE = 1.2634;

/** The exact departure contract the backend n8nIngress stamps. */
const DEPARTURE = {
  available: true,
  status: "ACTIVE" as const,
  reason: "n8n_ingress",
  side: "CALL" as const,
  strike_price: PRICE,
  target_price: PRICE,
  entry_window_start_ms: Date.now() - 15_000,
  entry_window_end_ms: Date.now() + 120_000,
  max_allowed_slippage: null,
  slippage: null,
};

const state = () => useTradingStore.getState();

function n8nPayload(over: Record<string, unknown> = {}) {
  return {
    symbol: SYMBOL,
    signalType: "CALL",
    signal: "CALL",
    current_price: PRICE,
    confidence: 65,
    dataSource: "n8n",
    source: "n8n",
    timestamp: new Date().toISOString(),
    horizon: { departure: DEPARTURE },
    ...over,
  };
}

beforeEach(() => {
  useMarketTerminalStore.getState().setMinTier("T1");
  useTradingStore.setState({
    activeSymbol: SYMBOL,
    selectedTimeframe: "M1",
    selectedHorizonMinutes: 3,
    selectedExpirationSeconds: 120,
    predictionData: null,
    predictionBySymbol: {},
    liveSignals: [],
    currentPrice: 0,
    lastPriceUpdate: null,
    lastTradeResult: null,
    isTradeActive: false,
  });
  vi.mocked(apiClient.getPrediction).mockResolvedValue({} as never);
  vi.mocked(apiClient.getRiskState).mockResolvedValue({
    killSwitchLocked: false,
    lockedReason: null,
  } as never);
  vi.mocked(apiClient.getRiskRules).mockResolvedValue({ rules: [] } as never);
  vi.mocked(apiClient.executeTrade).mockRejectedValue(new Error("upstream down"));
});

describe("applyLiveSignal — external n8n provenance is preserved", () => {
  it("maps CALL→BUY and keeps the dataSource + departure horizon", () => {
    state().applyLiveSignal(n8nPayload());
    const p = state().predictionData;
    expect(p?.signal).toBe("BUY");
    expect(p?.dataSource).toBe("n8n");
    expect(p?.horizon?.departure?.strike_price).toBe(PRICE);
    expect(p?.horizon?.departure?.side).toBe("CALL");
  });

  it("maps PUT→SELL", () => {
    state().applyLiveSignal(
      n8nPayload({ signalType: "PUT", signal: "PUT", horizon: { departure: { ...DEPARTURE, side: "PUT" } } }),
    );
    expect(state().predictionData?.signal).toBe("SELL");
    expect(state().predictionData?.dataSource).toBe("n8n");
  });

  it("seeds currentPrice so the terminal leaves the CONNECTING state", () => {
    expect(state().currentPrice).toBe(0);
    state().applyLiveSignal(n8nPayload());
    expect(state().currentPrice).toBe(PRICE);
    expect(state().lastPriceUpdate).not.toBeNull();
  });
});

describe("gate integration — the store verdict clears the external floor", () => {
  it("a 65% n8n verdict gates through buildSignalView (60% floor)", () => {
    state().applyLiveSignal(n8nPayload());
    const view = buildSignalView(state().predictionData);
    expect(view.gated).toBe(true);
    expect(view.gatedSignal).toBe("BUY");
    expect(view.gatePct).toBe(60);
  });
});

describe("executeTrade — external floor is scoped to n8n", () => {
  it("dispatches an n8n 65% verdict (passes the 60% floor)", async () => {
    state().applyLiveSignal(n8nPayload({ confidence: 65 }));
    await state().executeTrade("CALL");
    // Reaching the risk pre-check proves the floor gate was cleared.
    expect(apiClient.getRiskState).toHaveBeenCalledTimes(1);
    expect(state().lastTradeResult ?? "").not.toContain("below the 60%");
  });

  it("still blocks an engine 65% verdict at the strict T1 floor", async () => {
    useTradingStore.setState({
      predictionData: {
        symbol: SYMBOL,
        signal: "BUY",
        confidence: 65,
        current_price: PRICE,
        target_price: PRICE,
        timestamp: new Date().toISOString(),
      } as never,
      currentPrice: PRICE,
      lastPriceUpdate: new Date().toISOString(),
    });
    await state().executeTrade("CALL");
    expect(apiClient.getRiskState).not.toHaveBeenCalled();
    expect(state().lastTradeResult ?? "").toContain("below your T1 trade floor");
  });
});
