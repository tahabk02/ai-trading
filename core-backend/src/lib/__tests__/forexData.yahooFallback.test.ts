import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forexDataService } from "../../services/forexData.service";
import type { ForexSpotResult } from "../../services/forexData.service";

/**
 * PART 28.1 [211] — Yahoo Finance intraday fallback contract.
 *
 * The 10 real pairs are fed by the keyless Yahoo chart API. This test pins the
 * automatic tiered fallback that [211] requires documented + proven: when Yahoo
 * fails (429 / shape-drift / blocked), getLiveSpotFresh() MUST continue through
 * Frankfurter (ECB daily) and then open.er-api WITHOUT any manual intervention,
 * and — hard rule — never fabricate a price.
 *
 * The two lower tiers are stubbed so no real network calls run here; the wiring
 * under test is the cascade order + automatic engagement in forexData.service.
 */

type CryMulti = typeof forexDataService;

const YAHOO_OK: ForexSpotResult = {
  success: true,
  price: 11.23456,
  source: "yahoo_finance",
};
const YAHOO_FAIL: ForexSpotResult = {
  success: false,
  price: null,
  source: "yahoo_finance",
  error: "HTTP 429 rate-limited",
};
const FRANK_OK: ForexSpotResult = {
  success: true,
  price: 11.27001,
  source: "frankfurter",
};
const FRANK_FAIL: ForexSpotResult = {
  success: false,
  price: null,
  source: "frankfurter",
  error: "ECB outage",
};
const OPEN_ER_OK: ForexSpotResult = {
  success: true,
  price: 11.25999,
  source: "open_er_api",
};

describe("PART 28.1 [211]: real-pair Yahoo intraday → ECB fallback engages automatically", () => {
  let yahooSpy: ReturnType<typeof vi.fn>;
  let frankSpy: ReturnType<typeof vi.fn>;
  let openErSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    yahooSpy = vi.fn(async (): Promise<ForexSpotResult> => YAHOO_OK);
    frankSpy = vi.fn(async (): Promise<ForexSpotResult> => FRANK_OK);
    openErSpy = vi.fn(async (): Promise<ForexSpotResult> => OPEN_ER_OK);
    const srv = forexDataService as unknown as CryMulti & {
      fetchYahooSpot: unknown;
      fetchFrankfurterSpot: unknown;
      fetchOpenErSpot: unknown;
    };
    srv.fetchYahooSpot = yahooSpy;
    srv.fetchFrankfurterSpot = frankSpy;
    srv.fetchOpenErSpot = openErSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("feeds a real pair from Yahoo intraday and never touches the ECB fallback", async () => {
    const r = await forexDataService.getLiveSpotFresh("EUR/SEK");
    expect(r.success).toBe(true);
    expect(r.price).toBe(11.23456);
    expect(r.source).toBe("yahoo_finance");
    expect(yahooSpy).toHaveBeenCalled();
    expect(frankSpy).not.toHaveBeenCalled();
    expect(openErSpy).not.toHaveBeenCalled();
  });

  it("[211] Yahoo failing (429) automatically falls through to Frankfurter ECB daily", async () => {
    yahooSpy.mockResolvedValue(YAHOO_FAIL);
    const r = await forexDataService.getLiveSpotFresh("EUR/SEK");
    expect(r.success).toBe(true);
    expect(r.source).toBe("frankfurter");
    expect(r.price).toBe(11.27001);
    expect(openErSpy).not.toHaveBeenCalled();
  });

  it("[211] Yahoo AND Frankfurter failing automatically falls through to open.er-api", async () => {
    yahooSpy.mockResolvedValue(YAHOO_FAIL);
    frankSpy.mockResolvedValue(FRANK_FAIL);
    const r = await forexDataService.getLiveSpotFresh("EUR/SEK");
    expect(r.success).toBe(true);
    expect(r.source).toBe("open_er_api");
    expect(r.price).toBe(11.25999);
  });

  it("[211] Yahoo NOT producing a positive price does not short-circuit the cascade", async () => {
    yahooSpy.mockResolvedValue({
      success: false,
      price: null,
      source: "yahoo_finance",
      error: "No positive close on Yahoo tape",
    });
    frankSpy.mockResolvedValue(FRANK_FAIL);
    const r = await forexDataService.getLiveSpotFresh("EUR/SEK");
    expect(r.success).toBe(true);
    expect(r.source).toBe("open_er_api");
    expect(r.price).toBe(11.25999);
  });

  it("[211] an OTC pair is untouched by the Yahoo tier (real-pairs only)", async () => {
    const r = await forexDataService.getLiveSpotFresh("EUR/USD");
    expect(yahooSpy).not.toHaveBeenCalled();
    // EUR/USD is NOT in the 10 real pairs — its tier-zero path is the ECB
    // fallback we stubbed, not Yahoo.
    expect(r.source).toBe("frankfurter");
  });
});