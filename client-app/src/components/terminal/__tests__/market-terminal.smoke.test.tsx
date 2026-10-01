import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { MarketTerminal } from "@/components/terminal/market-terminal";
import {
  useMarketTerminalStore,
  ALL_MARKET_SYMBOLS,
} from "@/store/useMarketTerminalStore";
import { applyAssetFilter, ASSET_CLASSES, type AssetClass } from "@/lib/assetFilter";
import { getOtcpair, getPriceDigits } from "@/constants/symbols";
import type { MarketQuote } from "@/services/api";
import { resetAll, ui } from "@/test/harness";

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

// `services/api.ts` default-exports a plain object literal (line 692) with
// `getQuotes` (886) and `multiPredict` as methods. importOriginal keeps every
// other export intact so the import graph resolves identically to production;
// only the two network calls are stubbed.
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

vi.mock("next/navigation", () => ({
  // AssetCard:55 calls useRouter() for its /dashboard/pro deep-link. Outside an
  // App Router tree that hook throws "expected app router to be mounted", so
  // navigation is stubbed and asserted directly rather than actually navigating.
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

const cards = () => screen.queryAllByTestId("asset-card").length;

/** Expected count, computed with the SAME pure function the component uses. */
const expected = (classes: AssetClass[] = [...ASSET_CLASSES]) =>
  applyAssetFilter(ALL_MARKET_SYMBOLS, {
    classes,
    favorites: [],
    hidden: [],
    query: "",
    favoritesOnly: false,
  }).length;

describe("market terminal smoke", () => {
  beforeEach(resetAll);

  it("renders the full registry with no quotes at all", () => {
    ui(<MarketTerminal />);
    expect(cards()).toBe(expected());
    expect(cards()).toBe(ALL_MARKET_SYMBOLS.length);
  });

  it("INVARIANT 4 — a PARTIAL quote snapshot cannot change the count", () => {
    // The documented defect (market-terminal.tsx:78-85): a non-reactive
    // `getState().quotes[sym]` read meant a partial snapshot suppressed the
    // registry fallback, so selecting "real" mid-boot rendered an arbitrary
    // subset with no error surfaced. Classification must stay registry-backed.
    act(() => {
      useMarketTerminalStore.setState({
        quotes: Object.fromEntries(
          ALL_MARKET_SYMBOLS.slice(0, 3).map((symbol, i) => [
            symbol,
            { symbol, price: 1.08 + i / 1000, digits: 5, tickCount: 1 },
          ]),
        ),
      } as never);
    });
    ui(<MarketTerminal />);
    expect(cards()).toBe(expected());
  });

  it("INVARIANT 4 — a class filter counts from the registry, not from quotes", () => {
    act(() => useMarketTerminalStore.getState().setAssetClasses(["real"]));
    ui(<MarketTerminal />);
    expect(cards()).toBe(expected(["real"]));
    expect(cards()).toBeLessThan(ALL_MARKET_SYMBOLS.length);
  });

  it("INVARIANT 1 — a quote batch is ONE store update, not one per symbol", () => {
    // setQuotes MERGES and only bumps _quoteVersion when something actually
    // changed (useMarketTerminalStore.ts:189-198). So a 3-symbol batch is a
    // single version step, and a re-send of identical data is a no-op — the
    // counter is a change detector, which is what keeps 1Hz snapshots from
    // becoming a render storm.
    const q = ALL_MARKET_SYMBOLS.slice(0, 3).map((symbol, i) => {
      // Metadata comes from the registry, never from the quote: classification
      // is static (invariant 5) and must not be derivable from a live payload.
      const def = getOtcpair(symbol);
      if (!def) throw new Error(`fixture symbol not in registry: ${symbol}`);
      return {
        symbol,
        name: def.name,
        type: def.type,
        assetSubType: def.assetSubType,
        label: def.label,
        digits: getPriceDigits(symbol),
        payout: def.payout,
        price: 1.08 + i / 1000,
        bid: 1.08 + i / 1000 - 0.0001,
        ask: 1.08 + i / 1000 + 0.0001,
        spread: 0.0002,
        tickCount: 1,
        lastTickAt: new Date().toISOString(),
        ageMs: 0,
      } satisfies MarketQuote;
    });

    const v0 = useMarketTerminalStore.getState()._quoteVersion;
    act(() => useMarketTerminalStore.getState().setQuotes(q));
    const v1 = useMarketTerminalStore.getState()._quoteVersion;
    expect(v1 - v0).toBe(1);

    act(() => useMarketTerminalStore.getState().setQuotes(q));
    const v2 = useMarketTerminalStore.getState()._quoteVersion;
    expect(v2 - v1).toBe(0);
  });

  it("renders no cards when a symbol query matches nothing", () => {
    act(() =>
      useMarketTerminalStore.getState().setSymbolQuery("zzz-no-such-pair"),
    );
    ui(<MarketTerminal />);
    expect(cards()).toBe(0);
  });
});
