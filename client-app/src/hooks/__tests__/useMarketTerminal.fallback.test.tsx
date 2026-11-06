/**
 * useMarketTerminal — REACTIVE SYNC FALLBACK.
 *
 * The 1Hz `market_quotes` WS beat is primary, but a dead tunnel / half-open
 * socket must not freeze the grid. These tests pin the safety net:
 *   • REST poll every 2s while the WS beat is stale,
 *   • NO poll while a fresh WS snapshot is arriving,
 *   • one debounced /multi-predict batch when no verdict lands for 15s,
 *   • the interval is torn down on unmount.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMarketTerminal } from "@/hooks/useMarketTerminal";
import apiClient from "@/services/api";
import { resetSocket, socketState } from "@/test/mocks/socket";
import { resetStores } from "@/test/harness";

vi.mock("@/hooks/useSocket", async () => {
  const m = await import("@/test/mocks/socket");
  return {
    useSocket: () => ({
      socket: m.socketState.socket,
      connected: m.socketState.connected,
    }),
  };
});

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      getQuotes: vi.fn().mockResolvedValue({ quotes: [] }),
      multiPredict: vi.fn().mockResolvedValue({ results: {} }),
    },
  };
});

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe("useMarketTerminal reactive sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
    resetSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pulls the REST snapshot every 2s while the WS beat is stale", async () => {
    const getQuotes = vi.mocked(apiClient.getQuotes);
    const { unmount } = renderHook(() => useMarketTerminal());
    await flush();
    getQuotes.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getQuotes).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getQuotes).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("does not poll while a fresh WS snapshot keeps arriving", async () => {
    const getQuotes = vi.mocked(apiClient.getQuotes);
    const { unmount } = renderHook(() => useMarketTerminal());
    await flush();
    getQuotes.mockClear();

    act(() => {
      socketState.socket.server("market_quotes", { quotes: [] });
    });

    // 2s later the WS snapshot is still inside the 3.5s freshness window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getQuotes).not.toHaveBeenCalled();

    // Past the window the fallback takes over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getQuotes).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("keeps grid-only pairs on the aggregate feed without arming PO readers", async () => {
    const { unmount } = renderHook(() => useMarketTerminal());
    await flush();

    expect(socketState.socket.emit).toHaveBeenCalledWith("subscribe_all");
    expect(socketState.socket.emit).not.toHaveBeenCalledWith(
      "subscribe",
      expect.anything(),
    );
    expect(socketState.socket.emit).not.toHaveBeenCalledWith(
      "subscribe_symbol",
      expect.anything(),
    );

    unmount();
  });

  it("falls back to one debounced /multi-predict batch when no verdict lands", async () => {
    const multiPredict = vi.mocked(apiClient.multiPredict);
    const { unmount } = renderHook(() => useMarketTerminal());
    await flush();
    multiPredict.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(multiPredict).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("tears the poll interval down on unmount", async () => {
    const getQuotes = vi.mocked(apiClient.getQuotes);
    const { unmount } = renderHook(() => useMarketTerminal());
    await flush();
    getQuotes.mockClear();

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getQuotes).not.toHaveBeenCalled();
  });
});
