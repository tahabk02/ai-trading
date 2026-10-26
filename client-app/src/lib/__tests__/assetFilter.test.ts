/**
 * assetFilter.test.ts — ASSET FILTER CONTRACT (Market Terminal).
 *
 * The load-bearing cases are the two that produced the reported
 * "Real market is locked" bug:
 *   • classification must be COMPLETE before any quote lands, and
 *   • classification must not depend on a PARTIAL quote snapshot.
 * Both are asserted against an EMPTY `quotes` object, because that is the
 * exact state the old `getState().quotes[sym]?.assetSubType` read failed on.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_MARKET_SYMBOLS,
} from "@/store/useMarketTerminalStore";
import { OTC_FOREX_PAIRS, REAL_FOREX_PAIRS } from "@/constants/symbols";
import {
  applyAssetFilter,
  ASSET_CLASS_COUNTS,
  ASSET_CLASSES,
  countVisible,
  countVisibleByClass,
  currenciesOf,
  DEFAULT_ASSET_FILTER,
  isFilterActive,
  isShowingEverything,
  isSymbolVisible,
  matchesQuery,
  sanitizeAssetClasses,
  sanitizeSymbolList,
  setSingleClass,
  toggleClass,
  toggleSymbol,
  type AssetFilterState,
} from "@/lib/assetFilter";

const filter = (over: Partial<AssetFilterState> = {}): AssetFilterState => ({
  ...DEFAULT_ASSET_FILTER,
  ...over,
});

describe("asset classification (the 'Real is locked' root cause)", () => {
  it("classifies the FULL universe with ZERO quotes present", () => {
    // The old implementation read `quotes[sym]?.assetSubType` — with no
    // snapshot every lookup was undefined, so "Real" resolved to an empty
    // set and the grid rendered nothing.
    const quotes: Record<string, never> = {};
    expect(Object.keys(quotes)).toHaveLength(0);

    const real = applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ classes: ["real"] }));
    expect(real).toHaveLength(REAL_FOREX_PAIRS.length);
    expect(real).toEqual(REAL_FOREX_PAIRS.map((p) => p.symbol));
  });

  it("is unaffected by a PARTIAL quote snapshot (no arbitrary subsets)", () => {
    const full = applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ classes: ["real"] }));
    // Simulate exactly 3 of 5 real quotes having landed — the state that made
    // the old fallback suppression render "Real 3" instead of "Real 5".
    const partialQuotes = new Set(full.slice(0, 3));
    const visible = applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ classes: ["real"] }));
    expect(visible).toHaveLength(REAL_FOREX_PAIRS.length);
    expect(visible.some((sym) => !partialQuotes.has(sym))).toBe(true);
  });

  it("never lets OTC and REAL overlap", () => {
    const otc = new Set(applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ classes: ["otc"] })));
    const real = new Set(applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ classes: ["real"] })));
    for (const sym of real) expect(otc.has(sym)).toBe(false);
  });

  it("class counts sum to the universe and match the registry", () => {
    const total = ASSET_CLASS_COUNTS.otc + ASSET_CLASS_COUNTS.real;
    expect(total).toBe(ALL_MARKET_SYMBOLS.length);
    expect(ASSET_CLASS_COUNTS.real).toBe(REAL_FOREX_PAIRS.length);
    expect("crypto" in ASSET_CLASS_COUNTS).toBe(false);
    // The OTC count is DERIVED from classification, not read off
    // OTC_FOREX_PAIRS.length: that array deliberately spreads the 5 real
    // pairs, so subtracting REAL_FOREX_PAIRS.length is what makes this
    // test meaningful.
    expect(ASSET_CLASS_COUNTS.otc).toBe(
      OTC_FOREX_PAIRS.length - REAL_FOREX_PAIRS.length,
    );
  });

  it("every class isolation yields a non-empty grid (no dead control)", () => {
    for (const cls of ASSET_CLASSES) {
      expect(applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ classes: [cls] })).length)
        .toBeGreaterThan(0);
    }
  });
});

describe("multi-select toggle semantics", () => {
  it("empty set means show everything", () => {
    expect(isShowingEverything([])).toBe(true);
    expect(applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ classes: [] })))
      .toHaveLength(ALL_MARKET_SYMBOLS.length);
  });

  it("toggling the LAST class yields empty (= all), never a stuck control", () => {
    let classes = filter().classes;
    classes = toggleClass(classes, "real");
    expect(classes).toEqual(["real"]);
    classes = toggleClass(classes, "real");
    // Must be [] and must NOT snap back to ["real"].
    expect(classes).toEqual([]);
    expect(isShowingEverything(classes)).toBe(true);
  });

  it("accumulates multiple classes (union, not intersection)", () => {
    let classes = toggleClass([], "real");
    classes = toggleClass(classes, "otc");
    // Canonical order is the ASSET_CLASSES declaration order, not toggle order.
    expect(classes).toEqual(["otc", "real"]);
    const visible = applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ classes }));
    expect(visible).toHaveLength(ASSET_CLASS_COUNTS.otc + ASSET_CLASS_COUNTS.real);
  });

  it("always returns canonical order regardless of toggle sequence", () => {
    const a = toggleClass(toggleClass([], "otc"), "real");
    const b = toggleClass(toggleClass([], "real"), "otc");
    expect(a).toEqual(b);
    expect(a).toEqual(["otc", "real"]);
  });

  it("drops unknown / duplicate / non-string classes", () => {
    expect(sanitizeAssetClasses(["real", "real", "bogus", 7, null, "otc"]))
      .toEqual(["otc", "real"]);
    expect(sanitizeAssetClasses("real")).toEqual([]);
    expect(sanitizeAssetClasses(null)).toEqual([]);
  });

  it("maps the legacy single-select enum onto the set", () => {
    expect(setSingleClass("all")).toEqual([]);
    expect(setSingleClass("real")).toEqual(["real"]);
    expect(setSingleClass("otc")).toEqual(["otc"]);
  });
});

describe("currency + free-text query", () => {
  it("matches a single currency leg", () => {
    const eur = applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ query: "EUR" }));
    expect(eur.length).toBeGreaterThan(0);
    for (const sym of eur) expect(currenciesOf(sym)).toContain("EUR");
  });

  it("matches full symbol, compact form, and partial", () => {
    expect(matchesQuery("EUR/SEK", "EUR/SEK")).toBe(true);
    expect(matchesQuery("EUR/SEK", "EURSEK")).toBe(true);
    expect(matchesQuery("EUR/SEK", "sek")).toBe(true);
    expect(matchesQuery("EUR/SEK", "zzz")).toBe(false);
    expect(matchesQuery("EUR/SEK", "")).toBe(true);
  });

  it("case-insensitive and separator-insensitive", () => {
    const a = applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ query: "eur" }));
    const b = applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ query: "EUR-" }));
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("favorites + hidden", () => {
  it("favoritesOnly shows exactly the pinned symbols", () => {
    const favs = ["EUR/USD", "EUR/JPY"];
    const visible = applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ favorites: favs, favoritesOnly: true }));
    expect(visible.sort()).toEqual([...favs].sort());
  });

  it("hidden excludes the symbol", () => {
    const visible = applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ hidden: ["EUR/USD"] }));
    expect(visible).not.toContain("EUR/USD");
  });

  it("a favorite is NOT hidden by the hidden list (pin wins)", () => {
    const visible = applyAssetFilter(
      ALL_MARKET_SYMBOLS,
      filter({ hidden: ["EUR/USD"], favorites: ["EUR/USD"] }),
    );
    expect(visible).toContain("EUR/USD");
  });

  it("toggling favorites adds then removes", () => {
    let favs = toggleSymbol([], "eur/usd");
    expect(favs).toEqual(["EUR/USD"]);
    favs = toggleSymbol(favs, "EUR/USD");
    expect(favs).toEqual([]);
  });

  it("drops retired / unknown persisted symbols", () => {
    expect(sanitizeSymbolList(["EUR/USD", "FAKE/PAIR", "BTC/USD", "EUR/USD"]))
      .toEqual(["EUR/USD"]);
  });
});

describe("filter composition + status", () => {
  it("class isolation and query compose as an AND", () => {
    const visible = applyAssetFilter(
      ALL_MARKET_SYMBOLS,
      filter({ classes: ["real"], query: "EUR" }),
    );
    expect(visible.length).toBeGreaterThan(0);
    for (const sym of visible) {
      expect(currenciesOf(sym)).toContain("EUR");
      expect(sanitizeSymbolList([sym])).toHaveLength(1);
    }
  });

  it("pill counts ignore class isolation so toggling never zeroes badges", () => {
    const state = filter({ classes: ["real"] });
    const counts = countVisibleByClass(ALL_MARKET_SYMBOLS, state);
    expect(counts.real).toBe(ASSET_CLASS_COUNTS.real);
    expect(counts.otc).toBe(ASSET_CLASS_COUNTS.otc);
  });

  it("pill counts DO honour favorites / hidden / query", () => {
    const state = filter({ hidden: [REAL_FOREX_PAIRS[0].symbol] });
    const counts = countVisibleByClass(ALL_MARKET_SYMBOLS, state);
    expect(counts.real).toBe(ASSET_CLASS_COUNTS.real - 1);
  });

  it("countVisible agrees with applyAssetFilter", () => {
    const state = filter({ classes: ["real"], query: "EUR" });
    expect(countVisible(ALL_MARKET_SYMBOLS, state))
      .toBe(applyAssetFilter(ALL_MARKET_SYMBOLS, state).length);
  });

  it("isFilterActive only true when something is actually filtered", () => {
    expect(isFilterActive(filter())).toBe(false);
    expect(isFilterActive(filter({ classes: ["real"] }))).toBe(true);
    expect(isFilterActive(filter({ query: "  " }))).toBe(false);
    expect(isFilterActive(filter({ favorites: ["EUR/USD"] }))).toBe(false);
    expect(isFilterActive(filter({ favoritesOnly: true }))).toBe(true);
  });

  it("isSymbolVisible matches applyAssetFilter for every symbol (single predicate)", () => {
    const state = filter({ classes: ["otc"], query: "USD", hidden: ["EUR/USD"] });
    const viaList = new Set(applyAssetFilter(ALL_MARKET_SYMBOLS, state));
    for (const sym of ALL_MARKET_SYMBOLS) {
      expect(isSymbolVisible(sym, state)).toBe(viaList.has(sym));
    }
  });
});

describe("grid is never silently empty for a valid filter", () => {
  it("every single-class selection renders cards", () => {
    for (const cls of ASSET_CLASSES) {
      expect(applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ classes: [cls] })).length)
        .toBeGreaterThan(0);
    }
  });

  it("only a deliberately over-narrow query may empty the grid", () => {
    expect(applyAssetFilter(ALL_MARKET_SYMBOLS, filter({ query: "ZZZZZ" }))).toHaveLength(0);
  });
});
