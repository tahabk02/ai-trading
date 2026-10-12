/**
 * tickIngestion.feedState.test.ts — PART 44 [497] per-symbol feed-state LOG LEVEL.
 *
 * The expected-state downgrade (INFO) is OTC-scoped: an OTC pair may treat
 * PO-offline / sources-exhausted as a known proxy condition, but a REAL pair
 * whose sources are exhausted WHILE THE MARKET IS OPEN is a genuine outage and
 * must stay at ERROR level. This drives the real poll loop (market-open,
 * non-OTC) so the level is proven end-to-end, not just in the pure classifier.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/marketSchedule", () => ({
  // Market OPEN: the poll loop must reach the probe (not divert to market-closed).
  isForexMarketClosed: vi.fn(() => false),
}));

vi.mock("../../services/forexData.service", () => ({
  forexDataService: {
    getLiveSpotFresh: vi.fn(),
    isPocketOptionCovered: vi.fn(() => false),
    isRecoveryMode: vi.fn(() => false),
    appendTick: vi.fn(),
    toCanonicalSymbol: vi.fn((s: string) => s),
  },
}));

vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: { getAssetSubType: vi.fn(() => "forex") },
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
import { symbolRegistry } from "../../services/symbolRegistry.service";
import { feedStateReporter } from "../../lib/feedStateLog";
import { logger } from "../../utils/logger";

const REAL = "EUR/SEK"; // non-OTC pair
const OTC = "EUR/USD_otc";

const poll = (symbol: string) =>
  (
    tickIngestionService as unknown as { pollOnce: (s: string) => Promise<void> }
  ).pollOnce(symbol);

const stateLines = () =>
  vi
    .mocked(logger.error)
    .mock.calls.filter((c) => c[0] === "[TickIngestion] Live market feed state")
    .map((c) => c[1] as { symbol: string; state: string });

const infoStateLines = () =>
  vi
    .mocked(logger.info)
    .mock.calls.filter((c) => c[0] === "[TickIngestion] Live market feed state")
    .map((c) => c[1] as { symbol: string; state: string });

beforeEach(() => {
  vi.clearAllMocks();
  feedStateReporter.reset();
  vi.mocked(symbolRegistry.getAssetSubType).mockReturnValue("forex");
  vi.mocked(forexDataService.getLiveSpotFresh).mockResolvedValue({
    success: false,
    error: "all live spot rate sources exhausted",
  } as never);
});

describe("PART 44 [497] — REAL pair, market open, sources exhausted → ERROR", () => {
  it("logs the failure at ERROR (feed_error) for a REAL pair whose sources are exhausted", async () => {
    await poll(REAL);
    const lines = stateLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ symbol: REAL, state: "feed_error" });
    // And NOT downgraded to an info-level expected state.
    expect(infoStateLines()).toHaveLength(0);
  });

  it("downgrades the SAME diagnostic to INFO (po_offline) for an OTC pair", async () => {
    vi.mocked(symbolRegistry.getAssetSubType).mockReturnValue("otc");
    await poll(OTC);
    const info = infoStateLines();
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ symbol: OTC, state: "po_offline" });
    expect(stateLines()).toHaveLength(0);
  });
});
