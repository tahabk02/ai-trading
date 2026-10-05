import { describe, it, expect, beforeEach } from "vitest";
import { act, screen } from "@testing-library/react";
import { SignalWidget } from "@/components/trading/signal-widget";
import { useTradingStore } from "@/store/useTradingStore";
import { resetAll, ui } from "@/test/harness";

/**
 * PART 35.3 [360] — depth provenance must be attributed to the RIGHT score.
 *
 * The Market Watch rail renders ONE SignalWidget per live signal, i.e. many
 * widgets for many instruments, all from a single `predictionData` slot that
 * only ever describes the ACTIVE symbol. Without a symbol gate every widget
 * inherits that one symbol's order-book evidence and stamps it onto other
 * instruments' confluence scores — a fabricated provenance claim. These tests
 * pin the gate shut.
 */

const UNVERIFIED = {
  confluence_score: 76.5,
  note: "",
  confluence: { order_book_verified: false, verified_lift: 0 },
};
const VERIFIED = {
  confluence_score: 76.5,
  note: "",
  confluence: { order_book_verified: true, verified_lift: 1.4 },
};

function predict(symbol: string, book_confluence: unknown) {
  act(() => {
    useTradingStore.setState({
      currentPrice: 1.1452,
      predictionData: { symbol, book_confluence },
    } as never);
  });
}

const widget = (symbol: string) => (
  <SignalWidget
    signal={
      { symbol, signalType: "SELL", confidence: 76.5, tier: "T4" } as never
    }
  />
);

const caveats = () => screen.queryAllByTestId("book-depth-unverified").length;
const confirmations = () => screen.queryAllByTestId("book-depth-verified").length;

describe("signal widget — order-book depth provenance (PART 35.3 [360])", () => {
  beforeEach(() => {
    resetAll();
  });

  it("marks the predicted symbol's own score as having no depth evidence", () => {
    predict("EUR/USD", UNVERIFIED);
    ui(widget("EUR/USD"));
    expect(caveats()).toBe(1);
    expect(confirmations()).toBe(0);
  });

  it("claims depth evidence for exactly ONE widget when the rail shows many", () => {
    predict("EUR/USD", VERIFIED);
    ui(
      <div>
        {widget("EUR/USD")}
        {widget("GBP/USD")}
        {widget("USD/PLN")}
      </div>,
    );
    // The rail renders one widget per live signal; only the predicted symbol
    // may carry the flag. Two or more would be a provenance leak.
    expect(confirmations()).toBe(1);
  });

  it("renders nothing on a widget for a symbol that is not predicted", () => {
    predict("EUR/USD", VERIFIED);
    ui(widget("USD/PLN"));
    expect(confirmations()).toBe(0);
    expect(caveats()).toBe(0);
  });

  it("matches the symbol regardless of slash/spacing normalisation", () => {
    predict("EURUSD", UNVERIFIED);
    ui(widget("EUR/USD"));
    expect(caveats()).toBe(1);
  });

  it("renders nothing when no prediction owns a symbol yet", () => {
    predict("EUR/USD", UNVERIFIED);
    ui(<div>{widget("--")}</div>);
    expect(caveats()).toBe(0);
    expect(confirmations()).toBe(0);
  });

  it("labels the score 'Strategy Book Agreement', never a bare 'Book Agreement'", () => {
    predict("EUR/USD", UNVERIFIED);
    ui(widget("EUR/USD"));
    expect(screen.getByText(/strategy book agreement/i)).toBeTruthy();
    // A bare label is the ambiguity this part removes; "Strategy Book
    // Agreement" contains it as a substring, so match the whole string.
    expect(screen.queryAllByText(/^book agreement$/i)).toHaveLength(0);
  });
});