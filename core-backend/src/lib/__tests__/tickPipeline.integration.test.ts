import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/forexData.service", () => ({
  forexDataService: {
    toCanonicalSymbol: vi.fn((s: string) =>
      s.trim().toUpperCase() === "EURUSD" ? "EUR/USD" : s.trim().toUpperCase(),
    ),
    setPocketOptionPrice: vi.fn(),
    appendTick: vi.fn(),
  },
}));

vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: {
    getAssetSubType: vi.fn(() => "otc"),
    isValidSymbolSync: vi.fn(() => true),
  },
}));

vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    append: vi.fn(),
    getLatestFreshAgeMs: vi.fn(() => null),
  },
}));

vi.mock("../../services/marketSnapshot.service", () => ({
  marketSnapshotService: { recordTick: vi.fn(), recordCandle: vi.fn() },
}));

vi.mock("../../services/liveTickSignal.dispatch", () => ({
  liveTickSignalDispatcher: { enqueue: vi.fn() },
}));

vi.mock("../../services/githubData.provider", () => ({
  githubDataProvider: {
    setCallbacks: vi.fn(),
    isRunning: vi.fn(() => true),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
  },
}));

vi.mock("../../services/pocketOptionBridge.service", () => ({
  pocketOptionBridgeService: {
    isConnected: vi.fn(() => true),
    getStatus: vi.fn(() => "ONLINE"),
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
import { marketSnapshotService } from "../../services/marketSnapshot.service";
import { websocketService } from "../../services/websocket.service";
import { realtimeCandleAggregatorService } from "../../services/realtimeCandleAggregator.service";
import { SERVER_CANDLE_TFS } from "../../services/realtimeCandleAggregator.service";

const TS = "2026-11-01T12:00:00.000Z";
const TS_MS = Date.parse(TS);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Pocket Option tick fan-out", () => {
  it("preserves real bid/ask/volume and the PO timestamp end to end", () => {
    tickIngestionService.ingestTick(
      "EURUSD",
      1.1002,
      "pocket_option",
      TS,
      "otc",
      { seq: 9, tsUtc: TS_MS, receivedUtcMs: TS_MS + 12 },
      { bid: 1.1001, ask: 1.1003, volume: 42 },
    );

    expect(forexDataService.setPocketOptionPrice).toHaveBeenCalledWith(
      "EUR/USD",
      1.1002,
      1.1001,
      1.1003,
    );

    expect(websocketService.broadcastLiveTick).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "EUR/USD",
        price: 1.1002,
        bid: 1.1001,
        ask: 1.1003,
        volume: 42,
        timestamp: TS,
        source: "pocket_option",
        assetType: "otc",
        seq: 9,
      }),
    );

    expect(realtimeTickBuffer.append).toHaveBeenCalledWith(
      "EUR/USD",
      1.1002,
      expect.objectContaining({
        bid: 1.1001,
        ask: 1.1003,
        volume: 42,
        tsMs: TS_MS,
        source: "pocket_option",
      }),
    );

    expect(forexDataService.appendTick).toHaveBeenCalledWith(
      "EUR/USD",
      1.1002,
      expect.objectContaining({
        bid: 1.1001,
        ask: 1.1003,
        volume: 42,
        tsMs: TS_MS,
      }),
    );

    expect(marketSnapshotService.recordTick).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "EUR/USD",
        price: 1.1002,
        bid: 1.1001,
        ask: 1.1003,
        volume: 42,
        tsMs: TS_MS,
        source: "pocket_option",
        assetType: "otc",
      }),
    );
  });

  it("drops a crossed book instead of broadcasting an invented spread", () => {
    tickIngestionService.ingestTick(
      "EURUSD",
      1.1002,
      "pocket_option",
      TS,
      "otc",
      undefined,
      { bid: 1.1005, ask: 1.1001, volume: 3 },
    );

    const tick = vi.mocked(websocketService.broadcastLiveTick).mock.calls[0][0];
    expect(tick.bid).toBeUndefined();
    expect(tick.ask).toBeUndefined();
    expect(tick.volume).toBe(3);
    expect(forexDataService.setPocketOptionPrice).toHaveBeenCalledWith(
      "EUR/USD",
      1.1002,
      undefined,
      undefined,
    );
  });
});

describe("M20 / 20-second candle builders", () => {
  it("registers S20 and resolves the M20/20s aliases", () => {
    expect(SERVER_CANDLE_TFS).toContain("S20");
    expect(realtimeCandleAggregatorService.canonicalTimeframe("m20")).toBe(
      "S20",
    );
    expect(realtimeCandleAggregatorService.canonicalTimeframe("20s")).toBe(
      "S20",
    );
  });

  it("seals a tick-built S20 candle on the 20-second grid", () => {
    const symbol = "EUR/USD";
    const base = 1_700_000_000_000;
    realtimeCandleAggregatorService.removeSymbol(symbol);
    realtimeCandleAggregatorService.addTick(symbol, 1.1, base);
    realtimeCandleAggregatorService.addTick(symbol, 1.2, base + 10_000);
    realtimeCandleAggregatorService.addTick(symbol, 1.3, base + 20_000);
    realtimeCandleAggregatorService.addTick(symbol, 1.4, base + 40_000);

    const closed = realtimeCandleAggregatorService.getClosedHistory(
      symbol,
      "M20",
    );
    expect(closed).not.toBeNull();
    expect(closed!.length).toBe(2);
    expect(closed![0]).toMatchObject({
      timeframe: "S20",
      timestamp: base,
      open: 1.1,
      close: 1.2,
      isFinal: true,
    });
    expect(closed![1]).toMatchObject({
      timestamp: base + 20_000,
      close: 1.3,
    });
    expect(closed!.every((c) => c.timestamp % 20_000 === 0)).toBe(true);
    realtimeCandleAggregatorService.removeSymbol(symbol);
  });
});
