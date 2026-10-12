import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { SignalWidget } from "@/components/trading/signal-widget";
import { useTradingStore } from "@/store/useTradingStore";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { resetAll, ui } from "@/test/harness";
import type { MarketQuote } from "@/services/api";

/**
 * PART 41 [398][399] — the rail card must price ITS OWN symbol and wear the
 * same stale marker as the panel.
 *
 * [398] Every rail card used to read `selectCurrentPrice` (the ACTIVE symbol),
 * so an active GBP/USD session printed ~1.32 on the BTC/USD card. The card
 * price now resolves from the signal payload price, then the per-symbol quote
 * map keyed by `signal.symbol` — NEVER the active symbol's price.
 *
 * [399] A verdict built from a quote older than the staleness threshold (or
 * flagged stale/held) must show "STALE Ns" and must NOT wear the PREMIUM
 * (T1-emerald) styling — the tier badge is degraded to neutral gray.
 */

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
    price: 67400.5,
    bid: 67399.5,
    ask: 67401.5,
    spread: 2,
    tickCount: 1,
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

function seedActivePrice(price: number) {
  useTradingStore.setState({ currentPrice: price } as never);
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

describe("signal widget — per-card rail price (PART 41 [398])", () => {
  beforeEach(() => {
    resetAll();
  });

  it("shows the card's OWN symbol price from the quote map, never the active symbol's", () => {
    seedQuotes(quoteFor("BTC/USD", { price: 67400.5 }));
    seedActivePrice(1.32); // active session is GBP/USD at ~1.32
    ui(widget("BTC/USD"));
    const el = screen.getByText(/67400|67[,.]?400/);
    expect(el).toBeTruthy();
    expect(priceText()).not.toContain("1.32");
  });

  it("prefers the signal payload price over the quote map when both exist", () => {
    seedQuotes(quoteFor("BTC/USD", { price: 67400.5 }));
    ui(widget("BTC/USD", { price: 19999.0 }));
    expect(screen.getByText(/19999/)).toBeTruthy();
    expect(priceText()).not.toContain("67400");
  });

  it("renders '--' when neither the payload nor the symbol's quote is known", () => {
    seedActivePrice(1.32); // must NOT leak in
    ui(widget("GBP/USD", { price: null }));
    expect(priceText()).toContain("--");
    expect(priceText()).not.toContain("1.32");
  });

  it("keys the quote by signal.symbol regardless of spacing normalisation", () => {
    seedQuotes(quoteFor("BTC/USD", { price: 67400.5 }));
    ui(widget("BTC / USD", { price: null }));
    expect(screen.getByText(/67400/)).toBeTruthy();
  });
});

describe("signal widget — stale marker + no PREMIUM on stale verdict (PART 41 [399])", () => {
  beforeEach(() => {
    resetAll();
  });

  it("shows 'STALE 30s' and degrades an otherwise-PREMIUM T1 badge when the quote is stale", () => {
    seedQuotes(
      quoteFor("BTC/USD", { staleLive: true, freshAgeMs: 30_000, ageMs: 30_000 }),
    );
    seedActivePrice(1.32);
    ui(widget("BTC/USD"));
    const marker = screen.getByTestId("rail-stale-marker");
    expect(marker.textContent).toContain("STALE 30s");
    const badge = screen.getByTestId("tier-badge");
    expect(badge.className).toContain("bg-slate-500/15");
    expect(badge.className).not.toContain("bg-st-pos");
    expect(badge.title).toContain("stale quote");
    expect(priceText()).not.toContain("1.32");
  });

  it("treats a backend `stale` flag (no fresh tick available) as stale", () => {
    seedQuotes(quoteFor("BTC/USD", { stale: true, freshAgeMs: null, ageMs: 4_000 }));
    ui(widget("BTC/USD", { price: null }));
    const marker = screen.getByTestId("rail-stale-marker");
    expect(marker.textContent).toContain("STALE");
  });

  it("keeps a fresh quote clean: no marker, PREMIUM T1 keeps its emerald styling", () => {
    seedQuotes(quoteFor("BTC/USD", { freshAgeMs: 500, ageMs: 500, staleLive: false }));
    ui(widget("BTC/USD"));
    expect(screen.queryByTestId("rail-stale-marker")).toBeNull();
    const badge = screen.getByTestId("tier-badge");
    expect(badge.className).toContain("bg-st-pos");
    expect(badge.title).not.toContain("stale quote");
  });

  it("ages out a quote past the 15s provenance threshold even without flags", () => {
    seedQuotes(quoteFor("BTC/USD", { freshAgeMs: 20_000, ageMs: 20_000 }));
    ui(widget("BTC/USD"));
    expect(screen.getByTestId("rail-stale-marker").textContent).toContain("STALE 20s");
  });
});