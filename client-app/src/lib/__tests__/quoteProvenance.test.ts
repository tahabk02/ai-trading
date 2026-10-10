/**
 * quoteProvenance.test.ts — PART 38.2 [384].
 *
 * Pure label/tooltip derivation for the quote-origin chip. The contract is
 * deliberately conservative: when the payload predates provenance tracking,
 * or when the backend says the price is stale, the card must NOT be able to
 * render a held/fallback print as a live one.
 */
import { describe, it, expect } from "vitest";

import {
  quoteProvenance,
  QUOTE_PROVENANCE_STALE_MS,
} from "@/lib/quoteProvenance";

const live = (source: string) => ({
  source,
  stale: false,
  staleLive: false,
  freshAgeMs: 420,
  ageMs: 420,
});

describe("[384] quoteProvenance", () => {
  it("labels a genuine Pocket Option tick as PO LIVE", () => {
    const p = quoteProvenance(live("pocket_option_ssot"));
    expect(p.label).toBe("PO LIVE");
    expect(p.tone).toBe("live");
    expect(p.title).toMatch(/Pocket Option live tick/);
  });

  it("strips the HTTP `:live` stamp before classifying", () => {
    const p = quoteProvenance(live("frankfurter:live"));
    expect(p.label).toBe("FRANKFURTER");
    expect(p.tone).toBe("fallback");
    expect(p.title).toBe("Fallback: Frankfurter ECB reference rates");
  });

  it("labels every REST fallback tier honestly", () => {
    expect(quoteProvenance(live("open_er_api")).label).toBe("ER-API");
    expect(quoteProvenance(live("yahoo_finance")).label).toBe("YAHOO");
    expect(quoteProvenance(live("github_repo_cached")).label).toBe("GITHUB");
    expect(quoteProvenance(live("coingecko")).tone).toBe("fallback");
  });

  it("a staleLive quote is a HELD price with its age — never live", () => {
    const p = quoteProvenance({
      source: "frankfurter",
      stale: false,
      staleLive: true,
      freshAgeMs: 123_000,
      ageMs: 123_000,
    });
    expect(p.tone).toBe("held");
    expect(p.label).toBe("HELD 123s");
    expect(p.title).toMatch(/No live tick for 123s/);
    expect(p.label).not.toContain("FRANKFURTER");
  });

  it("a held print behind a fresh-looking ageMs is still held", () => {
    // This is the pre-provenance lie: ageMs = 0 because the newest ENTRY is a
    // held print re-pended seconds ago, while nothing real arrived for an hour.
    const p = quoteProvenance({
      source: "last_known_real",
      stale: true,
      staleLive: true,
      freshAgeMs: null,
      ageMs: 400,
    });
    expect(p.tone).toBe("held");
    expect(p.label).toMatch(/^HELD /);
    expect(p.title).toMatch(/not a current market price/);
  });

  it("never invents a source for a payload that predates provenance", () => {
    const p = quoteProvenance({
      source: null,
      stale: false,
      staleLive: false,
      freshAgeMs: 300,
      ageMs: 300,
    });
    expect(p.tone).toBe("unknown");
    expect(p.label).toBe("UNKNOWN SRC");
  });

  it("staleness floor matches the backend's 15s contract", () => {
    expect(QUOTE_PROVENANCE_STALE_MS).toBe(15_000);
    expect(
      quoteProvenance({
        source: "frankfurter",
        stale: false,
        staleLive: false,
        freshAgeMs: QUOTE_PROVENANCE_STALE_MS,
        ageMs: QUOTE_PROVENANCE_STALE_MS,
      }).tone,
    ).toBe("fallback");
  });

  it("[422] a market-closed REAL quote is its own state, never HELD or live", () => {
    const p = quoteProvenance({
      source: "market_closed_last_close",
      stale: true,
      staleLive: true,
      freshAgeMs: null,
      ageMs: 3_600_000,
      marketClosed: true,
      lastTickAt: "2026-10-09T20:59:00.000Z",
    });
    expect(p.tone).toBe("closed");
    expect(p.label).toBe("MARKET CLOSED");
    expect(p.title).toMatch(/last close \(20:59 UTC\)/);
    expect(p.label).not.toContain("HELD");
  });
});
