/**
 * ConfidenceFilter — LOCAL DRAFT + TRAILING DEBOUNCE.
 *
 * The slider spans 50.0 -> 99.0 at step 0.5, i.e. 99 discrete positions. The
 * original implementation committed on every `onChange`, so ONE full-width
 * drag produced ~98 synchronous store writes and ~98 grid re-filters, each
 * notifying all 44 quote cards. On the main thread that is a visible stutter
 * during the one interaction the operator does most often.
 *
 * The contract this file locks down:
 *
 *   1. ZERO-LATENCY FEEDBACK. The thumb and the numeric readout must follow
 *      every input event immediately. Deferring the *visual* as well as the
 *      commit would just move the stutter, not remove it.
 *   2. ONE WRITE PER GESTURE. Dragging across the whole range must call
 *      `onCommit` exactly once, not once per step.
 *   3. RELEASE COMMITS. pointerup / pointercancel / keyup / blur all commit.
 *   4. TRAILING DEBOUNCE IS A SAFETY NET. For input methods that never fire a
 *      release (assistive tech, synthetic events) a 250ms idle timer commits
 *      the pending draft. Only the trailing edge fires: continuous input keeps
 *      resetting it, so it does NOT commit mid-drag.
 *   5. NO WRITE STORM ON UNMOUNT. The timer is cleared on unmount so a
 *      detached component cannot call back into the store.
 *   6. NO-OP COMMITS ARE SKIPPED. Releasing without moving must not write.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfidenceFilter } from "@/components/terminal/confidence-filter";
import { MIN_CONFIDENCE_DEFAULT_PCT } from "@/lib/minConfidenceFilter";

function setup() {
  const onCommit = vi.fn();
  const onToggleHide = vi.fn();
  render(
    <ConfidenceFilter
      value={MIN_CONFIDENCE_DEFAULT_PCT}
      hideBelow={false}
      onCommit={onCommit}
      onToggleHide={onToggleHide}
    />,
  );
  return {
    onCommit,
    onToggleHide,
    slider: screen.getByLabelText("Minimum executable confidence") as HTMLInputElement,
  };
}

/** Drives the slider through a full-width drag: many change events, one release. */
function drag(slider: HTMLInputElement, to: number, steps = 98) {
  const from = Number(slider.value);
  for (let i = 1; i <= steps; i++) {
    const next = from + ((to - from) * i) / steps;
    fireEvent.change(slider, { target: { value: next.toFixed(2) } });
  }
}

describe("ConfidenceFilter local draft + trailing debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the readout responsive on every input event (zero-latency feedback)", () => {
    const { slider } = setup();
    const readout = () => screen.getByText(/%$/).textContent;

    fireEvent.change(slider, { target: { value: "72.5" } });
    expect(readout()).toBe("72.5%");

    fireEvent.change(slider, { target: { value: "88.0" } });
    expect(readout()).toBe("88.0%");
  });

  it("commits NOTHING until the gesture is released", () => {
    const { onCommit, slider } = setup();
    drag(slider, 99);

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a full-width drag produces exactly ONE commit, not ~98", () => {
    const { onCommit, slider } = setup();
    drag(slider, 99);
    fireEvent.pointerUp(slider);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(99);
  });

  it("pointercancel commits too, so an aborted drag is not lost", () => {
    const { onCommit, slider } = setup();
    drag(slider, 80);
    fireEvent.pointerCancel(slider);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(80);
  });

  it("keyboard release commits", () => {
    const { onCommit, slider } = setup();
    fireEvent.change(slider, { target: { value: "65.0" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(65);
  });

  it("blur commits a draft that no release event ever published", () => {
    const { onCommit, slider } = setup();
    fireEvent.change(slider, { target: { value: "91.0" } });
    fireEvent.blur(slider);

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("the trailing debounce is a safety net: it does NOT fire mid-drag", () => {
    const { onCommit, slider } = setup();
    // Continuous input, each step within the 250ms window.
    for (let i = 0; i < 20; i++) {
      fireEvent.change(slider, { target: { value: String(60 + i) } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("the trailing debounce DOES publish when input goes idle with no release", () => {
    const { onCommit, slider } = setup();
    fireEvent.change(slider, { target: { value: "77.5" } });

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(77.5);
  });

  it("commits at most once even if release and the timer both become due", () => {
    const { onCommit, slider } = setup();
    fireEvent.change(slider, { target: { value: "70.0" } });

    fireEvent.pointerUp(slider);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("releasing without moving does not write to the store", () => {
    const { onCommit, slider } = setup();
    fireEvent.pointerUp(slider);
    fireEvent.keyUp(slider, { key: "Tab" });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("unmounting mid-gesture does not call back into the store", () => {
    const { onCommit, slider } = setup();
    drag(slider, 95);

    cleanup(); // unmount with the trailing timer still pending
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("the Hide toggle still works and is independent of the slider", () => {
    const { onToggleHide, onCommit } = setup();
    fireEvent.click(screen.getByRole("button"));

    expect(onToggleHide).toHaveBeenCalledWith(true);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
