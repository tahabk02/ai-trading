/**
 * tickIngestion.recoveryStatus.test.ts — PART 44 [496] PROVENANCE-GATED
 * RECOVERY BROADCAST.
 *
 * When the HTTP cascade "recovers" an OTC pair onto a NON-PO source, the
 * engine must broadcast DEGRADED ("PO offline (proxy prices)") — never ONLINE
 * — and must keep the DEGRADED latch armed so the imminent genuine Pocket
 * Option print still flips the engine back to ONLINE exactly once.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/forexData.service", () => ({
  forexDataService: {
    getLiveSpotFresh: vi.fn(),
    isPocketOptionCovered: vi.fn(),
    isRecoveryMode: vi.fn(() => false),
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
  liveTickSignalDispatcher: {
    enqueue: vi.fn(),
    notifyFeedDegraded: vi.fn(),
  },
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

vi.mock("../../lib/feedMetrics", () => ({
  feedMetrics: {
    countRetry: vi.fn(),
    countError: vi.fn(),
    setBackoffMs: vi.fn(),
    setMaxConsecutiveErrors: vi.fn(),
    countRecovery: vi.fn(),
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
import { websocketService } from "../../services/websocket.service";

const SYMBOL = "EUR/USD";

const wsModule = vi.mocked(websocketService);

/** The ingestion service is a module singleton — reset its private per-symbol
 *  latch/error state so tests do not leak incidents into one another. */
const serviceState = () =>
  tickIngestionService as unknown as {
    streamDegraded: Map<string, boolean>;
    streamDegradedProxy: Map<string, boolean>;
    streamConsecutiveErrors: Map<string, number>;
    nextAllowedPollAt: Map<string, number>;
    marketClosedUntil: Map<string, number>;
    marketClosedLatched: Set<string>;
  };

const handleFeedFailure = (detail: string) =>
  (
    tickIngestionService as unknown as {
      handleFeedFailure: (s: string, d: string) => void;
    }
  ).handleFeedFailure(SYMBOL, detail);

const pollOnce = () =>
  (tickIngestionService as unknown as { pollOnce: (s: string) => Promise<void> }).pollOnce(
    SYMBOL,
  );

beforeEach(() => {
  const state = serviceState();
  state.streamDegraded.clear();
  state.streamDegradedProxy.clear();
  state.streamConsecutiveErrors.clear();
  state.nextAllowedPollAt.clear();
  state.marketClosedUntil.clear();
  state.marketClosedLatched.clear();
  vi.clearAllMocks();
  vi.mocked(forexDataService.getLiveSpotFresh).mockResolvedValue({
    success: true,
    price: 1.2345,
    source: "frankfurter",
  } as never);
  vi.mocked(forexDataService.isPocketOptionCovered).mockReturnValue(false);
});

describe("PART 44 [496] — OTC proxy recovery never broadcasts ONLINE", () => {
  /**
   * Drive 5 consecutive failures so the DEGRADED latch is set and the incident
   * is "open"; the next successful probe then exercises the recovery branch.
   */
  const openDegradedIncident = () => {
    for (let i = 0; i < 5; i++) handleFeedFailure("live source exhausted");
  };

  it("broadcasts DEGRADED (PO offline · proxy prices), not ONLINE, on a non-PO recovery", async () => {
    openDegradedIncident();
    wsModule.broadcastEngineStatus.mockClear();

    // First successful probe arrives from the HTTP cascade (Frankfurter).
    await pollOnce();

    expect(realtimeTickBuffer.append).toHaveBeenCalledTimes(1);
    expect(wsModule.broadcastEngineStatus).toHaveBeenCalledTimes(1);
    const [status, message] = wsModule.broadcastEngineStatus.mock.calls[0];
    expect(status).toBe("DEGRADED");
    expect(String(message)).toContain("PO offline (proxy prices)");
  });

  it("keeps the degraded latch armed so the genuine PO print still flips ONLINE", async () => {
    openDegradedIncident();
    wsModule.broadcastEngineStatus.mockClear();

    // 1. Proxy recovery → DEGRADED once, latch STAYS set.
    await pollOnce(); // source frankfurter
    expect(wsModule.broadcastEngineStatus.mock.calls.map((c) => c[0])).toEqual(["DEGRADED"]);

    // 2. Second proxy probe → silent (degraded message fires once per incident).
    wsModule.broadcastEngineStatus.mockClear();
    await pollOnce();
    expect(wsModule.broadcastEngineStatus).not.toHaveBeenCalled();

    // 3. A genuine PO-sourced print now recovers → ONLINE exactly once, latch clears.
    wsModule.broadcastEngineStatus.mockClear();
    vi.mocked(forexDataService.getLiveSpotFresh).mockResolvedValue({
      success: true,
      price: 1.3111,
      source: "pocket_option_ssot",
    } as never);
    await pollOnce();
    expect(wsModule.broadcastEngineStatus).toHaveBeenCalledTimes(1);
    const [status, message] = wsModule.broadcastEngineStatus.mock.calls[0];
    expect(status).toBe("ONLINE");
    expect(String(message)).toContain("restored");
  });
});