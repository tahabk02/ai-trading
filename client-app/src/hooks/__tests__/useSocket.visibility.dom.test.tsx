/**
 * useSocket.visibility.dom.test.tsx — tab-focus recovery vs. focus thrash.
 *
 * Regression guard for the visibilitychange recovery path. The provider used to
 * force-reconnect on EVERY tab focus, tearing down a HEALTHY live transport and
 * producing a visible feed gap (and reconnect thrash) each time a user switched
 * windows. It must now only nudge a transport that is actually down, or a
 * half-open one that has gone silent past the freshness window, and must
 * coalesce a burst of events into a single reconnect.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { act, render } from "@testing-library/react";

const h = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  interface FakeSocket {
    connected: boolean;
    id: string;
    handlers: Record<string, Handler>;
    disconnectCount: number;
    connectCount: number;
    on: (ev: string, fn: Handler) => FakeSocket;
    removeAllListeners: () => FakeSocket;
    disconnect: () => FakeSocket;
    connect: () => FakeSocket;
  }
  const sockets: FakeSocket[] = [];
  const makeFake = (): FakeSocket => {
    const handlers: Record<string, Handler> = {};
    const fake = {
      connected: true,
      id: `fake-${sockets.length + 1}`,
      handlers,
      disconnectCount: 0,
      connectCount: 0,
      on(ev: string, fn: Handler) {
        handlers[ev] = fn;
        return fake;
      },
      removeAllListeners() {
        for (const k of Object.keys(handlers)) delete handlers[k];
        return fake;
      },
      disconnect() {
        fake.disconnectCount += 1;
        fake.connected = false;
        return fake;
      },
      connect() {
        fake.connectCount += 1;
        fake.connected = true;
        return fake;
      },
    } as FakeSocket;
    return fake;
  };
  return { sockets, makeFake };
});

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => {
    const f = h.makeFake();
    h.sockets.push(f);
    return f;
  }),
}));

async function mountProvider() {
  // A fresh module instance per test → a fresh module-level socket singleton,
  // so io() runs and a new fake socket is created.
  vi.resetModules();
  const { SocketProvider } = await import("@/hooks/useSocket");
  render(
    <SocketProvider>
      <div data-testid="child" />
    </SocketProvider>,
  );
  const socket = h.sockets[h.sockets.length - 1];
  return { socket };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("SocketProvider visibilitychange recovery", () => {
  beforeEach(() => {
    h.sockets.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT recycle a healthy live socket on tab focus", async () => {
    const { socket } = await mountProvider();
    // A real feed fires `connect` then keeps ticking; baseline the liveness clock.
    act(() => {
      socket.handlers.connect?.();
    });

    act(() => {
      setVisibility("visible");
    });

    expect(socket.disconnectCount).toBe(0);
    expect(socket.connectCount).toBe(0);
  });

  it("recovers a half-open socket that went silent past the freshness window", async () => {
    const { socket } = await mountProvider();
    act(() => {
      socket.handlers.connect?.();
    });

    // No inbound frame for > 15s while the tab was backgrounded.
    const base = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(base + 20_000);
    act(() => {
      setVisibility("visible");
    });
    spy.mockRestore();

    expect(socket.disconnectCount).toBe(1);
    expect(socket.connectCount).toBe(1);
  });

  it("reconnects a down socket when the tab returns", async () => {
    const { socket } = await mountProvider();
    socket.connected = false;

    act(() => {
      setVisibility("visible");
    });

    expect(socket.connectCount).toBe(1);
  });

  it("coalesces a burst of visibility events into a single reconnect", async () => {
    const { socket } = await mountProvider();
    socket.connected = false;

    act(() => {
      setVisibility("visible");
      setVisibility("visible");
      setVisibility("visible");
    });

    expect(socket.connectCount).toBe(1);
  });
});
