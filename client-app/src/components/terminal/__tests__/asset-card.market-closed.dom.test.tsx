/**
 * asset-card.market-closed.dom.test.tsx — PART 42.1 [422].
 *
 * While the weekly forex market is closed a REAL card must read
 * "MARKET CLOSED · last close <time>" and must NOT be confused with
 * SCORED-ONLY, must NOT show a signal/target, and must NOT paint a PRICE STALE
 * / HELD provenance strip. A market-closed card is non-interactive.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, act } from "@testing-library/react";

import { AssetCard } from "@/components/terminal/asset-card";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import type { MarketQuote } from "@/services/api";
import { resetAll, ui } from "@/test/harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard",
  useParams: () => ({}),
}));

const SYMBOL = "EUR/SEK";

const quote = (overrides: Partial<MarketQuote> = {}): MarketQuote => ({
  symbol: SYMBOL,
  name: "Euro / Swedish Krona",
  type: "forex",
  assetSubType: "forex",
  label: "EUR/SEK",
  digits: 4,
  payout: 92,
  price: 11.111,
  bid: null,
  ask: null,
  spread: null,
  tickCount: 900,
  lastTickAt: "2026-10-09T20:59:00.000Z",
  ageMs: 3_600_000,
  source: "market_closed_last_close",
  stale: true,
  freshAgeMs: null,
  staleLive: true,
  marketClosed: true,
  ...overrides,
});

describe("[422] market-closed REAL card", () => {
  beforeEach(() => resetAll());

  it("reads MARKET CLOSED with the last close and shows no signal/target", () => {
    useMarketTerminalStore.getState().setQuotes([quote()]);
    ui(<AssetCard symbol={SYMBOL} />);

    const badge = screen.getByTestId("market-closed-badge");
    expect(badge).toHaveTextContent("MARKET CLOSED");
    expect(screen.getByTestId("market-closed-last-close")).toHaveTextContent(
      "last close 20:59 UTC",
    );

    // No signal, no target, no SCORED-ONLY confusion, no stale/held strip.
    expect(screen.queryByTestId("card-target-slot")).toBeNull();
    expect(screen.queryByText(/SCORED-ONLY/)).toBeNull();
    expect(screen.queryByTestId("quote-provenance")).toBeNull();
    expect(screen.queryByText(/CALL|PUT/)).toBeNull();
    // Non-interactive: no PRO deep-link.
    expect(screen.queryByLabelText(`Open Pro Terminal for ${SYMBOL}`)).toBeNull();
  });

  it("without the marketClosed flag the same REAL pair reads SCORED-ONLY", () => {
    // Proves the flag is what changes the state (no regime_gate → scored-only).
    useMarketTerminalStore.getState().setQuotes([
      quote({ marketClosed: false, stale: false, staleLive: false }),
    ]);
    ui(<AssetCard symbol={SYMBOL} />);

    expect(screen.queryByTestId("market-closed-badge")).toBeNull();
    expect(screen.getByText(/SCORED-ONLY/)).toBeInTheDocument();
  });

  it("switches to MARKET CLOSED when the flag arrives (structural sharing bypassed)", () => {
    useMarketTerminalStore.getState().setQuotes([
      quote({ marketClosed: false, stale: false, staleLive: false }),
    ]);
    ui(<AssetCard symbol={SYMBOL} />);
    expect(screen.queryByTestId("market-closed-badge")).toBeNull();

    act(() => {
      useMarketTerminalStore.getState().setQuotes([quote({ marketClosed: true })]);
    });
    expect(screen.getByTestId("market-closed-badge")).toHaveTextContent(
      "MARKET CLOSED",
    );
  });
});
