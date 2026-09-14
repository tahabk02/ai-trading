import { describe, expect, it } from "vitest";
import {
  SOCKET_SERVER_OPTIONS,
  FRONTEND_ORIGIN,
} from "../../config/socket.config";
import { buildFeedStatusPayload } from "../../services/websocket.service";

describe("MASTER MISSION part 2 — socket.io stability", () => {
  it("test_socket_ping_config — 25s pingInterval / 20s pingTimeout / frontend CORS", () => {
    expect(SOCKET_SERVER_OPTIONS.pingInterval).toBe(25_000);
    expect(SOCKET_SERVER_OPTIONS.pingTimeout).toBe(20_000);
    expect(SOCKET_SERVER_OPTIONS.transports).toContain("websocket");
    expect(SOCKET_SERVER_OPTIONS.transports).toContain("polling");
    const cors = SOCKET_SERVER_OPTIONS.cors as {
      origin?: string;
      credentials?: boolean;
    };
    expect(cors.origin).toBe(FRONTEND_ORIGIN);
    expect(cors.credentials).toBe(true);
  });

  it("test_feed_status_event_emitted_on_connect — payload carries status, symbols, last_tick_ts", () => {
    const payload = buildFeedStatusPayload("live", {
      symbols: [{ symbol: "EUR/USD", name: "Euro/US Dollar", type: "otc" }],
      lastTickTs: "2026-09-13T12:00:00.000Z",
      lastHeartbeatTs: 1_760_000_000_000,
      heartbeatAgeMs: 42,
    });
    expect(payload.status).toBe("live");
    expect(payload.symbols).toHaveLength(1);
    expect(payload.symbols[0]).toMatchObject({
      symbol: "EUR/USD",
      name: "Euro/US Dollar",
      type: "otc",
    });
    expect(payload.last_tick_ts).toBe("2026-09-13T12:00:00.000Z");
    expect(payload.lastHeartbeatTs).toBe(1_760_000_000_000);
    expect(payload.heartbeatAgeMs).toBe(42);
    expect(typeof payload.timestamp).toBe("string");
  });
});