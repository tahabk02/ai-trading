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
      origin?:
        | string
        | ((
            origin: string | undefined,
            callback: (err: Error | null, allow?: boolean) => void,
          ) => void);
      credentials?: boolean;
    };
    expect(typeof cors.origin).toBe("function");
    // Shared resolver — allows the frontend origin explicitly, rejects strangers.
    const resolver = cors.origin as NonNullable<typeof cors.origin> &
      ((
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => void);
    const resolve = (origin: string) =>
      new Promise<boolean>((resolve, reject) =>
        resolver(origin, (err, allow) =>
          err ? reject(err) : resolve(allow === true),
        ),
      );
    expect(cors.credentials).toBe(true);
    return Promise.all([
      expect(resolve(FRONTEND_ORIGIN)).resolves.toBe(true),
      expect(
        resolve("https://b3lrfrj9-3000.uks1.devtunnels.ms"),
      ).resolves.toBe(true),
      expect(resolve("https://evil.example.test")).rejects.toThrow(
        /not allowed by CORS/,
      ),
    ]);
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