/**
 * pro-expiry-bar.dom.test.tsx — Phase 2: the Pro expiry countdown + action gate
 * run on the SHARED server-corrected clock, never the raw browser clock.
 *
 * The countdown itself is RELATIVE (anchor cancels the offset), so the offset's
 * observable effect is on the ABSOLUTE-time action window (`too_late`): moving
 * the server clock across the bucket boundary must flip the gate. That is what
 * the first test pins — the browser clock is held fixed while only the shared
 * `serverTimeOffsetMs` advances.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { ProExpiryBar } from "@/components/pro/pro-expiry-bar";
import { useTerminalStore } from "@/store/useTerminalStore";
import { resetAll, ui } from "@/test/harness";

const pristineTerminal = useTerminalStore.getState();

function renderBar() {
  return ui(
    <ProExpiryBar
      symbol="EUR/USD"
      currentPrice={1.0845}
      anchorPrice={1.084}
      targetPrice={1.0865}
      signal="BUY"
      live
      tier="T1"
      regimeGate="tradable"
    />,
  );
}

beforeEach(() => {
  resetAll();
  useTerminalStore.setState(pristineTerminal, true);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ProExpiryBar — server-clock corrected countdown (Phase 2)", () => {
  it("renders a live mm:ss countdown that ticks down", () => {
    vi.setSystemTime(1_000_000);
    renderBar();
    // Default selection is 300s (5m): the first armed frame shows the full window.
    expect(screen.getByTestId("pro-expiry-countdown").textContent).toBe("05:00");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("pro-expiry-countdown").textContent).toBe("04:59");
  });

  it("moves the action-window gate with the SHARED server offset (browser clock frozen)", () => {
    // 5s grid (default S5). 298_000 sits 2_000ms before the next 5s boundary —
    // still outside the 1_500ms action window, so 5m is NOT too-late yet.
    vi.setSystemTime(298_000);
    renderBar();
    expect(
      screen.getByTestId("pro-expiry-5m").getAttribute("data-too-late"),
    ).toBe("false");

    // Advance the SERVER clock 1_000ms via the shared offset ONLY. The browser
    // clock is untouched; now only 1_000ms remain before the boundary → the gate
    // must flip. This is impossible if the bar read raw Date.now().
    act(() => {
      useTerminalStore.getState().setServerTimeOffsetMs(1_000);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(
      screen.getByTestId("pro-expiry-5m").getAttribute("data-too-late"),
    ).toBe("true");
  });
});
