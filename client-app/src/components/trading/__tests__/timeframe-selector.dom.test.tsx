/**
 * timeframe-selector.dom.test.tsx — PART 39 [374]/[376].
 *
 * The chart's control row had NO timeframe selector at all: the only buttons
 * there were the LEAD offsets (AUTO / 20S / 1M — a PROJECTION horizon, not a
 * bucket width). This pins the new strip:
 *
 *   • it renders the WHOLE grid, derived from SUPPORTED_TIMEFRAMES — never a
 *     second hand-written list that can drift (the settings page and the AI
 *     panel had already grown their own copies);
 *   • an option is never disabled, so a trader can always leave a grid that is
 *     still building history;
 *   • clicking writes `setSelectedTimeframe`, i.e. ONE code path that persists,
 *     re-buckets the aggregator and drops the stale prediction — the switch
 *     regression the old row could not even express.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { TimeframeSelector } from "@/components/trading/timeframe-selector";
import { SUPPORTED_TIMEFRAMES } from "@/lib/realtimeCandleAggregator";
import { useTradingStore } from "@/store/useTradingStore";
import { resetAll } from "@/test/harness";

/** Mirrors how financial-chart wires the strip to the store. */
const WiredSelector = () => {
  const value = useTradingStore((s) => s.selectedTimeframe);
  const setSelectedTimeframe = useTradingStore((s) => s.setSelectedTimeframe);
  return <TimeframeSelector value={value} onChange={setSelectedTimeframe} />;
};

describe("[374] chart timeframe selector", () => {
  beforeEach(() => resetAll());

  it("renders every frame on the grid, including W1 and MN1, and never S1", () => {
    const onChange = vi.fn();
    render(<TimeframeSelector value="M1" onChange={onChange} />);

    const group = screen.getByTestId("tf-selector");
    const buttons = group.querySelectorAll("button");
    expect(buttons).toHaveLength(SUPPORTED_TIMEFRAMES.length);
    for (const tf of SUPPORTED_TIMEFRAMES) {
      expect(screen.getByTestId(`tf-option-${tf}`)).toBeTruthy();
    }
    expect(screen.getByTestId("tf-option-W1")).toBeTruthy();
    expect(screen.getByTestId("tf-option-MN1")).toBeTruthy();
    expect(screen.queryByTestId("tf-option-S1")).toBeNull();
  });

  it("marks exactly the active frame and stays usable (no disabled option)", () => {
    render(<TimeframeSelector value="H1" onChange={vi.fn()} />);
    expect(
      screen.getByTestId("tf-option-H1").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("tf-option-M1").getAttribute("aria-pressed"),
    ).toBe("false");
    for (const tf of SUPPORTED_TIMEFRAMES) {
      expect(
        (screen.getByTestId(`tf-option-${tf}`) as HTMLButtonElement).disabled,
      ).toBe(false);
    }
  });

  it("reports the clicked frame", () => {
    const onChange = vi.fn();
    render(<TimeframeSelector value="M1" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("tf-option-MN1"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("MN1");
  });
});

describe("[376] timeframe-switch regression", () => {
  beforeEach(() => resetAll());

  it("a click only asks for the switch — the active pill flips with the store", () => {
    render(<WiredSelector />);
    // store default is S5 (see the store's initial state)
    expect(
      screen.getByTestId("tf-option-S5").getAttribute("aria-pressed"),
    ).toBe("true");

    act(() => {
      fireEvent.click(screen.getByTestId("tf-option-H1"));
    });

    expect(useTradingStore.getState().selectedTimeframe).toBe("H1");
    expect(useTradingStore.getState().selectedTimeframeSeconds).toBe(3600);
    expect(
      screen.getByTestId("tf-option-H1").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("tf-option-S5").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("the switch drops the previous resolution's prediction instead of reusing it", () => {
    // A prediction resolved for M1 must not survive into M5 — the chart would
    // anchor its target layer to a bar that does not exist on the new grid.
    useTradingStore.setState({
      predictionData: { symbol: "EUR/USD" } as never,
    });
    render(<WiredSelector />);

    act(() => {
      fireEvent.click(screen.getByTestId("tf-option-M5"));
    });

    expect(useTradingStore.getState().selectedTimeframe).toBe("M5");
    expect(useTradingStore.getState().predictionData).toBeNull();
  });

  it("persists the new frame so a reload restores it", () => {
    render(<WiredSelector />);
    act(() => {
      fireEvent.click(screen.getByTestId("tf-option-W1"));
    });
    const persisted = Object.values(localStorage).join(" ");
    expect(persisted).toContain("W1");
  });

  it("ignores an off-grid string rather than blanking the chart", () => {
    render(<WiredSelector />);
    act(() => {
      useTradingStore.getState().setSelectedTimeframe("S1");
    });
    expect(useTradingStore.getState().selectedTimeframe).toBe("S5");
  });
});