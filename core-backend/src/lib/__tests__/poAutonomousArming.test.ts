import { describe, it, expect, vi, beforeEach } from "vitest";
import { canonicalizeSymbol } from "../../utils/symbolFormat";

/**
 * PART 50 [HEADLESS-PO-FEED] — the backend-side bridge must arm the FULL
 * PO-listed universe as SERVER-OWNED streams, INDEPENDENT of any browser, and
 * must never release one when a client disconnects. These are the invariants
 * that keep the live tape + server-aggregated candles flowing with zero clients
 * attached (the "PO OFFLINE / frozen chart when no browser is open" stall).
 *
 * The bridge client is exercised in isolation: every heavyweight collaborator
 * (tick ingestion, websocket fan-out, symbol registry, auth, logger, secrets)
 * is mocked, and canonicalisation delegates to the real pure `canonicalizeSymbol`
 * so the symbol contract under test is byte-faithful.
 */

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/secrets", () => ({
  secrets: {
    POCKET_BRIDGE_HOST: "127.0.0.1",
    POCKET_BRIDGE_PORT: 8788,
    POCKET_BRIDGE_RECONNECT_MS: 5000,
    POCKET_BRIDGE_AUTO_SPAWN: "false",
    POCKET_BRIDGE_PYTHON: "python",
  },
}));

vi.mock("../../services/forexData.service", () => ({
  forexDataService: {
    toCanonicalSymbol: (raw: unknown) => canonicalizeSymbol(raw),
  },
}));

vi.mock("../../services/tickIngestion.service", () => ({
  tickIngestionService: {},
}));
vi.mock("../../services/liveTickSignal.dispatch", () => ({
  liveTickSignalDispatcher: {},
}));
vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {},
}));
vi.mock("../../services/websocket.service", () => ({
  websocketService: {},
}));

const replaceFromBridgeAssets = vi.hoisted(() => vi.fn());
vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: { replaceFromBridgeAssets },
}));

vi.mock("../../services/poAuthManager", () => ({ poAuthManager: {} }));

import { PocketOptionBridgeService } from "../../services/pocketOptionBridge.service";

/** Fresh instance per test (the private constructor is TS-only). */
const makeBridge = (): PocketOptionBridgeService =>
  new (PocketOptionBridgeService as unknown as new () => PocketOptionBridgeService)();

/** Reach the private readiness handshake without opening a real relay. */
const handleReady = (
  bridge: PocketOptionBridgeService,
  payload: { assets?: unknown[] },
): void =>
  (
    bridge as unknown as { handleReady: (p: unknown) => void }
  ).handleReady(payload);

beforeEach(() => {
  replaceFromBridgeAssets.mockReset();
});

describe("PocketOptionBridgeService autonomous arming ([HEADLESS-PO-FEED])", () => {
  it("arms only genuine base/quote pairs, canonicalising the rest", () => {
    const bridge = makeBridge();
    const armed = bridge.armAutonomousSubscriptions([
      "EUR/USD",
      "GBPUSD",
      "usd/jpy",
      { symbol: "AUD/CAD" },
      "AAPL",
      "TSLA",
      "#FB",
      "",
      {},
      42,
    ]);

    expect(armed).toBe(4);
    expect(bridge.getAutonomousSymbols().sort()).toEqual([
      "AUD/CAD",
      "EUR/USD",
      "GBP/USD",
      "USD/JPY",
    ]);
  });

  it("is idempotent — re-arming an already-owned symbol adds nothing new", () => {
    const bridge = makeBridge();
    expect(bridge.armAutonomousSubscriptions(["EUR/USD"])).toBe(1);
    expect(
      bridge.armAutonomousSubscriptions(["eurusd", "EUR/USD", "EUR-USD"]),
    ).toBe(0);
    expect(bridge.getAutonomousSymbols()).toEqual(["EUR/USD"]);
  });

  it("tolerates a non-array / empty feed without throwing", () => {
    const bridge = makeBridge();
    expect(
      bridge.armAutonomousSubscriptions(undefined as unknown as unknown[]),
    ).toBe(0);
    expect(bridge.armAutonomousSubscriptions([])).toBe(0);
    expect(bridge.getAutonomousSymbols()).toEqual([]);
  });

  it("NEVER releases a server-owned symbol on a client unsubscribe", () => {
    const bridge = makeBridge();
    bridge.armAutonomousSubscriptions(["EUR/USD", "GBP/USD"]);

    bridge.requestSymbolUnsubscription("EUR/USD");
    bridge.requestSymbolUnsubscription("eurusd"); // any casing

    // The live stream + its server-aggregated candles stay armed headlessly.
    expect(bridge.getAutonomousSymbols().sort()).toEqual([
      "EUR/USD",
      "GBP/USD",
    ]);
  });

  it("does not stage a client-owned copy of an already server-owned symbol", () => {
    const bridge = makeBridge();
    bridge.armAutonomousSubscriptions(["EUR/USD"]);
    // A browser subscribing to an already-armed symbol must be a no-op for the
    // autonomous set (and must not throw with no relay opened).
    expect(() => bridge.requestSymbolSubscription("EUR/USD")).not.toThrow();
    expect(bridge.getAutonomousSymbols()).toEqual(["EUR/USD"]);
  });

  it("arms the PO-listed universe on the relay `ready` handshake", () => {
    const bridge = makeBridge();
    handleReady(bridge, {
      assets: [
        { symbol: "EUR/USD" },
        { symbol: "GBP/USD" },
        { symbol: "SP500" }, // non-pair junk must be dropped
      ],
    });

    expect(replaceFromBridgeAssets).toHaveBeenCalledTimes(1);
    expect(bridge.getAutonomousSymbols().sort()).toEqual([
      "EUR/USD",
      "GBP/USD",
    ]);
  });

  it("re-`ready` (reconnect) is additive and idempotent", () => {
    const bridge = makeBridge();
    handleReady(bridge, { assets: [{ symbol: "EUR/USD" }] });
    handleReady(bridge, {
      assets: [{ symbol: "EUR/USD" }, { symbol: "USD/JPY" }],
    });
    expect(bridge.getAutonomousSymbols().sort()).toEqual([
      "EUR/USD",
      "USD/JPY",
    ]);
  });
});
