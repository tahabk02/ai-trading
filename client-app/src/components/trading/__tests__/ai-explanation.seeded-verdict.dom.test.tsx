import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { AIExplanation } from "@/components/trading/ai-explanation";
import { useTradingStore } from "@/store/useTradingStore";
import { resetAll, ui } from "@/test/harness";

/**
 * PART 41 [401a] — SEEDED VERDICT: shown with age, NON-EXECUTABLE until a fresh
 * tick. While `isLoading` (a fresh /predict resolves over the in-store
 * snapshot) or the last live tick is stale, the panel must:
 *   • show a "Seeded · Ns" amber marker (never PREMIUM emerald/rose styling),
 *   • degrade the TierBadge (gray — "(stale quote)"),
 *   • label the footer "seeded Ns ago".
 * Once a fresh tick + fresh verdict are in hand, the marker disappears and the
 * verdict wears its normal colored styling again.
 */

const mount = () => ui(<AIExplanation />);

function freshPrediction(over: Record<string, unknown> = {}) {
  return {
    symbol: "EUR/USD",
    signal: "BUY",
    confidence: 97.5,
    tier: "T1",
    regime_gate: "tradable",
    current_price: 1.1058,
    target_price: 1.12,
    timeframe: "1m",
    rf_probability: 0.61,
    ml_probability: 0.59,
    model_accuracy: 0.57,
    timestamp: new Date(Date.now() - 2_000).toISOString(),
    ...over,
  };
}

describe("PART 41 [401a] seeded verdict — age + non-executable", () => {
  beforeEach(() => {
    resetAll();
    useTradingStore.setState({
      activeSymbol: "EUR/USD",
      selectedTimeframe: "M3",
      selectedHorizonMinutes: 3,
    });
  });

  it("marks a snapshot being refreshed (isLoading) as Seeded and degrades the badge", () => {
    const payload = freshPrediction({ timestamp: new Date(Date.now() - 75_000).toISOString() });
    useTradingStore.setState({
      predictionData: payload as never,
      lastPriceUpdate: new Date().toISOString(),
      isLoading: true,
    });
    mount();

    const marker = screen.getByTestId("ai-verdict-seed-marker");
    expect(marker.textContent).toMatch(/seeded · \d+s/i);
    expect(screen.getByTestId("tier-badge").getAttribute("title")).toMatch(
      /\(stale quote\)/,
    );
    expect(screen.getByText(/seeded \d+s ago/i)).toBeTruthy();
  });

  it("holds the verdict non-executable while the live tick is stale", () => {
    useTradingStore.setState({
      predictionData: freshPrediction() as never,
      lastPriceUpdate: new Date(Date.now() - 120_000).toISOString(),
      isLoading: false,
    });
    mount();

    expect(screen.getByTestId("ai-verdict-seed-marker")).toBeTruthy();
    expect(screen.getByTestId("tier-badge").getAttribute("title")).toMatch(
      /\(stale quote\)/,
    );
  });

  it("shows a clean, executable verdict once a fresh tick + fresh evaluation land", () => {
    useTradingStore.setState({
      predictionData: freshPrediction() as never,
      lastPriceUpdate: new Date().toISOString(),
      isLoading: false,
    });
    mount();

    expect(screen.queryByTestId("ai-verdict-seed-marker")).toBeNull();
    expect(screen.getByTestId("tier-badge").getAttribute("title")).not.toMatch(
      /\(stale quote\)/,
    );
    expect(screen.queryByText(/^Seeded ·/i)).toBeNull();
  });
});