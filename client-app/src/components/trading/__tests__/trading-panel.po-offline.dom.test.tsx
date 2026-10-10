/**
 * trading-panel.po-offline.dom.test.tsx — PART 43.4 [469].
 *
 * For an OTC pair priced by a NON-PO feed (PO OFFLINE / market proxy) the panel
 * must NOT print a tradeable execution price: it shows "---" and names the
 * state. A genuine PO print is untouched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { TradingPanel } from "@/components/trading/trading-panel";
import { useTradingStore } from "@/store/useTradingStore";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { resetAll, ui } from "@/test/harness";
import { setSocketConnected } from "@/test/mocks/socket";
import type { MarketQuote } from "@/services/api";

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

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      getQuotes: vi.fn().mockResolvedValue({ quotes: [] }),
      multiPredict: vi.fn().mockResolvedValue({ results: [] }),
    },
  };
});

const quote = (
  overrides: Partial<MarketQuote> = {},
): MarketQuote => ({
  symbol: "EUR/USD",
  name: "Euro / US Dollar",
  type: "otc",
  assetSubType: "otc",
  label: "EUR/USD OTC",
  digits: 5,
  payout: 92,
  price: 1.0845,
  bid: null,
  ask: null,
  spread: null,
  tickCount: 2400,
  lastTickAt: "2026-10-06T15:00:00.000Z",
  ageMs: 420,
  source: "pocket_option_ssot",
  stale: false,
  freshAgeMs: 420,
  staleLive: false,
  ...overrides,
});

function arm(overrides: Record<string, unknown> = {}) {
  act(() => {
    useTradingStore.setState({
      activeSymbol: "EUR/USD",
      currentPrice: 1.0845,
      feedStatus: "live",
      lastPriceUpdate: new Date().toISOString(),
      isKillSwitchLocked: false,
      isTradeActive: false,
      predictionData: { signal: "BUY", confidence: 0.97, tier: "T1" },
      ...overrides,
    } as never);
  });
}

describe("[469] trading panel — OTC priced by a market proxy shows no price", () => {
  beforeEach(() => {
    resetAll();
    setSocketConnected(true);
  });

  it("shows '---' and the PO OFFLINE marker for a non-PO OTC quote", () => {
    arm();
    useMarketTerminalStore.getState().setQuotes([
      quote({ source: "frankfurter:live" }),
    ]);
    ui(<TradingPanel stalePrice={false} />);

    expect(screen.getByTestId("panel-po-offline-marker")).toBeInTheDocument();
    expect(screen.getAllByText("---").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$1\.0845/)).toBeNull();
  });

  it("keeps the price for a genuine PO OTC quote (no marker)", () => {
    arm();
    useMarketTerminalStore.getState().setQuotes([quote()]);
    ui(<TradingPanel stalePrice={false} />);

    expect(screen.queryByTestId("panel-po-offline-marker")).toBeNull();
    expect(screen.getAllByText(/\$1\.0845/).length).toBeGreaterThan(0);
  });
});

describe("[473]/[474] trading panel — PO-offline OTC is not tradeable", () => {
  beforeEach(() => {
    resetAll();
    setSocketConnected(true);
  });

  it("locks BUY/SELL and shows the PO OFFLINE signal + banner (never a verdict)", () => {
    arm();
    useMarketTerminalStore.getState().setQuotes([
      quote({ source: "open_er_api:live" }),
    ]);
    ui(<TradingPanel stalePrice={false} />);

    expect(screen.getByTestId("panel-po-offline-signal")).toHaveTextContent(
      /PO OFFLINE/i,
    );
    expect(screen.getByTestId("panel-po-offline-banner")).toBeInTheDocument();
    expect(screen.getByTestId("action-call")).toBeDisabled();
    expect(screen.getByTestId("action-put")).toBeDisabled();
  });

  it("does not treat a fresh proxy tick as live even when the socket is up", () => {
    // Fresh non-PO source (age < 2s) but PO offline — the panel must still lock.
    arm();
    useMarketTerminalStore.getState().setQuotes([
      quote({ source: "frankfurter:live", freshAgeMs: 300, staleLive: false }),
    ]);
    ui(<TradingPanel stalePrice={false} />);

    expect(screen.getByTestId("action-call")).toBeDisabled();
    expect(screen.getByTestId("action-put")).toBeDisabled();
  });

  it("leaves a genuine PO OTC verdict tradeable (no PO OFFLINE surfaces)", () => {
    arm();
    useMarketTerminalStore.getState().setQuotes([quote()]);
    ui(<TradingPanel stalePrice={false} />);

    expect(screen.queryByTestId("panel-po-offline-signal")).toBeNull();
    expect(screen.queryByTestId("panel-po-offline-banner")).toBeNull();
    expect(screen.getByTestId("action-call")).not.toBeDisabled();
    expect(screen.getByTestId("action-put")).not.toBeDisabled();
  });

  it("never shows PO OFFLINE for a REAL forex pair on a proxy fallback", () => {
    act(() => {
      useTradingStore.setState({
        activeSymbol: "EUR/SEK",
        currentPrice: 11.2345,
        feedStatus: "live",
        lastPriceUpdate: new Date().toISOString(),
        isKillSwitchLocked: false,
        isTradeActive: false,
        predictionData: { signal: "BUY", confidence: 0.97, tier: "T1" },
      } as never);
    });
    useMarketTerminalStore.getState().setQuotes([
      quote({
        symbol: "EUR/SEK",
        type: "forex",
        assetSubType: "forex",
        source: "frankfurter:live",
      }),
    ]);
    ui(<TradingPanel stalePrice={false} />);

    expect(screen.queryByTestId("panel-po-offline-signal")).toBeNull();
    expect(screen.queryByTestId("panel-po-offline-banner")).toBeNull();
  });
});
