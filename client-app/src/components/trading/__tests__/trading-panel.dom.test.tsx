import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import { TradingPanel } from "@/components/trading/trading-panel";
import { useTradingStore } from "@/store/useTradingStore";
import { resetAll, ui } from "@/test/harness";
import { setSocketConnected } from "@/test/mocks/socket";

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

/** A live tape carrying a gated directional verdict (>= 96.5% per buildSignalView). */
const ARMED = { signal: "BUY", confidence: 0.97 };

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
      predictionData: { ...ARMED, tier: "T1" },
      ...overrides,
    } as never);
  });
}

const expiryOptions = () =>
  within(screen.getByTestId("expiry-options")).getAllByRole("button");
/** Identity of the option SET, so "gating removed a choice" is detectable. */
const optionIds = () => expiryOptions().map((el) => el.getAttribute("data-testid"));
const call = () => screen.getByTestId("action-call");
const put = () => screen.getByTestId("action-put");
/** Boolean disabled state, typed safely (getByTestId returns HTMLElement). */
const disabled = (testid: string) => screen.getByTestId(testid).hasAttribute("disabled");

describe("trading panel — execution invariants (DOM level)", () => {
  beforeEach(() => {
    resetAll();
    setSocketConnected(true);
  });

  // ── CONTRACT: selection is an INPUT, never gated by market state ──────────
  describe("expiry selection is never gated", () => {
    it("every option is present and enabled in a healthy state", () => {
      arm();
      ui(<TradingPanel stalePrice={false} />);
      // 17 = the full PO canonical ladder in TradingPanel's TIMER_OPTIONS
      // (1s…30s, 1m…30m, 1h, 4h, 12h, 1d). Asserted as a regression tripwire on
      // accidental removal; the real invariant is asserted as set-identity below.
      const opts = expiryOptions();
      expect(opts).toHaveLength(17);
      for (const el of opts) expect(el).not.toBeDisabled();
    });

    it("gating removes NO option in any adverse regime/tier state", () => {
      arm();
      ui(<TradingPanel stalePrice={false} />);
      const baseline = optionIds();

      const adverse = [
        { tier: "T5" },
        { tier: "T4", suppressed_reason: "regime_scored_only" },
        { tier: "T1", suppressed_reason: "pending_high_precision" },
        { tier: "T1", suppressed_reason: "too_late" },
        { tier: "T2", suppressed_reason: "high_vol" },
      ];
      for (const a of adverse) {
        cleanup();
        arm({ predictionData: { ...ARMED, ...a } });
        ui(<TradingPanel stalePrice={false} />);
        // The set must be byte-identical: not smaller, not reordered, not pruned.
        expect(optionIds(), JSON.stringify(a)).toEqual(baseline);
        for (const el of expiryOptions()) expect(el).not.toBeDisabled();
      }
    });
  });

  // ── CONTRACT: selection and enforcement are NOT fused ─────────────────────
  it("changing the selected expiry does NOT gate the execution buttons", () => {
    // The original deadlock: a sub-executable tier or too_late landing disabled
    // EVERY option, so the operator could not switch to an expiry that would
    // clear the bar. Enforcement must live at the action boundary only.
    arm({
      predictionData: { ...ARMED, tier: "T1", suppressed_reason: "too_late" },
    });
    ui(<TradingPanel stalePrice={false} />);

    // Seed the panel into the exact state that used to deadlock: an
    // enforcement adverse flag (too_late) is live while the signal is gated.
    const baseline = {
      call: disabled("action-call"),
      put: disabled("action-put"),
    };
    expect(baseline).toEqual({ call: false, put: false });

    // Selecting a different expiry must be a pure input change.
    act(() => useTradingStore.getState().setSelectedExpirationSeconds(60));
    expect(disabled("action-call")).toBe(baseline.call);
    expect(disabled("action-put")).toBe(baseline.put);

    act(() => useTradingStore.getState().setSelectedExpirationSeconds(600));
    expect(disabled("action-call")).toBe(baseline.call);
    expect(disabled("action-put")).toBe(baseline.put);

    // The inverse direction too: an adverse flag may BLOCK a dispatch, but it
    // must never remove the operator's ability to change the selection.
    act(() =>
      useTradingStore.setState({
        predictionData: { ...ARMED, tier: "T5", suppressed_reason: "regime_scored_only" },
      } as never),
    );
    expect(call()).toBeEnabled();
    expect(put()).toBeEnabled();
    act(() => useTradingStore.getState().setSelectedExpirationSeconds(120));
    for (const el of expiryOptions()) expect(el).not.toBeDisabled();
  });

  // ── CONTRACT: execution guards are retained ──────────────────────────────
  describe("CALL/PUT keep their execution guards", () => {
    it("are enabled on a healthy tape with a gated verdict", () => {
      arm();
      ui(<TradingPanel stalePrice={false} />);
      expect(call()).toBeEnabled();
      expect(put()).toBeEnabled();
    });

    it("block on a stale tape — the regression the required prop prevents", () => {
      arm();
      ui(<TradingPanel stalePrice />);
      expect(call()).toBeDisabled();
      expect(put()).toBeDisabled();
    });

    it("block while a dispatch is in flight (transaction lock)", () => {
      arm();
      ui(<TradingPanel stalePrice={false} />);
      act(() => useTradingStore.setState({ isTradeActive: true } as never));
      expect(call()).toBeDisabled();
      expect(put()).toBeDisabled();
    });

    it("block on the kill switch, and name the reason", () => {
      arm();
      ui(<TradingPanel stalePrice={false} />);
      act(() =>
        useTradingStore.setState({
          isKillSwitchLocked: true,
          killSwitchReason: "drawdown_limit",
        } as never),
      );
      expect(call()).toBeDisabled();
      expect(put()).toBeDisabled();
      expect(screen.getByText("drawdown_limit")).toBeInTheDocument();
    });

    it("block when no directional verdict has cleared the 96.5% gate", () => {
      arm({ predictionData: { signal: "BUY", confidence: 0.9, tier: "T2" } });
      ui(<TradingPanel stalePrice={false} />);
      expect(call()).toBeDisabled();
      expect(put()).toBeDisabled();
      // ...and the selector stays free, so the operator can still switch.
      for (const el of expiryOptions()) expect(el).not.toBeDisabled();
    });

    it("block when the socket is down", () => {
      arm();
      setSocketConnected(false);
      ui(<TradingPanel stalePrice={false} />);
      expect(call()).toBeDisabled();
      expect(put()).toBeDisabled();
    });
  });

  // ── THE PRO-PAGE CONTRACT ─────────────────────────────────────────────────
  it("the Pro page mount passes stalePrice through", async () => {
    // Guards the wiring, not the component: if pro/page.tsx ever drops the prop
    // the required-prop type makes it a compile error, and this documents it.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/(dashboard)/dashboard/pro/page.tsx", "utf8"),
    );
    expect(src).toContain("<TradingPanel stalePrice={stalePrice} />");
  });
});
