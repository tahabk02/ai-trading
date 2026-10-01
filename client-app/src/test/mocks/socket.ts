import { vi } from "vitest";

/**
 * Socket.IO test double.
 *
 * `useSocket` is a React context hook (a single shared instance is created by
 * `SocketProvider` in the real tree). Mocking the MODULE — rather than
 * providing a real provider — keeps `SocketProvider` from opening a transport
 * while leaving every consumer's code path intact.
 */

export function createFakeSocket() {
  const handlers = new Map<string, Set<(p?: unknown) => void>>();
  return {
    connected: true,
    on(ev: string, h: (p?: unknown) => void) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(h);
      return this;
    },
    off(ev: string, h: (p?: unknown) => void) {
      handlers.get(ev)?.delete(h);
      return this;
    },
    emit: vi.fn(),
    disconnect: vi.fn(),
    /** test-only: simulate a backend channel push */
    server(ev: string, payload?: unknown) {
      handlers.get(ev)?.forEach((h) => h(payload));
    },
  };
}

export const socketState = {
  socket: createFakeSocket(),
  connected: true,
};

export function setSocketConnected(v: boolean) {
  socketState.connected = v;
  socketState.socket.connected = v;
}

export function resetSocket() {
  socketState.socket = createFakeSocket();
  socketState.connected = true;
}
