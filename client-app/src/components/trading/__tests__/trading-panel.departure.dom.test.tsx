/**
 * trading-panel.departure.dom.test.tsx — the Quick Trade "Départ" readout.
 *
 * Pins the non-fabricating contract at the DOM boundary:
 *   - an available departure shows the real strike + a live window readout, and
 *     the exact entry price is echoed on the CALL/PUT buttons;
 *   - a withheld departure shows "WAITING FOR VALID ENTRY LEVEL" and NO price —
 *     it never invents a level;
 *   - the readout is DISPLAY ONLY: it does not unlock the execution buttons,
 *     which stay behind the existing signal/staleness/kill-switch gate.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import { TradingPanel } from "@/components/trading/trading-panel";
import { useTradingStore } from "@/store/useTradingStore";
import { resetAll, ui } from "@/test/harness";
import { setSocketConnected } from "@/test/mocks/socket";
import { formatPairPrice } from "@/utils/format";

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

const ARMED = { signal: "BUY", confidence: 0.97 };

function departure(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    available: true,
    status: "ACTIVE",
    reason: null,
    side: "CALL",
    strike_price: 1.0845,
    target_price: 1.0865,
    entry_window_start_ms: now - 1_000,
    entry_window_end_ms: now + 60_000,
    max_allowed_slippage: 0.01,
    slippage: 0,
    ...overrides,
  };
}

function arm(overrides: Record<string, unknown> = {}) {
  act(() => {
    useTradingStore.setState({
      activeSymbol: "EUR/USD",
      currentPrice: 1.0845,
      feedStatus: "live",
      lastPriceUpdate: new Date().toISOString(),
      isKillSwitchLocked: false,
      isTradeActive: false,
      expirationSeconds: 300,
      selectedExpirationSeconds: 300,
      predictionData: { ...ARMED, tier: "T1", horizon: { departure: departure() } },
      ...overrides,
    } as never);
  });
}

const readout = () => screen.getByTestId("departure-readout");
const call = () => screen.getByTestId("action-call");
const put = () => screen.getByTestId("action-put");

describe("trading panel — exact departure readout", () => {
  beforeEach(() => {
    resetAll();
    setSocketConnected(true);
  });

  it("shows the real strike + ACTIVE window and echoes it on the buttons", () => {
    arm();
    ui(<TradingPanel stalePrice={false} />);
    expect(readout()).toHaveAttribute("data-status", "ACTIVE");
    expect(screen.getByTestId("departure-strike")).toHaveTextContent(
      `$${formatPairPrice(1.0845, "EUR/USD")}`,
    );
    expect(within(readout()).getByText(/OPEN/)).toBeInTheDocument();
    expect(call()).toHaveTextContent(/@/);
    expect(put()).toHaveTextContent(/@/);
  });

  it("shows a PENDING window readout before it opens", () => {
    const now = Date.now();
    arm({
      predictionData: {
        ...ARMED,
        tier: "T1",
        horizon: {
          departure: departure({
            status: "PENDING",
            entry_window_start_ms: now + 30_000,
            entry_window_end_ms: now + 90_000,
          }),
        },
      },
    });
    ui(<TradingPanel stalePrice={false} />);
    expect(readout()).toHaveAttribute("data-status", "PENDING");
    expect(within(readout()).getByText(/ENTRY IN/)).toBeInTheDocument();
  });

  it("flags a MISSED_ENTRY window", () => {
    arm({
      currentPrice: 1.2,
      predictionData: {
        ...ARMED,
        tier: "T1",
        horizon: { departure: departure() },
      },
    });
    ui(<TradingPanel stalePrice={false} />);
    expect(readout()).toHaveAttribute("data-status", "MISSED_ENTRY");
    expect(within(readout()).getByText(/SLIPPAGE EXCEEDED/)).toBeInTheDocument();
  });

  it("WAITS with no fabricated level when the engine withheld the contract", () => {
    arm({
      predictionData: {
        ...ARMED,
        tier: "T1",
        horizon: {
          departure: departure({
            available: false,
            status: "WAITING_FOR_VALID_ENTRY_LEVEL",
            strike_price: null,
            target_price: null,
            max_allowed_slippage: null,
            slippage: null,
          }),
        },
      },
    });
    ui(<TradingPanel stalePrice={false} />);
    expect(readout()).toHaveAttribute(
      "data-status",
      "WAITING_FOR_VALID_ENTRY_LEVEL",
    );
    expect(screen.getByTestId("departure-strike")).toHaveTextContent("—");
    expect(call()).not.toHaveTextContent(/@/);
  });

  it("WAITS when the horizon carries no departure at all", () => {
    arm({ predictionData: { ...ARMED, tier: "T1" } });
    ui(<TradingPanel stalePrice={false} />);
    expect(readout()).toHaveAttribute(
      "data-status",
      "WAITING_FOR_VALID_ENTRY_LEVEL",
    );
    expect(screen.getByTestId("departure-strike")).toHaveTextContent("—");
  });

  it("is DISPLAY ONLY — a departure never unlocks execution below the gate", () => {
    arm({
      predictionData: {
        ...ARMED,
        confidence: 0.9,
        tier: "T2",
        horizon: { departure: departure() },
      },
    });
    ui(<TradingPanel stalePrice={false} />);
    // Departure present + ACTIVE...
    expect(readout()).toHaveAttribute("data-status", "ACTIVE");
    // ...but the 96.5% gate still locks both buttons.
    expect(call()).toBeDisabled();
    expect(put()).toBeDisabled();
  });
});
