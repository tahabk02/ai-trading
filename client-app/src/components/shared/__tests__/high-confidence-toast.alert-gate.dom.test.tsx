import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { HighConfidenceToast } from "@/components/shared/high-confidence-toast";
import { useTradingStore } from "@/store/useTradingStore";
import { resetAll, ui } from "@/test/harness";
import { socketState } from "@/test/mocks/socket";

vi.mock("@/hooks/useSocket", async () => {
  const m = await import("@/test/mocks/socket");
  return {
    useSocket: () => ({
      socket: m.socketState.socket,
      connected: m.socketState.connected,
    }),
    SocketProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

/**
 * PART 41 [403] — a high-confidence (98%) verdict on a GATED symbol must be
 * silent: no toast, no sound. A score is only alertable when the metal is
 * genuinely executable — executable === true AND tier in T1..T3 AND
 * regime_gate === "tradable". The client re-verifies the same predicate on
 * both the local prediction monitor and the WS payload.
 */

const mount = () => ui(<HighConfidenceToast />);

/** Toasts render inside a collapsed panel — open it before asserting. */
function openSignalCenter() {
  const btn = screen.getByText(/signal center/i).closest("button");
  expect(btn).toBeTruthy();
  act(() => btn!.click());
}

function seedPrediction(data: Record<string, unknown>) {
  act(() => {
    useTradingStore.setState({
      predictionData: {
        symbol: "EUR/USD",
        signal: "BUY",
        confidence: 98,
        executable: true,
        tier: "T1",
        regime_gate: "tradable",
        timeframe: "1m",
        ...data,
      },
    } as never);
  });
}

describe("high-confidence toast — alert gate (PART 41 [403])", () => {
  beforeEach(() => {
    resetAll();
  });

  it("is silent for a 98% verdict on a gated symbol (not executable)", () => {
    mount();
    seedPrediction({ confidence: 98, executable: false, tier: "T5", regime_gate: "pending_high_precision" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/signal center/i)).toBeNull();
  });

  it("is silent for a 98% verdict whose tier is T4 (executable but off-ladder)", () => {
    mount();
    seedPrediction({ confidence: 98, executable: true, tier: "T4", regime_gate: "tradable" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is silent for a 98% verdict whose regime gate is still pending", () => {
    mount();
    seedPrediction({ confidence: 98, executable: true, tier: "T1", regime_gate: "pending_high_precision" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("raises the toast for an eligible executable T1/tradable verdict", () => {
    mount();
    seedPrediction({ confidence: 98, executable: true, tier: "T1", regime_gate: "tradable" });
    openSignalCenter();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/EUR\/USD/i)).toBeTruthy();
  });

  it("re-verifies the gate on the WS payload and stays silent for a rogue scored-only one", () => {
    mount();
    act(() => {
      socketState.socket.server("high_confidence_signal", {
        symbol: "BTC/USD",
        signalType: "BUY",
        confidence: 98,
        price: 67000,
        targetPrice: 67200,
        timeframe: "1m",
        executable: false,
        tier: "T5",
        regime_gate: "pending_high_precision",
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fails closed on a wire verdict that can't prove the execution surface", () => {
    mount();
    act(() => {
      socketState.socket.server("high_confidence_signal", {
        symbol: "GBP/USD",
        signalType: "SELL",
        confidence: 98,
        price: 1.32,
        targetPrice: 1.318,
        timeframe: "1m",
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("listens to the WS and raises the toast for an eligible wire verdict", () => {
    mount();
    act(() => {
      socketState.socket.server("high_confidence_signal", {
        symbol: "BTC/USD",
        signalType: "BUY",
        confidence: 98,
        price: 67000,
        targetPrice: 67200,
        timeframe: "1m",
        executable: true,
        tier: "T2",
        regime_gate: "tradable",
      });
    });
    openSignalCenter();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});