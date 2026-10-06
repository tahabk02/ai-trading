/**
 * asset-card.quote-provenance.dom.test.tsx — PART 38.2 [384]/[385].
 *
 * THE BUG: every price painted as if it were live. `ageMs` counts the newest
 * ring entry — including held prints re-pended for tape continuity — so a
 * price whose last GENUINE tick was ~59 minutes ago rendered at "0s" next to
 * a fresh-looking spread, and a Frankfurter/open.er-api fallback for a pair
 * Pocket Option does not list was indistinguishable from a PO SSOT tick.
 *
 * THE FIX: the quote now carries `source` / `stale` / `freshAgeMs` /
 * `staleLive`, and the card prints a provenance strip (ROW 2b) that says
 * which feed wrote the price and whether it is live, held or unverified.
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

const SYMBOL = "EUR/USD";

const quote = (overrides: Partial<MarketQuote> = {}): MarketQuote => ({
  symbol: SYMBOL,
  name: "Euro / US Dollar",
  type: "otc",
  assetSubType: "otc",
  label: "EUR/USD OTC",
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

const provenance = () => screen.queryByTestId("quote-provenance");

describe("[384] the card states WHICH feed wrote the price and whether it is live", () => {
  beforeEach(() => resetAll());

  it("shows PO LIVE for a genuine Pocket Option tick", () => {
    useMarketTerminalStore.getState().setQuotes([quote()]);
    ui(<AssetCard symbol={SYMBOL} />);

    expect(provenance()).toBeInTheDocument();
    expect(provenance()!.textContent).toBe("PO LIVE");
    expect(provenance()!.title).toMatch(/Pocket Option live tick/);
  });

  it("names a REST fallback tier instead of passing it off as live", () => {
    useMarketTerminalStore.getState().setQuotes([
      quote({
        source: "frankfurter:live",
        staleLive: false,
        freshAgeMs: 800,
        ageMs: 800,
      }),
    ]);
    ui(<AssetCard symbol={SYMBOL} />);

    expect(provenance()!.textContent).toBe("FRANKFURTER");
    expect(provenance()!.title).toBe(
      "Fallback: Frankfurter ECB reference rates",
    );
  });

  it("surfaces a held price as HELD with its age — the stale state is visible", () => {
    // ageMs is small (the held print was re-pended seconds ago) while nothing
    // genuinely fresh arrived for two minutes: the pre-fix lie, now pinned.
    useMarketTerminalStore.getState().setQuotes([
      quote({
        source: "last_known_real",
        stale: true,
        staleLive: true,
        freshAgeMs: null,
        ageMs: 3_000,
      }),
    ]);
    ui(<AssetCard symbol={SYMBOL} />);

    expect(provenance()!.textContent).toMatch(/^HELD \d+s$/);
    expect(provenance()!.title).toMatch(/No live tick for \d+s/);
    expect(provenance()!.className).toContain("font-semibold");
  });

  it("never claims a source it does not have", () => {
    useMarketTerminalStore.getState().setQuotes([
      quote({ source: null, staleLive: false, freshAgeMs: 250 }),
    ]);
    ui(<AssetCard symbol={SYMBOL} />);

    expect(provenance()!.textContent).toBe("UNKNOWN SRC");
    expect(provenance()!.title).toMatch(/origin unverified/);
  });

  it("re-renders when the provenance changes (structural sharing is bypassed)", () => {
    useMarketTerminalStore.getState().setQuotes([quote()]);
    ui(<AssetCard symbol={SYMBOL} />);
    expect(provenance()!.textContent).toBe("PO LIVE");

    // `setQuotes` deliberately keeps the previous object reference when the
    // rendered fields are identical — `source` MUST be one of them, or the
    // card would keep painting PO LIVE over a Frankfurter fallback forever.
    act(() => {
      useMarketTerminalStore.getState().setQuotes([
        quote({ source: "frankfurter:live" }),
      ]);
    });
    expect(provenance()!.textContent).toBe("FRANKFURTER");
  });
});
