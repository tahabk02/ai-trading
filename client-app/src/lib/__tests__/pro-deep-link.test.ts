import { describe, it, expect, vi } from "vitest";
import {
  buildProHref,
  resolveProSymbol,
  normalizeSymbolQuery,
  suppressCardNav,
  resolveTfParam,
  PRO_TERMINAL_ROUTE,
  MARKET_TERMINAL_ROUTE,
} from "@/lib/pro-deep-link";

describe("Pro deep-link contract (/dashboard/pro?symbol=…&tf=…)", () => {
  it("test_market_card_links_to_pro_with_symbol", () => {
    const href = buildProHref("EUR/USD");
    expect(href).toBe(`${PRO_TERMINAL_ROUTE}?symbol=EUR%2FUSD`);
    // The encoded query must decode back to the canonical whitelist symbol.
    const query = decodeURIComponent(href.split("?symbol=")[1]);
    expect(normalizeSymbolQuery(query)).toBe("EUR/USD");
    expect(buildProHref("eurusd")).toBe(`${PRO_TERMINAL_ROUTE}?symbol=EUR%2FUSD`);
  });

  it("test_market_card_links_to_pro_with_symbol_and_tf", () => {
    // Horizon 5m → tf=300 seconds, canonical symbol, exact href.
    expect(buildProHref("EUR/USD", 300)).toBe(
      `${PRO_TERMINAL_ROUTE}?symbol=EUR%2FUSD&tf=300`,
    );
    expect(buildProHref("eurusd", 60)).toBe(
      `${PRO_TERMINAL_ROUTE}?symbol=EUR%2FUSD&tf=60`,
    );
    expect(buildProHref("gbpjpy", 180)).toBe(
      `${PRO_TERMINAL_ROUTE}?symbol=GBP%2FJPY&tf=180`,
    );
    // Non-positive / absent tf → back-compat bare href (no stale &tf=).
    expect(buildProHref("EUR/USD", 0)).toBe(
      `${PRO_TERMINAL_ROUTE}?symbol=EUR%2FUSD`,
    );
    expect(buildProHref("EUR/USD", Number.NaN)).toBe(
      `${PRO_TERMINAL_ROUTE}?symbol=EUR%2FUSD`,
    );
    expect(buildProHref("EUR/USD")).toBe(`${PRO_TERMINAL_ROUTE}?symbol=EUR%2FUSD`);
    // The card passes minutes × 60: [{1,2,3,5,10} min] → [60..600]s.
    expect(buildProHref("EUR/USD", 10 * 60)).toBe(
      `${PRO_TERMINAL_ROUTE}?symbol=EUR%2FUSD&tf=600`,
    );
  });

  it("test_pro_page_reads_symbol_and_tf_query", () => {
    expect(resolveTfParam("300")).toBe(300);
    expect(resolveTfParam("60")).toBe(60);
    expect(resolveTfParam(" 120 ")).toBe(120);
    expect(resolveTfParam(null)).toBeNull();
    expect(resolveTfParam(undefined)).toBeNull();
    expect(resolveTfParam("")).toBeNull();
    expect(resolveTfParam("abc")).toBeNull();
    expect(resolveTfParam("-5")).toBeNull();
    expect(resolveTfParam("0")).toBeNull();
    expect(resolveTfParam("1m")).toBeNull();
  });

  it("test_pro_button_stops_propagation", () => {
    const stopPropagation = vi.fn();
    const event = { stopPropagation };
    suppressCardNav(event);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    // The nested control must never bubble up to the card's navigate handler.
    const cardNavSpy = vi.fn();
    suppressCardNav(event);
    expect(cardNavSpy).not.toHaveBeenCalled();
  });

  it("test_pro_page_reads_symbol_query", () => {
    expect(resolveProSymbol("EUR/USD")).toEqual({ symbol: "EUR/USD" });
    // Compact / separator-chaotic input normalizes to the canonical form.
    expect(resolveProSymbol("eurusd")).toEqual({ symbol: "EUR/USD" });
    expect(resolveProSymbol("eur-usd")).toEqual({ symbol: "EUR/USD" });
    expect(resolveProSymbol("gbp/jpy")).toEqual({ symbol: "GBP/JPY" });
    expect(normalizeSymbolQuery(" BTC/USD ")).toBe("BTC/USD");
  });

  it("test_pro_page_redirects_when_symbol_missing", () => {
    expect(resolveProSymbol(null)).toEqual({ redirect: MARKET_TERMINAL_ROUTE });
    expect(resolveProSymbol(undefined)).toEqual({
      redirect: MARKET_TERMINAL_ROUTE,
    });
    expect(resolveProSymbol("")).toEqual({ redirect: MARKET_TERMINAL_ROUTE });
    // A symbol that cannot map onto any whitelisted pair also redirects.
    expect(resolveProSymbol("XX/YYY")).toEqual({
      redirect: MARKET_TERMINAL_ROUTE,
    });
  });
});