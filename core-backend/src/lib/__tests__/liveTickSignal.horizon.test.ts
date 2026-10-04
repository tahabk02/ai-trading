/**
 * liveTickSignal.horizon.test.ts — TARGET-EXPIRY HORIZON on the 1Hz path.
 *
 * The Pro Expiry Bar selection rides the Socket.IO "subscribe" payload and must
 * reach `/tick-signal` as `horizon_minutes`. Before this existed the fast path
 * sent no horizon at all, so the engine applied resolve_horizon_minutes(None)
 * = 1 minute for EVERY symbol — the live tick verdict silently ignored the
 * chosen expiry even though /predict honoured it.
 *
 * The clamp must mirror the engine's resolve_horizon_minutes()
 * (ai-engine/app/services/horizon_engine.py), floor bias included, so the two
 * sides never disagree about what a requested horizon evaluates to.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/secrets", () => ({
  secrets: {
    AI_ENGINE_URL: "http://127.0.0.1:8000",
    AI_ENGINE_API_KEY: "test",
    TICK_SIGNAL_TIMEOUT_MS: "1000",
  },
}));


vi.mock("../../services/websocket.service", () => ({
  websocketService: {
    broadcastLiveQuantSignal: vi.fn(),
    broadcastHighConfidenceSignal: vi.fn(),
  },
}));

vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    getRecentWindow: vi.fn(),
    getLatestSpread: vi.fn(),
  },
}));

import {
  liveTickSignalDispatcher,
  clampTickHorizonMinutes,
  TICK_HORIZON_OPTIONS_MINUTES,
} from "../../services/liveTickSignal.dispatch";

describe("clampTickHorizonMinutes — parity with the engine resolver", () => {
  it("supports exactly the engine's closed set", () => {
    expect([...TICK_HORIZON_OPTIONS_MINUTES]).toEqual([1, 2, 3, 5, 10]);
  });

  it("passes supported steps through untouched", () => {
    for (const h of [1, 2, 3, 5, 10]) {
      expect(clampTickHorizonMinutes(h)).toBe(h);
    }
  });

  it("returns null for absent or unusable input so the engine default applies", () => {
    // null (not 0, not 1) is the contract: the integration layer must never
    // invent a horizon of its own.
    expect(clampTickHorizonMinutes(undefined)).toBeNull();
    expect(clampTickHorizonMinutes(null)).toBeNull();
    expect(clampTickHorizonMinutes("")).toBeNull();
    expect(clampTickHorizonMinutes("nope")).toBeNull();
    expect(clampTickHorizonMinutes(0)).toBeNull();
    expect(clampTickHorizonMinutes(-3)).toBeNull();
  });

  it("snaps unsupported steps to the nearest, ties going SHORTER", () => {
    // Matches resolve_horizon_minutes() exactly.
    expect(clampTickHorizonMinutes(4)).toBe(3);
    expect(clampTickHorizonMinutes(6)).toBe(5);
    expect(clampTickHorizonMinutes(7)).toBe(5);
    expect(clampTickHorizonMinutes(30)).toBe(10);
  });
});

describe("per-symbol horizon registry (learned from socket subscribe)", () => {
  beforeEach(() => {
    liveTickSignalDispatcher.clearSelectedHorizonMinutes("EUR/USD");
  });

  it("defaults to null so the engine's own default applies", () => {
    expect(liveTickSignalDispatcher.getSelectedHorizonMinutes("EUR/USD")).toBeNull();
  });

  it("records the operator's selection for the canonical symbol", () => {
    liveTickSignalDispatcher.setSelectedHorizonMinutes("EUR/USD", 3);
    expect(liveTickSignalDispatcher.getSelectedHorizonMinutes("EUR/USD")).toBe(3);
  });

  it("is case/format insensitive so a room-key mismatch cannot lose it", () => {
    // The dispatcher keys on the canonical UPPERCASE form; the subscribe
    // handler passes the already-canonicalized symbol, but a differently-cased
    // caller must still resolve to the same entry.
    liveTickSignalDispatcher.setSelectedHorizonMinutes("eur/usd", 10);
    expect(liveTickSignalDispatcher.getSelectedHorizonMinutes("EUR/USD")).toBe(10);
  });

  it("an unsupported selection is ignored rather than coerced to 1m", () => {
    // 4m is unsupported, so it snaps to 3m (floor bias) — but a value that
    // cannot be interpreted at all leaves the engine default in place.
    liveTickSignalDispatcher.setSelectedHorizonMinutes("EUR/USD", "garbage");
    expect(liveTickSignalDispatcher.getSelectedHorizonMinutes("EUR/USD")).toBeNull();
    liveTickSignalDispatcher.setSelectedHorizonMinutes("EUR/USD", 4);
    expect(liveTickSignalDispatcher.getSelectedHorizonMinutes("EUR/USD")).toBe(3);
  });

  it("forgets the horizon when the last subscriber leaves", () => {
    liveTickSignalDispatcher.setSelectedHorizonMinutes("EUR/USD", 5);
    liveTickSignalDispatcher.clearSelectedHorizonMinutes("EUR/USD");
    // A later subscriber must start from the engine default, not inherit a
    // stale expiry selection.
    expect(liveTickSignalDispatcher.getSelectedHorizonMinutes("EUR/USD")).toBeNull();
  });
});
