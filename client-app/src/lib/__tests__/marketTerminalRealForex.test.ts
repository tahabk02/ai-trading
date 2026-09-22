import { describe, it, expect } from "vitest";
import { OTC_FOREX_PAIRS, REAL_FOREX_PAIRS, REAL_FOREX_SET } from "@/constants/symbols";
import { ALL_MARKET_SYMBOLS, REAL_MARKET_SYMBOLS } from "@/store/useMarketTerminalStore";
import {
  assetClassBadgeLabel,
} from "@/components/shared/asset-class-badge";
import {
  resolveRealForexRegimeDisplay,
  realForexCardBehavior,
  REAL_FOREX_NONINTERACTIVE_COPY,
} from "@/lib/realForexRegime";

describe("PART 15 — real forex terminal wiring", () => {
  const ALL_REAL_SYMBOLS = REAL_FOREX_PAIRS.map((p) => p.symbol);

  it("ALL_MARKET_SYMBOLS has exactly 44 unique instruments (32 OTC + 2 crypto + 10 real)", () => {
    expect(new Set(ALL_MARKET_SYMBOLS).size).toBe(44);
    expect(ALL_MARKET_SYMBOLS).toHaveLength(44);
  });

  it("every REAL_FOREX_PAIRS symbol is a distinct member of the 44", () => {
    for (const sym of ALL_REAL_SYMBOLS) {
      expect(ALL_MARKET_SYMBOLS).toContain(sym);
      expect(REAL_MARKET_SYMBOLS.has(sym)).toBe(true);
    }
    expect(ALL_REAL_SYMBOLS.length).toBe(10);
    expect(REAL_MARKET_SYMBOLS.size).toBe(10);
  });

  it("OTC_FOREX_PAIRS spreads the real pairs (44 entries) for whitelist continuity", () => {
    expect(OTC_FOREX_PAIRS.map((p) => p.symbol)).toEqual(
      expect.arrayContaining(ALL_REAL_SYMBOLS),
    );
    for (const sym of ALL_REAL_SYMBOLS) {
      expect(REAL_FOREX_SET.has(sym)).toBe(true);
    }
  });

  it("the REAL badge renders for every real pair; OTC/crypto badges stay distinct", () => {
    for (const sym of ALL_REAL_SYMBOLS) {
      expect(assetClassBadgeLabel(sym)).toBe("REAL");
    }
    expect(assetClassBadgeLabel("EUR/USD")).toBe("OTC");
    expect(assetClassBadgeLabel("GBP/USD")).toBe("OTC");
    expect(assetClassBadgeLabel("BTC/USD")).toBe("CRYPTO");
    expect(assetClassBadgeLabel("ETH/USD")).toBe("CRYPTO");
  });

  it("[47]/[48] pending: every real pair card is scored-only regardless of payload", () => {
    for (const sym of ALL_REAL_SYMBOLS) {
      const d = resolveRealForexRegimeDisplay(sym, "tradable");
      expect(d.isReal).toBe(true);
      expect(d.scoredOnly).toBe(true);
      expect(d.reason).not.toBeNull();
    }
  });

  it("a real pair with regime_gate 'scored_only' is scored-only now and stays so post-confirmation-marked", () => {
    const d = resolveRealForexRegimeDisplay("EUR/SEK", "scored_only");
    expect(d.scoredOnly).toBe(true);
    expect(d.reason).toBe("regime_scored_only");
  });

  it("scored-only cards are truly non-interactive: no link role, no PRO action, no target candle", () => {
    for (const sym of ALL_REAL_SYMBOLS) {
      const b = realForexCardBehavior(sym, undefined);
      expect(b.interactive).toBe(false);
      expect(b.scoredOnly).toBe(true);
      expect(b.ariaLabel).toContain("scored-only");
      expect(b.ariaLabel).not.toContain("Open Pro Terminal");
    }
  });

  it("non-real cards remain interactive (normal role='link' card)", () => {
    const b = realForexCardBehavior("EUR/USD", undefined);
    expect(b.interactive).toBe(true);
    expect(b.scoredOnly).toBe(false);
    expect(b.ariaLabel).toBe("Open Pro Terminal for EUR/USD");
  });

  it("PART 28: every real card is a live intraday tape, never daily_close", () => {
    for (const sym of ALL_REAL_SYMBOLS) {
      const d = resolveRealForexRegimeDisplay(sym, "tradable");
      const b = realForexCardBehavior(sym, "tradable");
      expect(d.dataKind).toBe("live");
      expect(b.dataKind).toBe("live");
    }
    // Non-real stays live too.
    expect(resolveRealForexRegimeDisplay("EUR/USD", undefined).dataKind).toBe("live");
  });

  it("PART 27: scored-only cards carry hover + on-card copy reusing suppressedReason", () => {
    for (const sym of ALL_REAL_SYMBOLS) {
      const d = resolveRealForexRegimeDisplay(sym, undefined);
      expect(d.scoredOnly).toBe(true);
      expect(d.nonInteractiveTitle).toBe(
        REAL_FOREX_NONINTERACTIVE_COPY.regime_pending_confirmation,
      );
      expect(d.scoredOnlyCaption).toBe(d.nonInteractiveTitle);
    }
    const scored = resolveRealForexRegimeDisplay("EUR/SEK", "scored_only");
    expect(scored.scoredOnlyCaption).toBe(
      REAL_FOREX_NONINTERACTIVE_COPY.regime_scored_only,
    );
    const b = realForexCardBehavior("EUR/SEK", undefined);
    expect(b.nonInteractiveTitle).toContain("Regime review pending");
  });
});