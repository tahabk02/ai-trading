/**
 * asset-card.live-verdict-badge.dom.test.tsx — PART 38.1 [377].
 *
 * THE BUG: the blotter's CALL/PUT badge almost never rendered even though the
 * 1Hz `live_quant_signal` feed it reads was producing directional verdicts the
 * whole time (HUD showed 3/44 on the same tape).
 *
 * Three causes, all pinned below:
 *   1. the badge lived only in the `interactive` branch, and `interactive`
 *      requires `filterConf >= minConfidencePct` — with no horizon prediction
 *      on mount (multi-predict is event-driven only) `filterConf` falls back to
 *      the micro-quant confidence, which sits under the 96.5% T1 bar almost
 *      always, so the card demoted to "BELOW 96.5% BAR" and printed NO
 *      direction at all;
 *   2. `demotedByTier` fires when `tierClearsSelection(cardTier, minTier)` is
 *      false — and `cardTier` was null for every live verdict because neither
 *      the socket hop nor the reducer carried `tier`;
 *   3. an engine-suppressed band (regime override ⇒ SUPPRESSED_TIER T5 at 97%)
 *      would have read back as T1 by confidence-derivation.
 *
 * The fix keeps the bar's MEANING — it gates tradability (row 4 pills, PRO,
 * the link role) — and stops it from hiding what the feeds believe.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";

import { AssetCard } from "@/components/terminal/asset-card";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import type { LiveVerdict } from "@/store/useMarketTerminalStore";
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

const SYMBOL = "EUR/USD"; // OTC — not one of the PART 15 real-forex cards

const verdict = (overrides: Partial<LiveVerdict> = {}) =>
  useMarketTerminalStore.getState().ingestVerdict({
    symbol: SYMBOL,
    direction: "BUY",
    confidence: 62.4,
    market_waiting: false,
    waiting_reason: null,
    waiting_detail: null,
    book_confluence: 61.8,
    tier: "T5",
    tier_label: "WEAK",
    dispatchable: true,
    scored_only: true,
    executable: false,
    timestamp: "2026-10-06T10:00:00.000Z",
    ...overrides,
  } as LiveVerdict & { symbol: string });

const card = () => screen.getByTestId("asset-card");
// Scoped to the row-4 BUTTON: the card root itself carries
// `aria-label="Open Pro Terminal for …"` in every state (realForexRegime's
// ariaLabel), so a bare queryByLabelText would match the card and pass/fail
// on the wrong element.
const proButton = () =>
  screen.queryByRole("button", {
    name: `Open Pro Terminal for ${SYMBOL}`,
  });

describe("[377] the LIVE direction stays visible on a below-bar card", () => {
  beforeEach(() => resetAll());

  it("renders CALL next to the BELOW BAR reason and keeps the card non-tradable", () => {
    verdict({ confidence: 62.4, tier: "T5" });
    ui(<AssetCard symbol={SYMBOL} />);

    // THE FIX: the direction is no longer swallowed by the demotion strip.
    expect(screen.getByText("CALL")).toBeInTheDocument();
    expect(screen.getByText(/BELOW 96\.5% BAR/)).toBeInTheDocument();
    expect(screen.getByText("62.4%")).toBeInTheDocument();

    // The bar still means what it meant: no trade action from this card.
    expect(card()).toHaveAttribute("aria-disabled", "true");
    expect(card()).not.toHaveAttribute("role", "link");
    expect(proButton()).toBeNull();
  });

  it("shows an engine-suppressed band honestly — T5 at 97.2% is still T5", () => {
    // regime override (signal_gatekeeper SUPPRESSED_TIER) stamps T5 even when
    // the confidence would derive T1. Confidence-derivation is exactly why the
    // band has to arrive on the wire instead of being recomputed client-side.
    verdict({
      confidence: 97.2,
      tier: "T5",
      tier_label: "WEAK",
      executable: false,
      scored_only: true,
    });
    ui(<AssetCard symbol={SYMBOL} />);

    expect(screen.getByText("CALL")).toBeInTheDocument();
    expect(screen.getByText(/BELOW T1 FLOOR/)).toBeInTheDocument();
    expect(screen.getByTestId("tier-badge").textContent).toContain("T5");
    expect(card()).toHaveAttribute("aria-disabled", "true");
    expect(proButton()).toBeNull();
  });

  it("an actionable verdict keeps its badge, its PRO action and its pills", () => {
    verdict({
      confidence: 98.6,
      tier: "T1",
      tier_label: "PREMIUM",
      dispatchable: true,
      scored_only: false,
      executable: true,
    });
    ui(<AssetCard symbol={SYMBOL} />);

    expect(screen.getByText("CALL")).toBeInTheDocument();
    expect(screen.queryByText(/BELOW \d/)).toBeNull();
    expect(card()).not.toHaveAttribute("aria-disabled", "true");
    expect(proButton()).not.toBeNull();
  });

  it("a market-waiting verdict shows WAITING and never fabricates a direction", () => {
    verdict({
      direction: null,
      confidence: 0,
      market_waiting: true,
      waiting_reason: "SPOT_RATE_EXHAUSTED",
      tier: null,
      tier_label: null,
      dispatchable: false,
      scored_only: false,
      executable: false,
    });
    ui(<AssetCard symbol={SYMBOL} />);

    expect(screen.getByText("WAITING")).toBeInTheDocument();
    expect(screen.queryByText("CALL")).toBeNull();
    expect(screen.queryByText("PUT")).toBeNull();
    expect(proButton()).toBeNull();
  });

  it("the horizon verdict rides the demoted strip too — one row, both feeds", () => {
    verdict({ confidence: 62.4, tier: "T5" });
    useMarketTerminalStore.getState().setPrediction(SYMBOL, {
      status: "ok",
      direction: "SELL",
      confidence: 71.5,
      market_waiting: false,
      waiting_reason: null,
      waiting_detail: null,
      data: null,
    });
    ui(<AssetCard symbol={SYMBOL} />);

    // The horizon confidence (71.5%) is what drives the bar decision…
    expect(screen.getByText("71.5%")).toBeInTheDocument();
    expect(screen.getByText(/BELOW 96\.5% BAR/)).toBeInTheDocument();
    // …but both directions stay on screen.
    expect(screen.getByText("CALL")).toBeInTheDocument();
    expect(screen.getByText(/H\d+m PUT/)).toBeInTheDocument();
  });
});
