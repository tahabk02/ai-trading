/**
 * signal-widget.po-offline.dom.test.tsx — PART 43.4 [469].
 *
 * A rail card for an OTC pair priced by a NON-PO feed (PO OFFLINE / market
 * proxy) must NOT present a tradeable "Execution Price": it shows "--" and
 * names the state, mirroring the asset card.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { SignalWidget } from "@/components/trading/signal-widget";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { resetAll, ui } from "@/test/harness";
import type { MarketQuote } from "@/services/api";

const quoteFor = (
  symbol: string,
  over: Partial<MarketQuote> = {},
): MarketQuote =>
  ({
    symbol,
    name: symbol,
    type: "currency_pair",
    assetSubType: "otc",
    label: symbol,
    digits: 5,
    payout: 90,
    price: 1.08512,
    bid: 1.08511,
    ask: 1.08513,
    spread: 2,
    tickCount: 10,
    lastTickAt: new Date(Date.now() - 1_000).toISOString(),
    ageMs: 1_000,
    freshAgeMs: 1_000,
    source: "pocket_option",
    stale: false,
    staleLive: false,
    ...over,
  }) as MarketQuote;

function seedQuotes(...quotes: MarketQuote[]) {
  useMarketTerminalStore.setState({
    quotes: Object.fromEntries(quotes.map((q) => [q.symbol, q])),
  } as never);
}

const widget = (symbol: string, signal: Record<string, unknown> = {}) => (
  <SignalWidget
    signal={{ symbol, signalType: "SELL", confidence: 98, tier: "T1", ...signal } as never}
  />
);

const priceText = () =>
  (screen.getByText(/execution price/i).parentElement?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();

describe("[469] rail — OTC priced by a market proxy shows no execution price", () => {
  beforeEach(() => resetAll());

  it("shows '--' and a PO OFFLINE marker for a non-PO OTC quote", () => {
    seedQuotes(quoteFor("EUR/USD", { source: "frankfurter:live" }));
    ui(widget("EUR/USD", { price: null }));

    expect(priceText()).toContain("--");
    expect(priceText()).not.toContain("1.08");
    expect(screen.getByTestId("rail-po-offline-marker").textContent).toContain(
      "PO OFFLINE",
    );
  });

  it("shows the real price for a genuine PO OTC quote", () => {
    seedQuotes(quoteFor("EUR/USD", { source: "pocket_option" }));
    ui(widget("EUR/USD", { price: null }));

    expect(priceText()).not.toContain("--");
    expect(screen.queryByTestId("rail-po-offline-marker")).toBeNull();
  });
});
