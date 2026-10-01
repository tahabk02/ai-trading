/**
 * predictive-intelligence.verdict-banner.dom.test.tsx
 *
 * DOM-level contract for the withheld-vs-error banner, and specifically the
 * regression that produced the "T1 PREMIUM 99.32% beside SIGNAL: WAITING"
 * illusion.
 *
 * Two things must hold on screen:
 *
 *  1. A transport ERROR must suppress the tier badge AND replace the
 *     confidence gauge. After a failed request the verdict in the store is
 *     STALE, so any number rendered next to a dead-connection banner is a
 *     fabrication.
 *  2. A WITHHELD verdict is NOT an error. The confluence number is real and
 *     auditable, so it must stay visible, and it must be presented calmly
 *     (slate) rather than as a failure (rose).
 *
 * The pure classifier is covered in `lib/__tests__/verdict-state.test.ts`; this
 * file proves the component actually honours it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PredictiveIntelligence } from "@/components/trading/predictive-intelligence";
import { useTradingStore } from "@/store/useTradingStore";

afterEach(cleanup);

/** Seed the store with a real withheld tape, as the engine now emits it. */
const WITHHELD_VERDICT = {
  symbol: "EUR/USD",
  signal: null,
  confidence: 0.9932,
  book_agreement: 99.32,
  market_waiting: true,
  waiting_reason: "CONFLUENCE_BELOW_THERMAL",
  suppressed_reason: "no_directional_signal",
  executable: false,
  tier: "T5",
  tier_label: "WEAK",
  timeframe: "5m",
  timeframe_key: "5m",
};

const ACTIONABLE_VERDICT = {
  ...WITHHELD_VERDICT,
  signal: "BUY",
  executable: true,
  tier: "T1",
  tier_label: "PREMIUM",
  market_waiting: false,
  suppressed_reason: null,
};

function seed(state: Record<string, unknown>) {
  act(() => {
    useTradingStore.setState({
      activeSymbol: "EUR/USD",
      currentPrice: 1.0845,
      selectedTimeframe: "5m",
      isLoading: false,
      error: null,
      quoteStreamWaiting: false,
      ...state,
    } as never);
  });
}

const renderPanel = () => render(<PredictiveIntelligence />);

const badge = () => screen.queryByTestId("tier-badge");
const errorBanner = () => screen.queryByTestId("verdict-error-banner");
const withheldBanner = () => screen.queryByTestId("verdict-withheld-banner");
const gaugeSuppressed = () => screen.queryByTestId("verdict-gauge-suppressed");

describe("PredictiveIntelligence — verdict banner", () => {
  it("shows a calm WITHHELD banner and keeps the real number when a gate declines", () => {
    seed({ predictionData: WITHHELD_VERDICT });
    renderPanel();

    expect(withheldBanner()).toBeTruthy();
    expect(withheldBanner()!.textContent).toContain("RISK GATE WITHHELD");
    // A withheld verdict is a NORMAL outcome, not a transport failure.
    expect(errorBanner()).toBeNull();
    // The confluence is genuine and auditable, so the gauge stays on screen
    // (it is NOT replaced by the "no verdict this cycle" placeholder).
    expect(gaugeSuppressed()).toBeNull();
    // The tier is still shown, because the engine demoted it to T5/WEAK.
    expect(badge()).toBeTruthy();
  });

  it("suppresses the tier badge AND the confidence gauge on a transport error", () => {
    seed({ predictionData: WITHHELD_VERDICT });
    renderPanel();

    // Now simulate the request failing while a stale verdict is still stored.
    act(() => {
      useTradingStore.setState({ error: "504 Gateway Timeout" } as never);
    });

    expect(errorBanner()).toBeTruthy();
    expect(errorBanner()!.textContent).toMatch(/TIMEOUT|ENGINE ERROR|CONNECTION/i);
    // The load-bearing assertions: no stale number, no stale premium tier.
    expect(badge()).toBeNull();
    expect(gaugeSuppressed()).toBeTruthy();
    // A transport error is never dressed up as a risk-gate decision.
    expect(withheldBanner()).toBeNull();
  });

  it("clears the error banner once the transport recovers", () => {
    seed({ predictionData: WITHHELD_VERDICT, error: "503 Service Unavailable" });
    renderPanel();
    expect(errorBanner()).toBeTruthy();
    expect(badge()).toBeNull();

    act(() => {
      useTradingStore.setState({ error: null } as never);
    });

    expect(errorBanner()).toBeNull();
    expect(badge()).toBeTruthy();
  });

  it("shows no withheld banner for an actionable call", () => {
    seed({ predictionData: ACTIONABLE_VERDICT });
    renderPanel();

    expect(withheldBanner()).toBeNull();
    expect(errorBanner()).toBeNull();
    expect(gaugeSuppressed()).toBeNull();
    expect(badge()).toBeTruthy();
  });
});
