/**
 * trading-panel.standalone.dom.test.tsx — STANDALONE SaaS MODE.
 *
 * When the backend serves the standalone fallback tape (PO bridge not live) the
 * panel must stay USABLE — a real proxy / labeled synthetic price is a tradeable
 * tape — while ALWAYS disclosing where the price came from via the standalone
 * badge. This is the counterpart to trading-panel.po-offline.dom.test.tsx: the
 * SAME non-PO OTC quote that locks the panel OUTSIDE standalone must be
 * tradeable and badged INSIDE standalone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { TradingPanel } from "@/components/trading/trading-panel";
import { useTradingStore } from "@/store/useTradingStore";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { resetAll, ui } from "@/test/harness";
import { setSocketConnected } from "@/test/mocks/socket";
import { setStandaloneMode } from "@/lib/standaloneMode";
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

const quote = (overrides: Partial<MarketQuote> = {}): MarketQuote => ({
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
  source: "standalone:frankfurter",
  stale: false,
  freshAgeMs: 420,
  staleLive: false,
  ...overrides,
});

function armStandalone(
  mode: "mixed" | "standalone_proxy" | "standalone_synthetic",
) {
  setStandaloneMode(true, mode);
  act(() => {
    useTradingStore.setState({
      activeSymbol: "EUR/USD",
      currentPrice: 1.0845,
      feedStatus: "standalone",
      feedMode: mode,
      lastPriceUpdate: new Date().toISOString(),
      isKillSwitchLocked: false,
      isTradeActive: false,
      predictionData: { signal: "BUY", confidence: 0.97, tier: "T1" },
    } as never);
  });
}

describe("standalone mode — panel stays usable + discloses the tape", () => {
  beforeEach(() => {
    resetAll();
    setSocketConnected(true);
  });

  it("shows a PUBLIC PROXY badge and a tradeable OTC proxy price", () => {
    armStandalone("mixed");
    useMarketTerminalStore.getState().setQuotes([quote()]);
    ui(<TradingPanel stalePrice={false} />);

    const badge = screen.getByTestId("standalone-feed-badge");
    expect(badge).toHaveTextContent(/PUBLIC PROXY/i);

    // The SAME quote that locks the panel in the PO-offline test is tradeable here.
    expect(screen.queryByTestId("panel-po-offline-marker")).toBeNull();
    expect(screen.queryByTestId("panel-po-offline-signal")).toBeNull();
    expect(screen.queryByTestId("panel-po-offline-banner")).toBeNull();
    expect(screen.getAllByText(/\$1\.0845/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("action-call")).not.toBeDisabled();
    expect(screen.getByTestId("action-put")).not.toBeDisabled();
  });

  it("labels the synthetic OTC tape SIMULATED", () => {
    armStandalone("standalone_synthetic");
    useMarketTerminalStore.getState().setQuotes([
      quote({ source: "standalone_synthetic" }),
    ]);
    ui(<TradingPanel stalePrice={false} />);

    expect(screen.getByTestId("standalone-feed-badge")).toHaveTextContent(
      /SIMULATED/i,
    );
    expect(screen.getByTestId("action-call")).not.toBeDisabled();
  });
});
