/**
 * standaloneFeed.test.ts — STANDALONE SaaS MODE fallback feed.
 *
 * Covers the two guarantees that matter:
 *   1. AUTHORITY — the emitter stands down (no tick, feed_status "live") the
 *      instant the PO bridge reports a genuine live feed.
 *   2. HYBRID TAPE — real public proxy for non-OTC, labeled synthetic for OTC,
 *      and the synthetic walk never leaves its band around the real anchor.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/secrets", () => ({
  default: {
    STANDALONE_FEED_ENABLED: true,
    STANDALONE_SYNTHETIC_OTC: true,
  },
}));

vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: { getAll: vi.fn(async () => []) },
}));

vi.mock("../../services/forexData.service", () => ({
  forexDataService: { getLiveSpotFresh: vi.fn() },
}));

vi.mock("../../services/pocketOptionBridge.service", () => ({
  pocketOptionBridgeService: {
    getCurrentFeedStatus: vi.fn(() => ({ status: "awaiting_ssid", heartbeatAgeMs: 0 })),
  },
}));

vi.mock("../../services/websocket.service", () => {
  const instance = {
    broadcastLiveTick: vi.fn(),
    broadcastFeedStatus: vi.fn(),
  };
  return { websocketService: instance };
});

vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: { append: vi.fn() },
}));

import {
  standaloneFeedService,
  nextSyntheticPrice,
} from "../../services/standaloneFeed.service";
import { symbolRegistry } from "../../services/symbolRegistry.service";
import { forexDataService } from "../../services/forexData.service";
import { pocketOptionBridgeService } from "../../services/pocketOptionBridge.service";
import { websocketService } from "../../services/websocket.service";
import { realtimeTickBuffer } from "../../services/realtimeTickBuffer.service";
import { standaloneState } from "../../lib/standaloneState";

const getAll = symbolRegistry.getAll as unknown as ReturnType<typeof vi.fn>;
const getSpot = forexDataService.getLiveSpotFresh as unknown as ReturnType<typeof vi.fn>;
const getFeed = pocketOptionBridgeService.getCurrentFeedStatus as unknown as ReturnType<typeof vi.fn>;
const liveTick = websocketService.broadcastLiveTick as unknown as ReturnType<typeof vi.fn>;
const feedStatus = websocketService.broadcastFeedStatus as unknown as ReturnType<typeof vi.fn>;
const bufferAppend = realtimeTickBuffer.append as unknown as ReturnType<typeof vi.fn>;

const entry = (symbol: string, assetSubType: string, digits = 5) => ({
  symbol,
  name: symbol,
  type: assetSubType,
  assetSubType,
  digits,
});

const beat = () =>
  (standaloneFeedService as unknown as { beat: () => Promise<void> }).beat();

function resetService(): void {
  const svc = standaloneFeedService as unknown as {
    universe: unknown[];
    synth: Map<string, unknown>;
    lastMode: unknown;
  };
  svc.universe = [];
  svc.synth.clear();
  svc.lastMode = null;
  standaloneState.reset();
}

describe("nextSyntheticPrice", () => {
  const anchor = 1.0;

  it("always stays inside the bounded band around the anchor", () => {
    let price = anchor;
    for (let i = 0; i < 5000; i++) {
      price = nextSyntheticPrice(price, anchor, Math.random);
      expect(price).toBeGreaterThan(anchor * (1 - 0.005) - 1e-9);
      expect(price).toBeLessThan(anchor * (1 + 0.005) + 1e-9);
    }
  });

  it("mean-reverts toward the anchor (noise disabled)", () => {
    const params = { stepPct: 0, maxDriftPct: 0.005, meanRevert: 0.03 };
    const below = anchor * 0.998;
    const nextBelow = nextSyntheticPrice(below, anchor, Math.random, params);
    expect(nextBelow).toBeGreaterThan(below);

    const above = anchor * 1.002;
    const nextAbove = nextSyntheticPrice(above, anchor, Math.random, params);
    expect(nextAbove).toBeLessThan(above);
  });

  it("never returns a non-positive or non-finite price", () => {
    for (let i = 0; i < 500; i++) {
      const p = nextSyntheticPrice(anchor, anchor, () => Math.random());
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(0);
    }
  });
});

describe("StandaloneFeedService", () => {
  beforeEach(() => {
    resetService();
    vi.clearAllMocks();
    getAll.mockResolvedValue([entry("EUR/SEK", "forex"), entry("EUR/USD", "otc")]);
    getSpot.mockImplementation(async (symbol: string) => {
      if (symbol === "EUR/SEK") return { success: true, price: 10.55512, source: "frankfurter" };
      if (symbol === "EUR/USD") return { success: true, price: 1.08321, source: "frankfurter" };
      return { success: false, price: null, source: "none" };
    });
    getFeed.mockReturnValue({ status: "awaiting_ssid", heartbeatAgeMs: 0 });
  });

  it("stands down entirely while the PO bridge is live", async () => {
    getFeed.mockReturnValue({ status: "live", heartbeatAgeMs: 0 });
    await beat();
    expect(liveTick).not.toHaveBeenCalled();
    expect(standaloneState.isActive()).toBe(false);
    expect(feedStatus).toHaveBeenCalledWith("live");
  });

  it("authors a hybrid tape (real proxy + labeled synthetic) when PO is not live", async () => {
    await beat();

    expect(liveTick).toHaveBeenCalledTimes(2);

    const proxy = liveTick.mock.calls.find((c) => c[0].symbol === "EUR/SEK")[0];
    expect(proxy.source).toBe("standalone:frankfurter");
    expect(proxy.synthetic).toBeUndefined();
    expect(proxy.price).toBeCloseTo(10.55512, 5);

    const synth = liveTick.mock.calls.find((c) => c[0].symbol === "EUR/USD")[0];
    expect(synth.source).toBe("standalone_synthetic");
    expect(synth.synthetic).toBe(true);
    expect(synth.price).toBeGreaterThan(0);

    const s = standaloneState.get();
    expect(s.active).toBe(true);
    expect(s.mode).toBe("mixed");
    expect(s.proxyPairs).toBe(1);
    expect(s.syntheticPairs).toBe(1);

    expect(feedStatus).toHaveBeenCalledWith("standalone", expect.anything());
  });

  it("stamps the synthetic provenance into the tick buffer", async () => {
    getSpot.mockResolvedValue({ success: false, price: null, source: "none" });
    await beat();
    const synthCall = bufferAppend.mock.calls.find((c) => c[0] === "EUR/USD");
    expect(synthCall[2]).toMatchObject({ synthetic: true, source: "standalone_synthetic" });
  });

  it("uses proxy-only mode when the universe has no OTC pairs", async () => {
    getAll.mockResolvedValue([entry("EUR/SEK", "forex")]);
    await beat();
    expect(liveTick).toHaveBeenCalledTimes(1);
    expect(standaloneState.get().mode).toBe("standalone_proxy");
  });

  it("uses synthetic-only mode when no proxy print is available", async () => {
    getAll.mockResolvedValue([entry("EUR/USD", "otc")]);
    getSpot.mockResolvedValue({ success: false, price: null, source: "none" });
    await beat();
    expect(liveTick).toHaveBeenCalledTimes(1);
    expect(liveTick.mock.calls[0][0].synthetic).toBe(true);
    expect(standaloneState.get().mode).toBe("standalone_synthetic");
  });

  it("never fabricates a non-OTC price from a stale/market-closed print", async () => {
    getAll.mockResolvedValue([entry("EUR/SEK", "forex")]);
    getSpot.mockResolvedValue({ success: true, price: 10.5, source: "frankfurter", stale: true });
    await beat();
    expect(liveTick).not.toHaveBeenCalled();
    expect(standaloneState.get().proxyPairs).toBe(0);
  });

  it("re-emits the standalone feed_status every beat (heartbeat freshness)", async () => {
    await beat();
    await beat();
    const standaloneCalls = feedStatus.mock.calls.filter((c) => c[0] === "standalone");
    // Every beat must refresh the frame — the client's heartbeat-age sweep would
    // otherwise flip a perfectly healthy standalone feed to "disconnected".
    expect(standaloneCalls).toHaveLength(2);
    expect(standaloneCalls[0][1]).toMatchObject({
      feedMode: "mixed",
      proxyPairs: 1,
      syntheticPairs: 1,
    });
  });
});
