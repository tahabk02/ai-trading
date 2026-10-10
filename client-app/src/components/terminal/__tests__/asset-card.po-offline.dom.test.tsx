/**
 * asset-card.po-offline.dom.test.tsx — PART 43.4 [469].
 *
 * An OTC pair (24/7, normally fed by Pocket Option) whose quote is written by a
 * NON-PO feed (Frankfurter / ER-API / GitHub / last-known-real …) is PO OFFLINE:
 * the price is a market proxy, not a live PO print. The card must dim it and
 * name the state — a trader must never read a proxy as a tradeable PO tick.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";

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

const quote = (
  symbol: string,
  overrides: Partial<MarketQuote> = {},
): MarketQuote => ({
  symbol,
  name: symbol,
  type: "otc",
  assetSubType: "otc",
  label: symbol,
  digits: 5,
  payout: 92,
  price: 1.08512,
  bid: null,
  ask: null,
  spread: null,
  tickCount: 2400,
  lastTickAt: "2026-10-06T15:00:00.000Z",
  ageMs: 420,
  source: "pocket_option_ssot",
  stale: false,
  freshAgeMs: 420,
  staleLive: false,
  ...overrides,
});

const chip = () => screen.queryByTestId("po-offline-chip");
const priceEl = () => screen.getByTestId("asset-card-price");

describe("[469] card — OTC priced by a market proxy is PO OFFLINE", () => {
  beforeEach(() => resetAll());

  it("dims the price and shows the PO OFFLINE · market proxy chip for a non-PO OTC quote", () => {
    useMarketTerminalStore.getState().setQuotes([
      quote("EUR/USD", { source: "frankfurter:live" }),
    ]);
    ui(<AssetCard symbol="EUR/USD" />);

    expect(chip()).toBeInTheDocument();
    expect(chip()!.textContent).toContain("PO OFFLINE · market proxy");
    expect(priceEl().getAttribute("data-po-offline")).toBe("true");
    expect(priceEl().className).toContain("opacity-60");
    // The proxy is still named honestly by the provenance strip.
    expect(screen.getByTestId("quote-provenance").textContent).toBe("FRANKFURTER");
  });

  it("leaves a genuine PO OTC tick undimmed and chip-free", () => {
    useMarketTerminalStore.getState().setQuotes([quote("EUR/USD")]);
    ui(<AssetCard symbol="EUR/USD" />);

    expect(chip()).toBeNull();
    expect(priceEl().getAttribute("data-po-offline")).toBeNull();
    expect(priceEl().className).not.toContain("opacity-60");
  });

  it("does NOT flag a real-forex Frankfurter fallback (not an OTC instrument)", () => {
    useMarketTerminalStore.getState().setQuotes([
      quote("EUR/SEK", { assetSubType: "forex", source: "frankfurter:live" }),
    ]);
    ui(<AssetCard symbol="EUR/SEK" />);

    expect(chip()).toBeNull();
  });

  it("defers to MARKET CLOSED — no PO OFFLINE chip there", () => {
    useMarketTerminalStore.getState().setQuotes([
      quote("EUR/USD", {
        source: "market_closed_last_close",
        marketClosed: true,
        stale: true,
        staleLive: true,
      }),
    ]);
    ui(<AssetCard symbol="EUR/USD" />);

    expect(screen.getByTestId("market-closed-badge")).toBeInTheDocument();
    expect(chip()).toBeNull();
  });
});
