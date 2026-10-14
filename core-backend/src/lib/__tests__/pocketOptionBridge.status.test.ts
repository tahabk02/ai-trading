import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PART 51 [HEADLESS-FEED] — the relay's live signal must flip the backend's
 * PO feed ONLINE automatically, with no manual step. This is the trigger half
 * of the "PO OFFLINE → PO LIVE" transition: once the headless bridge socket
 * completes its handshake (relay `status: connected`, or the 5s `heartbeat`
 * carrying `status: connected`), `getStatus()` becomes ONLINE — and
 * `tickIngestionService.isPocketOptionActivelyLive()` (pinned separately in
 * tickIngestion.poAuthority.test.ts) then treats genuine PO ticks as the
 * authoring feed, so every terminal pair re-labels to PO LIVE.
 *
 * The service is exercised in isolation: heavyweight collaborators are mocked
 * (only `broadcastFeedStatus` needs a real spy, since a status flip emits it).
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
  forexDataService: {},
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

const broadcastFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("../../services/websocket.service", () => ({
  websocketService: { broadcastFeedStatus },
}));

vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: { replaceFromBridgeAssets: vi.fn() },
}));

vi.mock("../../services/poAuthManager", () => ({
  poAuthManager: { maybeAutoRefresh: vi.fn(async () => false) },
}));

import { PocketOptionBridgeService } from "../../services/pocketOptionBridge.service";

/** Fresh instance per test (the private constructor is TS-only). */
const makeBridge = (): PocketOptionBridgeService =>
  new (PocketOptionBridgeService as unknown as new () => PocketOptionBridgeService)();

/** Reach private relay-frame handlers without opening a real relay socket. */
const handleStatus = (
  bridge: PocketOptionBridgeService,
  payload: { status?: string; error?: string },
): void =>
  (bridge as unknown as { handleStatus: (p: unknown) => void }).handleStatus(
    payload,
  );

const handleHeartbeat = (
  bridge: PocketOptionBridgeService,
  payload: Record<string, unknown>,
): void =>
  (
    bridge as unknown as { handleHeartbeat: (p: unknown) => void }
  ).handleHeartbeat(payload);

beforeEach(() => {
  broadcastFeedStatus.mockReset();
});

describe("PocketOptionBridgeService feed-state transition ([HEADLESS-FEED])", () => {
  it("flips OFFLINE → ONLINE on `status: connected` (the handshake signal)", () => {
    const bridge = makeBridge();
    expect(bridge.getStatus()).toBe("idle");

    handleStatus(bridge, { status: "connected" });

    expect(bridge.getStatus()).toBe("ONLINE");
    expect(bridge.getLastRelayStatus()).toBe("connected");
    expect(broadcastFeedStatus).toHaveBeenCalledWith("live", expect.anything());
  });

  it("flips ONLINE on a `heartbeat` carrying `status: connected`", () => {
    const bridge = makeBridge();
    handleHeartbeat(bridge, { status: "connected" });
    expect(bridge.getStatus()).toBe("ONLINE");
  });

  it("surfaces awaiting_ssid without claiming a live feed", () => {
    const bridge = makeBridge();
    handleStatus(bridge, { status: "awaiting_ssid" });
    expect(bridge.getStatus()).toBe("awaiting_ssid");
  });

  it("degrades (never ONLINE) on connection_error / stalled / disconnected", () => {
    for (const status of ["connection_error", "stalled", "disconnected", "stopped"]) {
      const bridge = makeBridge();
      handleStatus(bridge, { status });
      expect(bridge.getStatus()).toBe("DEGRADED");
    }
  });

  it("degrades on session_expired (terminal auth failure)", () => {
    const bridge = makeBridge();
    handleStatus(bridge, { status: "session_expired" });
    expect(bridge.getStatus()).toBe("DEGRADED");
  });
});
