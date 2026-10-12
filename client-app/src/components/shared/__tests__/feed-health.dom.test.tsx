import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { useState } from "react";
import { FeedHealthBar } from "@/components/shared/feed-health";
import { classifyFreshness, formatAge } from "@/hooks/useFeedHealth";

/**
 * The contract under test: a 200 Hz tick stream must not become 200 renders/sec.
 * We assert on RENDER COUNT, not on rendered text, because a text assertion
 * would still pass if the component re-rendered 200 times with identical output.
 */

describe("feed health classification (pure)", () => {
  it("buckets age into live / delayed / stale / dead", () => {
    expect(classifyFreshness(0)).toBe("live");
    expect(classifyFreshness(999)).toBe("live");
    expect(classifyFreshness(1_000)).toBe("delayed");
    expect(classifyFreshness(1_999)).toBe("delayed");
    expect(classifyFreshness(2_000)).toBe("stale");
    expect(classifyFreshness(9_999)).toBe("stale");
    expect(classifyFreshness(10_000)).toBe("dead");
    expect(classifyFreshness(999_999)).toBe("dead");
  });

  it("formats ages at a stable display granularity", () => {
    expect(formatAge(0)).toBe("0ms");
    expect(formatAge(340)).toBe("340ms");
    expect(formatAge(999)).toBe("999ms");
    expect(formatAge(1_400)).toBe("1.4s");
    expect(formatAge(59_900)).toBe("59.9s");
    expect(formatAge(60_000)).toBe("1m");
    expect(formatAge(-1)).toBe("--");
    expect(formatAge(Number.NaN)).toBe("--");
  });
});

describe("feed health bar", () => {
  let renders = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    renders = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  /** Counts renders of the leaf component only — the budget we care about. */
  function Counted(props: React.ComponentProps<typeof FeedHealthBar>) {
    renders += 1;
    return <FeedHealthBar {...props} />;
  }

  it("does NOT re-read the feed clock per render — the render-storm guard", () => {
    // `reads` counts consultations of the age source. This is the assertion
    // with teeth.
    //
    // The scenario: something above the bar churns 200 times (a parent state
    // update, a store selector elsewhere, a symbol switch). The bar re-renders
    // with it — unavoidable. What must NOT happen is the bar re-CONSULTING the
    // feed clock each time: a render-phase read makes cost scale with churn
    // (200 reads), while an interval sampler makes cost scale with ELAPSED TIME
    // (~1 read). Asserting on rendered text cannot tell these apart, because a
    // storm can re-render byte-identical output.
    let reads = 0;
    const getLastUpdateMs = () => {
      reads += 1;
      return 1_000;
    };
    const now = () => 1_000;

    let churn = () => {};
    function ChurningParent() {
      const [, setN] = useState(0);
      churn = () => setN((n) => n + 1);
      return (
        <Counted
          connected
          stale={false}
          stalled={false}
          getLastUpdateMs={getLastUpdateMs}
          now={now}
        />
      );
    }

    render(<ChurningParent />);
    const baseReads = reads;

    // 200 upstream re-renders, all inside a single sampling window.
    for (let i = 0; i < 200; i += 1) {
      act(() => {
        churn();
      });
    }
    // Then one full sampling window elapses.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    // A render-phase read would show ~200 here. The sampler must show ~1.
    expect(reads - baseReads).toBeLessThanOrEqual(2);
  });

  it("caps sampling at one read per second regardless of elapsed time", () => {
    let reads = 0;
    const getLastUpdateMs = () => {
      reads += 1;
      return 1_000;
    };
    let clock = 1_000;
    const now = () => clock;

    render(
      <Counted
        connected
        stale={false}
        stalled={false}
        getLastUpdateMs={getLastUpdateMs}
        now={() => clock}
      />,
    );
    const baseReads = reads;

    // 5 simulated seconds, idle the whole time.
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }

    // 5 seconds => ~5 samples, not 5000 and not 1.
    expect(reads - baseReads).toBeLessThanOrEqual(6);
  });

  it("renders at most once per sampling window when age advances", () => {
    let clock = 10_000;
    const getLastUpdateMs = () => 1_000; // packet is 9s old and ageing
    const now = () => clock;

    render(
      <Counted
        connected
        stale={false}
        stalled={false}
        getLastUpdateMs={getLastUpdateMs}
        now={now}
      />,
    );
    const baseline = renders;

    // 10 sampling windows, each advancing the clock by 1s.
    for (let i = 0; i < 10; i += 1) {
      clock += 1_000;
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }

    // Ceiling is 1 render per second. Not 10 ticks worth, not 10 renders per tick.
    expect(renders - baseline).toBeLessThanOrEqual(10);
  });

  it("surfaces the sampled age and the LIVE label", () => {
    const now = () => 5_000;
    render(
      <Counted
        connected
        stale={false}
        stalled={false}
        getLastUpdateMs={() => 4_600}
        now={now}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("feed-health-age")).toHaveTextContent("400ms");
    expect(screen.getByTestId("feed-health-label")).toHaveTextContent("LIVE");
  });

  it("a dead socket outranks the age readout", () => {
    const now = () => 1_000;
    render(
      <Counted
        connected={false}
        stale={false}
        stalled={false}
        getLastUpdateMs={() => 990}
        now={now}
      />,
    );
    expect(screen.getByTestId("feed-health-label")).toHaveTextContent("FEED DOWN");
    expect(screen.getByTestId("feed-health-age")).toHaveTextContent("no socket");
  });

  it("flags a stale price and a stalled stream", () => {
    const now = () => 7_000;
    const staleRender = render(
      <Counted
        connected
        stale
        stalled={false}
        getLastUpdateMs={() => 1_000}
        now={now}
      />,
    );
    expect(screen.getByTestId("feed-health-label")).toHaveTextContent(
      "PRICE STALE",
    );
    cleanup();

    render(
      <Counted
        connected
        stale={false}
        stalled
        getLastUpdateMs={() => 1_000}
        now={now}
      />,
    );
    expect(screen.getByTestId("feed-health-label")).toHaveTextContent(
      "STREAM STALLED",
    );
    expect(screen.getByTestId("feed-health-stalled")).toBeInTheDocument();
    staleRender.unmount();
  });

  it("[422] a closed real market reads MARKET CLOSED, outranking PRICE STALE", () => {
    const now = () => 7_000;
    render(
      <Counted
        connected
        stale
        stalled
        marketClosed
        getLastUpdateMs={() => 1_000}
        now={now}
      />,
    );
    expect(screen.getByTestId("feed-health-label")).toHaveTextContent(
      "MARKET CLOSED",
    );
    expect(screen.getByTestId("feed-health-label")).not.toHaveTextContent(
      "PRICE STALE",
    );
    expect(screen.getByTestId("feed-health-age")).toHaveTextContent(
      "weekly close",
    );
  });
});
