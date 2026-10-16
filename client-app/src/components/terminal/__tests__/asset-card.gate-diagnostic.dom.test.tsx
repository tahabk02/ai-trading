/**
 * asset-card.gate-diagnostic.dom.test.tsx — PART 52.
 *
 * A non-interactive card must show the ENGINE's own reason it is locked (plus
 * what would unlock it) — never a fabricated one — and the diagnostic must be
 * absent on tradable and market-closed cards. The reason is the payload's
 * `suppressed_reason` (fine class/high-precision gate) or the regime display
 * reason; nothing here bypasses or widens a gate.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";

import { AssetCard } from "@/components/terminal/asset-card";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import type { MarketQuote, PredictionResponse } from "@/services/api";
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

const REAL = "EUR/SEK"; // one of the 10 REAL_FOREX_PAIRS
const OTC = "EUR/USD"; // OTC — not a real-forex card

const quote = (
  symbol: string,
  overrides: Partial<MarketQuote> = {},
): MarketQuote => ({
  symbol,
  name: symbol,
  type: "forex",
  assetSubType: "forex",
  label: symbol,
  digits: 5,
  payout: 92,
  price: 11.111,
  bid: null,
  ask: null,
  spread: null,
  tickCount: 900,
  lastTickAt: "2026-10-09T20:59:00.000Z",
  ageMs: 1000,
  source: null,
  stale: false,
  freshAgeMs: 1000,
  staleLive: false,
  marketClosed: false,
  ...overrides,
});

const pred = (data: Partial<PredictionResponse> | null) =>
  ({
    status: "ok",
    direction: null,
    confidence: 0,
    market_waiting: false,
    waiting_reason: null,
    waiting_detail: null,
    data: data as PredictionResponse | null,
  }) as const;

const diagnostic = () => screen.queryByTestId("gate-diagnostic");

describe("[52] non-interactive card gate diagnostics", () => {
  beforeEach(() => resetAll());

  it("a REAL scored-only card surfacing regime_scored_only reads RANDOM-WALK REGIME", () => {
    useMarketTerminalStore.getState().setQuotes([quote(REAL)]);
    useMarketTerminalStore.getState().setPrediction(REAL, pred({ regime_gate: "scored_only" }));
    ui(<AssetCard symbol={REAL} />);

    const d = diagnostic();
    expect(d).not.toBeNull();
    expect(d).toHaveAttribute("data-code", "regime_scored_only");
    expect(d).toHaveTextContent("RANDOM-WALK REGIME");
  });

  it("lets the engine's fine suppressed_reason win over the coarse regime reason", () => {
    useMarketTerminalStore.getState().setQuotes([quote(REAL)]);
    useMarketTerminalStore
      .getState()
      .setPrediction(
        REAL,
        pred({ regime_gate: "pending_high_precision", suppressed_reason: "insufficient_history" }),
      );
    ui(<AssetCard symbol={REAL} />);

    const d = diagnostic();
    expect(d).toHaveAttribute("data-code", "insufficient_history");
    expect(d).toHaveTextContent("HISTORY TOO SHORT");
  });

  it("an OTC card demoted below the bar shows the engine reason too", () => {
    useMarketTerminalStore.getState().setQuotes([quote(OTC)]);
    useMarketTerminalStore.getState().setPrediction(OTC, {
      ...pred({ suppressed_reason: "otc_hf_fail" }),
      confidence: 62.4,
    });
    ui(<AssetCard symbol={OTC} />);

    const d = diagnostic();
    expect(d).toHaveAttribute("data-code", "otc_hf_fail");
    expect(d).toHaveTextContent("OTC HF QUALITY FAIL");
  });

  it("a tradable card shows NO gate diagnostic", () => {
    useMarketTerminalStore.getState().setQuotes([quote(OTC)]);
    useMarketTerminalStore.getState().setPrediction(OTC, {
      ...pred({ tier: "T1" }),
      direction: "BUY",
      confidence: 98.6,
    });
    ui(<AssetCard symbol={OTC} />);

    expect(diagnostic()).toBeNull();
  });

  it("a market-closed card shows NO gate diagnostic (that state explains itself)", () => {
    useMarketTerminalStore
      .getState()
      .setQuotes([quote(REAL, { marketClosed: true })]);
    useMarketTerminalStore
      .getState()
      .setPrediction(REAL, pred({ regime_gate: "scored_only" }));
    ui(<AssetCard symbol={REAL} />);

    expect(diagnostic()).toBeNull();
  });
});
