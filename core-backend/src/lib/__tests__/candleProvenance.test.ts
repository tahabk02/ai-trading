/**
 * Server candle provenance + symbol canonicalization.
 *
 * Regression cover for the two backend defects behind a frozen/duplicated
 * chart on a real↔OTC pair switch:
 *
 *  1. Every closed candle the aggregator seals is stamped `isFinal`, and the
 *     payload the client merges against is provably final.
 *  2. `getClosedHistory` keys ONLY on the canonical symbol, so
 *     "EUR-USD"/"EURUSD"/"EUR/USD" can never resolve to different buckets.
 */
import { describe, expect, it } from "vitest";

import { canonicalizeSymbol } from "../../utils/symbolFormat";
import { realtimeCandleAggregatorService } from "../../services/realtimeCandleAggregator.service";

const SERVICE = realtimeCandleAggregatorService;
const TICK_BASE = Date.now();

function clearAll(): void {
  SERVICE.removeSymbol("EUR/USD");
}

describe("canonicalizeSymbol", () => {
  it("collapses every separator spelling to one bucket key", () => {
    const expected = "EUR/USD";
    for (const raw of ["eur/usd", "EUR-USD", "EUR_USD", "EUR usd", " EUR/USD "]) {
      expect(canonicalizeSymbol(raw)).toBe(expected);
    }
  });

  it("expands the compact 6-letter broker form", () => {
    expect(canonicalizeSymbol("EURUSD")).toBe("EUR/USD");
    expect(canonicalizeSymbol("eurusd")).toBe("EUR/USD");
  });

  it("strips broker asset decorations (real and OTC land on one key)", () => {
    expect(canonicalizeSymbol("EUR/USD OTC")).toBe("EUR/USD");
    expect(canonicalizeSymbol("EURUSD=X")).toBe("EUR/USD");
    expect(canonicalizeSymbol("EURUSD.FX")).toBe("EUR/USD");
  });

  it("keeps a crypto pair addressable", () => {
    expect(canonicalizeSymbol("BTC/USD")).toBe("BTC/USD");
  });

  it("rejects non-strings instead of inventing a key", () => {
    expect(canonicalizeSymbol(undefined)).toBe("");
    expect(canonicalizeSymbol(null)).toBe("");
    expect(canonicalizeSymbol(42)).toBe("");
  });
});

describe("sealed server candles", () => {
  it("marks every closed candle isFinal so the client cannot repaint it", () => {
    clearAll();
    const first = TICK_BASE;
    const second = TICK_BASE + 60_000; // next M1 bucket
    // Open and settle the first bucket, then keep the second bucket open.
    SERVICE.addTick("EUR/USD", 1.1, first);
    SERVICE.addTick("EUR/USD", 1.2, second);

    const history = SERVICE.getClosedHistory("EUR/USD", "M1");
    expect(history).not.toBeNull();
    expect(history!.length).toBeGreaterThan(0);
    for (const c of history!) {
      expect(c.closed).toBe(true);
      expect(c.isFinal).toBe(true);
      expect(c.timestamp % 60_000).toBe(0); // on the broker bucket grid
    }
    clearAll();
  });

  it("never leaks a non-final row through the history replay path", () => {
    clearAll();
    SERVICE.addTick("EUR/USD", 1.1, TICK_BASE);
    SERVICE.addTick("EUR/USD", 1.15, TICK_BASE + 60_000);
    const viaAlias = SERVICE.getClosedHistory("EUR-USD", "M1");
    expect(viaAlias).not.toBeNull();
    expect(viaAlias!.every((c) => c.isFinal === true)).toBe(true);
    clearAll();
  });
});
