import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forexDataService } from "../../services/forexData.service";
import type { ForexSpotResult } from "../../services/forexData.service";

/**
 * Spot-rate exhaustion resilience contract.
 *
 * Proves the three behaviours the ingestion loop depends on when EVERY live
 * source dies at once (pocket_option_ssot / github_repo_cached / frankfurter /
 * open_er_api):
 *   1. LAST KNOWN GOOD is served (not withheld) for a real observed print
 *      inside the hold window — flagged `stale` with its real age, never
 *      presented as fresh and never synthesised.
 *   2. Beyond the hold window the service returns an honest failure rather
 *      than an arbitrarily old price.
 *   3. A repeatedly failing fallback tier is SKIPPED (circuit breaker) so a
 *      dead endpoint can no longer spend the whole poll budget on timeouts.
 *
 * No network runs here: the tier fetchers are stubbed on the singleton, exactly
 * as the PART 28.1 cascade test does.
 */

type CryMulti = typeof forexDataService;

interface Internals {
  fetchFrankfurterSpot: unknown;
  fetchOpenErSpot: unknown;
  updateSpotCache: unknown;
  lastSpotCache: Map<string, { price: number; ts: number }>;
  sourceHealth: Map<string, unknown>;
  chainAuditLastLogAt: Map<string, number>;
}

const FRANK_FAIL: ForexSpotResult = {
  success: false,
  price: null,
  source: "frankfurter",
  error: "timeout of 5000ms exceeded",
};
const OPEN_ER_FAIL: ForexSpotResult = {
  success: false,
  price: null,
  source: "open_er_api",
  error: "timeout of 5000ms exceeded",
};

const srv = forexDataService as unknown as CryMulti & Internals;

function seedHeld(symbol: string, price: number, ageMs: number): void {
  srv.lastSpotCache.set(symbol, { price, ts: Date.now() - ageMs });
}

describe("spot-rate exhaustion: last known good + circuit breaker", () => {
  let frankSpy: ReturnType<typeof vi.fn>;
  let openErSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    frankSpy = vi.fn(async (): Promise<ForexSpotResult> => FRANK_FAIL);
    openErSpy = vi.fn(async (): Promise<ForexSpotResult> => OPEN_ER_FAIL);
    srv.fetchFrankfurterSpot = frankSpy;
    srv.fetchOpenErSpot = openErSpy;
    // The service is a singleton shared across this file: reset the breaker
    // state so each test starts from a cold, fully-probed cascade.
    srv.sourceHealth.clear();
    srv.chainAuditLastLogAt.clear();
    srv.lastSpotCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves the last genuinely observed print when every live source fails", async () => {
    seedHeld("EUR/USD", 1.08512, 30_000);

    const r = await forexDataService.getLiveSpotFresh("EUR/USD");

    expect(r.success).toBe(true);
    expect(r.price).toBe(1.08512);
    expect(r.source).toBe("held_stale_real");
    // Flagged as held with its REAL age — a consumer must be able to refuse it.
    expect(r.stale).toBe(true);
    expect(r.ageMs).toBeGreaterThanOrEqual(30_000);
    expect(frankSpy).toHaveBeenCalled();
  });

  it("refuses the held print once it is older than the hold window", async () => {
    seedHeld("GBP/USD", 1.27104, 200_000);

    const r = await forexDataService.getLiveSpotFresh("GBP/USD");

    expect(r.success).toBe(false);
    expect(r.price).toBeNull();
    expect(r.source).toBe("none");
    expect(r.error).toContain("exhausted");
  });

  it("never invents a price when nothing was ever observed", async () => {
    const r = await forexDataService.getLiveSpotFresh("USD/CHF");

    expect(r.success).toBe(false);
    expect(r.price).toBeNull();
    expect(r.source).toBe("none");
  });

  it("skips a repeatedly failing tier instead of blocking on its timeouts", async () => {
    // Arm the breaker: 3 consecutive failures per tier (default threshold).
    for (let i = 0; i < 3; i += 1) {
      await forexDataService.getLiveSpotFresh("AUD/USD");
    }
    const frankCalls = frankSpy.mock.calls.length;
    const openErCalls = openErSpy.mock.calls.length;
    expect(frankCalls).toBe(3);
    expect(openErCalls).toBe(3);

    // 4th probe inside the cooldown window: neither tier opens a socket.
    const r = await forexDataService.getLiveSpotFresh("AUD/USD");

    expect(frankSpy.mock.calls.length).toBe(frankCalls);
    expect(openErSpy.mock.calls.length).toBe(openErCalls);
    expect(r.success).toBe(false);
    expect(r.source).toBe("none");
  });

  it("refreshes the freshness clock when a source re-reports an unchanged price", async () => {
    const first = Date.now();
    (srv.updateSpotCache as (s: string, p: number) => void)("USD/CHF", 0.79);
    await new Promise((r) => setTimeout(r, 5));
    (srv.updateSpotCache as (s: string, p: number) => void)("USD/CHF", 0.79);

    const entry = srv.lastSpotCache.get("USD/CHF");
    expect(entry?.price).toBe(0.79);
    // A flat rate must not age out of the freshness gates as if it were dead.
    expect(entry!.ts).toBeGreaterThan(first);
    expect(Date.now() - entry!.ts).toBeLessThan(15_000);

    const spot = await forexDataService.getLiveSpotFresh("USD/CHF");
    expect(spot.source).toBe("github_repo_cached");
  });
});
