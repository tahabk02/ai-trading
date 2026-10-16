/**
 * header.connectionDeDup.dom.test.tsx — PHASE 3 DE-DUPLICATION CONTRACT.
 *
 * The Header renders on EVERY dashboard page and needs exactly ONE fact for its
 * status dot: is the transport live? It must read that from the shared
 * `useSocket()` context — NEVER from `useWebSocket()`.
 *
 * Why this is load-bearing: `useWebSocket` is a per-instance orchestrator. Each
 * call registers its own socket handlers (`live_tick`, `symbol_update`,
 * `new_signal`, `live_quant_signal`, `history`, `candle`, `history_candles`,
 * `feed_status`, `connect`), its own 1s heartbeat sweep, its own stall + hard
 * reconnect watchdogs and its own subscribe emits. While the Header called it,
 * the Pro terminal ran TWO orchestrators on ONE shared socket: every
 * `live_tick` was folded into the aggregator twice (double volume / bucket
 * writes — the candle-parity breach). The Header must stay side-effect-free.
 *
 * The guard is deliberate and loud: `useWebSocket` is mocked to THROW, so the
 * moment anyone re-introduces the import into the Header the render blows up
 * instead of silently restoring the duplication.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { screen, cleanup } from "@testing-library/react";
import { resetAll, ui } from "@/test/harness";

// Hoisted so the factory can reference it before the (hoisted) imports run.
const { useWebSocketSpy } = vi.hoisted(() => ({
  useWebSocketSpy: vi.fn(() => {
    throw new Error(
      "Header must NOT call useWebSocket() — it is a per-instance orchestrator " +
        "and would duplicate the Pro page's socket handlers + watchdogs (Phase 3).",
    );
  }),
}));

vi.mock("@/hooks/useWebSocket", () => ({
  useWebSocket: () => useWebSocketSpy(),
}));

// Controllable shared-transport status — the ONE thing the Header reads.
const socketConn = { connected: true };

vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => ({
    socket: null,
    connected: socketConn.connected,
    status: socketConn.connected ? "connected" : "reconnecting",
    reconnectAttempt: 0,
    lastError: null,
  }),
  SocketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/pro",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href?: unknown; children?: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import { Header } from "@/components/shared/header";

beforeEach(() => {
  resetAll();
  useWebSocketSpy.mockClear();
  socketConn.connected = true;
});

afterEach(cleanup);

describe("Header — Phase 3 connection de-duplication", () => {
  it("reads the shared transport via useSocket, never the useWebSocket orchestrator", () => {
    ui(<Header />);
    expect(useWebSocketSpy).not.toHaveBeenCalled();
    // Transport live → the status surface reports the connected state.
    expect(screen.getByText("Engine: ACTIVE")).toBeTruthy();
  });

  it("reflects the transport status (OFFLINE when the socket is down)", () => {
    socketConn.connected = false;
    ui(<Header />);
    expect(useWebSocketSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Engine: OFFLINE")).toBeTruthy();
  });
});
