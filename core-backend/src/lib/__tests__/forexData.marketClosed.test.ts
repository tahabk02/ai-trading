import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forexDataService } from "../../services/forexData.service";
import type { ForexSpotResult } from "../../services/forexData.service";

/**
 * PART 42.1 [421]/[423] — MARKET-CLOSED IS A STATE, NOT AN ERROR LOOP.
 *
 * A REAL (assetSubType "forex") pair must return a "last close" — flagged
 * `stale` + `marketClosed` and NEVER live — while the weekly forex market is
 * closed, and must resume the normal cascade once it reopens. OTC instruments
 * are 24/7 and must be completely unaffected.
 *
 * No network runs: the tier fetchers are stubbed on the singleton, and the
 * clock is frozen with fake timers so weekend/open instants are deterministic.
 */

type CryMulti = typeof forexDataService;

interface Internals {
  fetchFrankfurterSpot: unknown;
  fetchYahooSpot: unknown;
  lastSpotCache: Map<string, { price: number; ts: number }>;
  sourceHealth: Map<string, unknown>;
  chainAuditLastLogAt: Map<string, number>;
}

const srv = forexDataService as unknown as CryMulti & Internals;

// 2026-10-09 is a Friday, 2026-10-10 Saturday, 2026-10-11 Sunday, 2026-10-12
// Monday. New York is EDT (UTC-4) on these dates, so 17:00 ET = 21:00 UTC.
const FRI_BEFORE_CLOSE = "2026-10-09T20:59:00.000Z";
const FRI_AFTER_CLOSE = "2026-10-09T21:00:00.000Z";
const SATURDAY = "2026-10-10T15:00:00.000Z";
const SUNDAY_BEFORE_OPEN = "2026-10-11T20:59:00.000Z";
const MONDAY_OPEN = "2026-10-12T12:00:00.000Z";

function freezeAt(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe("[421] REAL pair spot chain honours the weekly market schedule", () => {
  beforeEach(() => {
    srv.lastSpotCache.clear();
    srv.sourceHealth.clear();
    srv.chainAuditLastLogAt.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the LAST CLOSE (stale, never live) for a REAL pair on a weekend", async () => {
    freezeAt(SATURDAY);
    srv.lastSpotCache.set("EUR/SEK", { price: 11.111, ts: Date.now() - 3_600_000 });
    // If the gate leaked, this stub would prove a fetch happened — it must not.
    const frank = vi.fn(async (): Promise<ForexSpotResult> => ({
      success: true,
      price: 99,
      source: "frankfurter",
    }));
    srv.fetchFrankfurterSpot = frank;

    const r = await forexDataService.getLiveSpotFresh("EUR/SEK");

    expect(r.marketClosed).toBe(true);
    expect(r.source).toBe("market_closed_last_close");
    expect(r.price).toBe(11.111);
    // [423] the closed state NEVER serves the held price as live.
    expect(r.stale).toBe(true);
    expect(r.ageMs).toBeGreaterThanOrEqual(3_600_000);
    expect(frank).not.toHaveBeenCalled();
  });

  it("gates the Friday close and the Sunday pre-open boundary", async () => {
    srv.lastSpotCache.set("EUR/NOK", { price: 12, ts: Date.now() - 1_000 });

    freezeAt(FRI_BEFORE_CLOSE);
    expect((await forexDataService.getLiveSpotFresh("EUR/NOK")).marketClosed).toBeUndefined();

    freezeAt(FRI_AFTER_CLOSE);
    expect((await forexDataService.getLiveSpotFresh("EUR/NOK")).marketClosed).toBe(true);

    freezeAt(SUNDAY_BEFORE_OPEN);
    expect((await forexDataService.getLiveSpotFresh("EUR/NOK")).marketClosed).toBe(true);
  });

  it("runs the normal cascade for a REAL pair once the market reopens (Monday)", async () => {
    freezeAt(MONDAY_OPEN);
    const yahoo = vi.fn(async (): Promise<ForexSpotResult> => ({
      success: true,
      price: 11.2345,
      source: "yahoo_finance",
    }));
    srv.fetchYahooSpot = yahoo;

    const r = await forexDataService.getLiveSpotFresh("EUR/SEK");

    expect(r.success).toBe(true);
    expect(r.source).toBe("yahoo_finance");
    expect(r.marketClosed).toBeUndefined();
    expect(r.stale).toBeUndefined();
    expect(yahoo).toHaveBeenCalled();
  });

  it("[423] an OTC symbol on a weekend is UNAFFECTED — 24/7", async () => {
    freezeAt(SATURDAY);
    const frank = vi.fn(async (): Promise<ForexSpotResult> => ({
      success: true,
      price: 1.0851,
      source: "frankfurter",
    }));
    srv.fetchFrankfurterSpot = frank;

    const r = await forexDataService.getLiveSpotFresh("EUR/USD");

    expect(r.marketClosed).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.source).toBe("frankfurter");
    expect(frank).toHaveBeenCalled();
  });

  it("returns no price (and no error) when a closed REAL pair was never observed", async () => {
    freezeAt(SATURDAY);
    const r = await forexDataService.getLiveSpotFresh("USD/SEK");
    expect(r.marketClosed).toBe(true);
    expect(r.success).toBe(false);
    expect(r.price).toBeNull();
    expect(r.source).toBe("market_closed");
    expect(r.error).toBeUndefined();
  });
});
