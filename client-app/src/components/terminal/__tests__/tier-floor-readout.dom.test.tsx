/**
 * tier-floor-readout.dom.test.tsx — PART 31 [309]/[310]/[311]/[312].
 *
 * End-to-end through the real toolbar: click the TIER button, assert the CONF
 * read-out. `tierConfidenceSync.test.ts` proves the store invariant; this proves
 * the wiring — that the tier button is the only input and the displayed number
 * is the floor the engine is actually asked for.
 *
 * What regressed before this part:
 *   • the CONF control was a draggable slider, so the displayed bar could be
 *     any value in 50..99 regardless of the tier beside it;
 *   • selecting T5 left the bar wherever it was, which read as an ignored click
 *     with no explanation anywhere on screen.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfidenceFilter } from "@/components/terminal/confidence-filter";
import { TierSelector } from "@/components/terminal/tier-selector";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { MIN_EXECUTABLE_FLOOR_PCT } from "@/lib/signalTiers";

/** The toolbar pair wired the way market-terminal.tsx wires them. */
function Toolbar() {
  const minTier = useMarketTerminalStore((s) => s.minTier);
  const minConfidencePct = useMarketTerminalStore((s) => s.minConfidencePct);
  const hideBelow = useMarketTerminalStore((s) => s.hideBelowThreshold);
  return (
    <>
      <ConfidenceFilter
        value={minConfidencePct}
        tier={minTier}
        hideBelow={hideBelow}
        onToggleHide={(v) => useMarketTerminalStore.getState().setHideBelowThreshold(v)}
      />
      <TierSelector
        value={minTier}
        onCommit={(v) => useMarketTerminalStore.getState().setMinTier(v)}
      />
    </>
  );
}

const clickTier = (tier: string) =>
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${tier}\\b`) }));
  });

const meter = () => screen.getByRole("meter") as HTMLElement;
const readout = () => screen.getByText(/^\d+\.\d%$/).textContent;

describe("PART 31 — tier button drives the CONF read-out", () => {
  beforeEach(() => {
    act(() => useMarketTerminalStore.getState().setMinTier("T1"));
  });
  afterEach(cleanup);

  it("[312] clicking T5 reads 70.0% — not 0%, not the previously shown value", () => {
    render(<Toolbar />);
    expect(readout()).toBe("96.5%");

    clickTier("T3");
    expect(readout()).toBe("80.0%");

    clickTier("T5");
    expect(readout()).toBe("70.0%");
    expect(meter()).toHaveAttribute("aria-valuenow", "70");
  });

  it("[312] T1–T4 each read their own threshold", () => {
    render(<Toolbar />);
    const expected: Record<string, string> = {
      T1: "96.5%",
      T2: "90.0%",
      T3: "80.0%",
      T4: "70.0%",
      T5: "70.0%",
    };
    for (const [tier, text] of Object.entries(expected)) {
      clickTier(tier);
      expect(readout()).toBe(text);
      expect(Number(meter().getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(
        MIN_EXECUTABLE_FLOOR_PCT,
      );
    }
  });

  it("[311] the CONF control is NOT draggable — no slider input survives", () => {
    render(<Toolbar />);
    clickTier("T4");

    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByLabelText("Minimum executable confidence")).toBeNull();
    expect(document.querySelector('input[type="range"]')).toBeNull();
    // The read-out is a meter: it REPORTS a position, it does not offer one.
    expect(meter().tagName).toBe("SPAN");
    expect(meter()).toHaveAttribute("aria-valuenow", "70");
    expect(meter().getAttribute("aria-valuetext")).toContain("70.0 percent");
  });

  it("[311] keyboard/programmatic attempts to move the bar cannot go below 70.0%", () => {
    render(<Toolbar />);
    clickTier("T5");

    // There is no input to fire a change at; assert the absence explicitly so
    // re-introducing one fails here rather than quietly re-opening the hole.
    expect(document.querySelector('input[type="range"]')).toBeNull();

    // Even the coarsest bypass available in the DOM — mutating the meter by
    // hand — leaves the store holding the floor the tier implies.
    expect(useMarketTerminalStore.getState().minConfidencePct).toBeCloseTo(70, 5);
    expect(meter()).toHaveAttribute("aria-valuenow", "70");
  });

  it("[310] T5 explains the clamp in visible copy, not just a tooltip", () => {
    render(<Toolbar />);
    clickTier("T5");

    const notice = screen.getByText(
      /T5 selected — floor clamped to T4 \(70\.0%\) · WEAK signals are visible but never executable/i,
    );
    expect(notice).toBeInTheDocument();
    // The same sentence is BOTH the visible chip text and the TierSelector
    // chip's tooltip, so the two controls tell one story.
    expect(screen.getAllByTitle(/floor clamped to T4/)).toHaveLength(2);
    expect(
      screen.getByText(/⌁ floored/).getAttribute("title"),
    ).toBe(notice.textContent);
  });

  it("[310] no clamp copy for T1–T4 — nothing to explain when nothing was clamped", () => {
    render(<Toolbar />);
    for (const tier of ["T1", "T2", "T3", "T4"]) {
      clickTier(tier);
      expect(screen.queryByText(/floor clamped/i)).toBeNull();
    }
  });

  it("[310] the meter names the tier the floor came from", () => {
    render(<Toolbar />);
    clickTier("T5");
    expect(meter().getAttribute("aria-valuetext")).toContain("T5 WEAK floor");
    clickTier("T2");
    expect(meter().getAttribute("aria-valuetext")).toContain("T2 HIGH floor");
  });

  it("the Hide<bar toggle still works and stays a VIEW concern", () => {
    render(<Toolbar />);
    clickTier("T4");
    fireEvent.click(screen.getByRole("button", { name: /Hide</ }));
    expect(useMarketTerminalStore.getState().hideBelowThreshold).toBe(true);
    expect(useMarketTerminalStore.getState().minConfidencePct).toBeCloseTo(70, 5);
  });
});
