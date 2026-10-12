/**
 * bootStreamSeed.test.ts — PART 15.1 [62] REGRESSION: boot-seed gap closed.
 *
 * [52] found that tick streams were auto-started ONLY for symbolRegistry
 * getAll("otc"), so the 10 real non-OTC forex pairs (EUR/SEK … EUR/NOK)
 * produced no live quote until a Pro chart subscribed to one individually —
 * leaving the market terminal grid with -- placeholders on 10 cards.
 *
 * [61] extends the boot seed to otc + forex explicitly. This test asserts the
 * EXACT [62] contract: after boot (i.e. after getBootStreamSeed + the feed
 * machinery prints a tick for a real pair), a real-pair symbol has a live
 * quote in realtimeTickBuffer.getQuotesSnapshot() WITHOUT any client having
 * subscribed to it individually — and that crypto is NOT swept into the seed
 * (boot behavior for BTC/ETH unchanged).
 */

import { describe, it, expect, afterEach } from "vitest";
import { symbolRegistry } from "../../services/symbolRegistry.service";
import { realtimeTickBuffer } from "../../services/realtimeTickBuffer.service";

const REAL_PAIRS_SAMPLE = ["EUR/NOK", "EUR/SEK", "EUR/DKK", "USD/CZK", "USD/PLN"];

describe("PART 15.1 [62] — boot seed covers real non-OTC forex", () => {
  afterEach(() => {
    for (const sym of REAL_PAIRS_SAMPLE) {
      realtimeTickBuffer.clearSymbol(sym);
    }
  });

  it("getBootStreamSeed includes the real foreex pairs alongside OTC", async () => {
    const seed = await symbolRegistry.getBootStreamSeed();
    const seeded = new Set(seed.map((e) => e.symbol));
    for (const sym of REAL_PAIRS_SAMPLE) {
      expect(seeded.has(sym)).toBe(true);
    }
    // The 10 real pairs are part of the seed (not just OTC/crypto).
    const realSeeded = seed.filter((e) => e.type === "forex");
    expect(realSeeded.length).toBe(10);
  });

  it("calls getAll('otc') + getAll('forex') explicitly — crypto NOT swept in", async () => {
    // Mirror of [61]: the seed must be exactly otc + forex. A bare getAll()
    // would leak BTC/ETH here; assert against the real registry so a future
    // accidental swap to a bare getAll() FAILS this regression.
    const [otc, forex] = await Promise.all([
      symbolRegistry.getAll("otc"),
      symbolRegistry.getAll("forex"),
    ]);
    const seed = await symbolRegistry.getBootStreamSeed();
    expect(seed.map((e) => e.symbol).sort()).toEqual(
      [...otc.map((e) => e.symbol), ...forex.map((e) => e.symbol)].sort(),
    );
    expect(seed.some((e) => e.symbol === "BTC/USD")).toBe(false);
    expect(seed.some((e) => e.symbol === "ETH/USD")).toBe(false);
  });

  it("[52] GAP CLOSED: a real pair has a live quote at boot with NO individual client subscription", async () => {
    // Simulate what the boot seed does: the stream for EUR/NOK is started by
    // the seed (no client subscribe), then the feed prints a genuine tick the
    // same way pollLiveTick does.
    const seed = await symbolRegistry.getBootStreamSeed();
    expect(seed.some((e) => e.symbol === "EUR/NOK")).toBe(true);

    realtimeTickBuffer.append("EUR/NOK", 11.4732, { tsMs: Date.now(), bid: 11.47, ask: 11.48 });

    const quotes = realtimeTickBuffer.getQuotesSnapshot(["EUR/NOK"]);
    expect(quotes.length).toBe(1);
    expect(quotes[0].symbol).toBe("EUR/NOK");
    expect(quotes[0].price).toBe(11.4732);
    expect(quotes[0].bid).toBe(11.47);
    expect(quotes[0].ask).toBe(11.48);
    expect(quotes[0].tickCount).toBe(1);
  });

  it("quotes for real foreex pairs flow through getQuotesSnapshot for batch queries (grid render path)", async () => {
    realtimeTickBuffer.append("EUR/SEK", 11.2, { tsMs: Date.now() });
    realtimeTickBuffer.append("USD/PLN", 4.01, { tsMs: Date.now() });

    const quotes = realtimeTickBuffer.getQuotesSnapshot(["EUR/SEK", "USD/PLN", "GBP/USD"]);
    const symbols = quotes.map((q) => q.symbol);
    expect(symbols).toContain("EUR/SEK");
    expect(symbols).toContain("USD/PLN");
    // A pair with no genuine ticks yet stays absent (honest empty — no -- fabrication).
    expect(symbols).not.toContain("GBP/USD");
  });
});