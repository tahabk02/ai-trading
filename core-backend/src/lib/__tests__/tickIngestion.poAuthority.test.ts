/**
 * tickIngestion.poAuthority.test.ts — PART 43.5 [471] REGRESSION.
 *
 * The PO-authority guard used to suppress the HTTP fallback whenever a cached
 * Pocket Option price was younger than a fixed age — even after the PO bridge
 * itself had gone idle / awaiting_ssid / degraded. A stale cached print then
 * permanently starved the single-symbol (Pro Terminal) pipeline: no live_tick
 * → /predict "awaiting live data" → BUILDING HISTORY / EVALUATING HORIZON /
 * execution price "--", while the all-pairs market_quotes grid kept serving
 * the tick buffer's last value.
 *
 * [471] gates BOTH guards on ACTUAL bridge liveness (see
 * isPocketOptionActivelyLive). These tests pin the contract:
 *   • bridge OFFLINE + cached PO print  → fallback MUST author (not starve);
 *   • bridge ONLINE  + covering pair    → fallback suppressed (no divergence);
 *   • bridge ONLINE  + PO-sourced spot  → fallback suppressed;
 *   • bridge ONLINE  + not covering     → fallback authors (normal).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/forexData.service", () => ({
  forexDataService: {
    getLiveSpotFresh: vi.fn(),
    isPocketOptionCovered: vi.fn(),
    appendTick: vi.fn(),
    toCanonicalSymbol: vi.fn((s: string) => s),
  },
}));

vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: { getAssetSubType: vi.fn(() => "otc") },
}));

vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    append: vi.fn(),
    getLatestFreshAgeMs: vi.fn(() => null),
  },
}));

vi.mock("../../services/liveTickSignal.dispatch", () => ({
  liveTickSignalDispatcher: { enqueue: vi.fn() },
}));

vi.mock("../../services/githubData.provider", () => ({
  githubDataProvider: {
    setCallbacks: vi.fn(),
    isRunning: vi.fn(() => true),
    startPolling: vi.fn(),
  },
}));

vi.mock("../../services/pocketOptionBridge.service", () => ({
  pocketOptionBridgeService: {
    isConnected: vi.fn(() => false),
    getStatus: vi.fn(() => "idle"),
  },
}));

vi.mock("../../services/websocket.service", () => {
  const instance = {
    broadcastLiveTick: vi.fn(),
    broadcastEngineStatus: vi.fn(),
    broadcastCandleParity: vi.fn(),
    broadcastFeedStatus: vi.fn(),
    hasActiveSubscribers: vi.fn(() => true),
  };
  return {
    WebSocketService: { getInstance: () => instance },
    websocketService: instance,
    MARKET_TERMINAL_ROOM: "market-terminal",
  };
});

import { tickIngestionService } from "../../services/tickIngestion.service";
import { forexDataService } from "../../services/forexData.service";
import { realtimeTickBuffer } from "../../services/realtimeTickBuffer.service";
import { pocketOptionBridgeService } from "../../services/pocketOptionBridge.service";

const SYMBOL = "EUR/USD";

/** Invoke the private poll directly (bypasses pollLiveTick's schedule gates). */
const pollOnce = () =>
  (tickIngestionService as unknown as { pollOnce: (s: string) => Promise<void> }).pollOnce(
    SYMBOL,
  );

const setBridge = (connected: boolean, status: string) => {
  vi.mocked(pocketOptionBridgeService.isConnected).mockReturnValue(connected);
  (pocketOptionBridgeService.getStatus as ReturnType<typeof vi.fn>).mockReturnValue(
    status,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(forexDataService.getLiveSpotFresh).mockResolvedValue({
    success: true,
    price: 1.2345,
    source: "frankfurter",
  } as never);
  vi.mocked(forexDataService.isPocketOptionCovered).mockReturnValue(false);
});

describe("PART 43.5 [471] — PO-authority guard is gated on bridge liveness", () => {
  it("authors the fallback when the bridge is OFFLINE despite a cached PO print", async () => {
    // Bridge down, but a stale PO price still sits in the cache (the exact
    // starvation window the old guard created).
    setBridge(false, "idle");
    vi.mocked(forexDataService.isPocketOptionCovered).mockReturnValue(true);

    await pollOnce();

    expect(vi.mocked(forexDataService.getLiveSpotFresh)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(realtimeTickBuffer.append)).toHaveBeenCalledTimes(1);
  });

  it("treats awaiting_ssid as not-live and authors the fallback", async () => {
    setBridge(true, "awaiting_ssid");
    vi.mocked(forexDataService.isPocketOptionCovered).mockReturnValue(true);

    await pollOnce();

    expect(vi.mocked(forexDataService.getLiveSpotFresh)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(realtimeTickBuffer.append)).toHaveBeenCalledTimes(1);
  });

  it("does not treat a stale PO-sourced spot as authoritative while offline", async () => {
    setBridge(false, "degraded");
    vi.mocked(forexDataService.getLiveSpotFresh).mockResolvedValue({
      success: true,
      price: 1.1,
      source: "pocket_option_held",
    } as never);

    await pollOnce();

    expect(vi.mocked(realtimeTickBuffer.append)).toHaveBeenCalledTimes(1);
  });
});

// ── Suppression paths (unchanged behaviour while PO is genuinely live) ──
describe("PART 43.5 [471] — divergence protection retained while PO is live", () => {
  it("suppresses the fallback while ONLINE and covering the pair", async () => {
    setBridge(true, "ONLINE");
    vi.mocked(forexDataService.isPocketOptionCovered).mockReturnValue(true);

    await pollOnce();

    // Guard 1 short-circuits before even fetching a spot.
    expect(vi.mocked(forexDataService.getLiveSpotFresh)).not.toHaveBeenCalled();
    expect(vi.mocked(realtimeTickBuffer.append)).not.toHaveBeenCalled();
  });

  it("suppresses a PO-sourced spot while ONLINE (no double-write)", async () => {
    setBridge(true, "ONLINE");
    vi.mocked(forexDataService.isPocketOptionCovered).mockReturnValue(false);
    vi.mocked(forexDataService.getLiveSpotFresh).mockResolvedValue({
      success: true,
      price: 1.1,
      source: "pocket_option_ssot",
    } as never);

    await pollOnce();

    expect(vi.mocked(realtimeTickBuffer.append)).not.toHaveBeenCalled();
  });

  it("still authors while ONLINE but not covering the pair (normal bootstrap)", async () => {
    setBridge(true, "ONLINE");
    vi.mocked(forexDataService.isPocketOptionCovered).mockReturnValue(false);

    await pollOnce();

    expect(vi.mocked(realtimeTickBuffer.append)).toHaveBeenCalledTimes(1);
  });
});
