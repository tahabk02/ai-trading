/**
 * pro-control-bar.dom.test.tsx — the Pro Terminal command surface.
 *
 * The Phase 1 contract, pinned at the DOM boundary:
 *   1. EVERY control renders and has a tooltip — ZERO dead-clicks.
 *   2. Tier / expiry / lead-offset writes flow THROUGH the source stores
 *      (useMarketTerminalStore / useTradingStore), never a forked copy.
 *   3. NO control is ever hard-disabled by gate state (the documented
 *      anti-deadlock invariant) — tiers report state, they do not lock out.
 *   4. AUTO persists to localStorage and notifies the backend (best-effort).
 *   5. RESET FLOOR restores the platform baseline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen, within, act, cleanup } from "@testing-library/react";
import React from "react";
import { ProControlBar } from "@/components/pro/pro-control-bar";
import { useTerminalStore } from "@/store/useTerminalStore";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { useTradingStore } from "@/store/useTradingStore";
import { resetAll, ui } from "@/test/harness";
import { socketState } from "@/test/mocks/socket";
import { DEFAULT_EXECUTION_TIER, executionFloorPct } from "@/lib/signalTiers";

vi.mock("@/hooks/useSocket", async () => {
  const m = await import("@/test/mocks/socket");
  return {
    useSocket: () => ({
      socket: m.socketState.socket,
      connected: m.socketState.connected,
      status: "connected",
      reconnectAttempt: 0,
      lastError: null,
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

const pristineTerminal = useTerminalStore.getState();

beforeEach(() => {
  resetAll();
  useTerminalStore.setState(pristineTerminal, true);
});

afterEach(cleanup);

function renderBar() {
  return ui(<ProControlBar symbol="EUR/USD" timeframe="1m" />);
}

const TIERS = ["T1", "T2", "T3", "T4", "T5"];
const MODES = [
  "pro-mode-load",
  "pro-mode-auto",
  "pro-mode-lead-20S",
  "pro-mode-lead-1M",
  "pro-mode-reset-floor",
];
const EXPIRY_LABELS = ["1s", "5s", "10s", "15s", "30s", "1m", "2m", "3m", "5m"];

describe("ProControlBar — render + tooltip contract", () => {
  it("renders every control", () => {
    renderBar();
    for (const t of TIERS) expect(screen.getByTestId(`pro-tier-${t}`)).toBeTruthy();
    for (const id of MODES) expect(screen.getByTestId(id)).toBeTruthy();
    for (const l of EXPIRY_LABELS) {
      expect(screen.getByTestId(`pro-expiry-pill-${l}`)).toBeTruthy();
    }
  });

  it("gives EVERY button a non-empty tooltip (no dead-clicks, no mystery)", () => {
    renderBar();
    const buttons = within(screen.getByTestId("pro-control-bar")).getAllByRole(
      "button",
    );
    expect(buttons.length).toBe(TIERS.length + MODES.length + EXPIRY_LABELS.length);
    for (const b of buttons) {
      expect(b.getAttribute("title")?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("ProControlBar — write-through to the source stores", () => {
  it("clicking a tier writes through and re-derives the confidence floor", () => {
    renderBar();
    fireEvent.click(screen.getByTestId("pro-tier-T4"));
    expect(useTerminalStore.getState().activeTier).toBe("T4");
    expect(useMarketTerminalStore.getState().minTier).toBe("T4");
    expect(useTerminalStore.getState().confidenceFloor).toBeCloseTo(70, 5);
  });

  it("never hard-disables a tier even when the live verdict is weaker (anti-deadlock)", () => {
    act(() => {
      useTradingStore.setState({
        predictionData: { tier: "T5", signal: null, confidence: 0 },
      } as never);
    });
    renderBar();
    for (const t of TIERS) {
      expect(
        (screen.getByTestId(`pro-tier-${t}`) as HTMLButtonElement).disabled,
      ).toBe(false);
    }
  });

  it("an expiry pill sets the projection expiration on the trading store", () => {
    renderBar();
    fireEvent.click(screen.getByTestId("pro-expiry-pill-2m"));
    expect(useTradingStore.getState().selectedExpirationSeconds).toBe(120);
    expect(useTerminalStore.getState().activeExpirySeconds).toBe(120);
  });

  it("20S / 1M set the predictive lead offset on the trading store", () => {
    renderBar();
    fireEvent.click(screen.getByTestId("pro-mode-lead-20S"));
    expect(useTerminalStore.getState().leadOffsetMs).toBe(20_000);
    expect(useTradingStore.getState().selectedLeadOffsetMs).toBe(20_000);
  });

  it("AUTO toggles, persists to localStorage and notifies the backend", () => {
    renderBar();
    fireEvent.click(screen.getByTestId("pro-mode-auto"));
    expect(useTerminalStore.getState().isAutoExecutionActive).toBe(true);
    expect(localStorage.getItem("alpha5.pro.autoExecution")).toBe("true");
    expect(socketState.socket.emit).toHaveBeenCalledWith(
      "toggle_auto_exec",
      expect.objectContaining({ active: true }),
    );
  });

  it("RESET FLOOR restores the default tier and clears the lead offset", () => {
    act(() => {
      useTerminalStore.getState().setActiveTier("T4");
      useTerminalStore.getState().setLeadOffset(60_000);
    });
    renderBar();
    fireEvent.click(screen.getByTestId("pro-mode-reset-floor"));
    expect(useMarketTerminalStore.getState().minTier).toBe(DEFAULT_EXECUTION_TIER);
    expect(useTerminalStore.getState().confidenceFloor).toBeCloseTo(
      executionFloorPct(DEFAULT_EXECUTION_TIER),
      5,
    );
    expect(useTerminalStore.getState().leadOffsetMs).toBeNull();
  });
});
