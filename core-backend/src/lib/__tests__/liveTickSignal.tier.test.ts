/**
 * liveTickSignal.tier.test.ts — TIER SELECTOR on the 1Hz /tick-signal PATH.
 *
 * The Tier Selector's choice must reach BOTH predict surfaces. `/predict`
 * learned it first; this suite covers the gap that remained: the coalesced 1Hz
 * `/tick-signal` forwarder sent no `min_tier` at all, so the live tick verdict
 * was ALWAYS scored at the engine's strict T1 default. Selecting T4 therefore
 * changed the batch view and did nothing to the live surface — the one the
 * terminal actually watches.
 *
 * Mirrors liveTickSignal.horizon.test.ts: the per-symbol registry is learned
 * from the Socket.IO "subscribe" payload and forwarded as `min_tier`.
 *
 * The clamp must mirror the engine's resolve_execution_floor()
 * (ai-engine/app/services/signal_gatekeeper.py): garbage must resolve to null so
 * the ENGINE keeps its own strict default, and the bridge must never invent a
 * wider preference on the operator's behalf.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("../../utils/aiEngineHttp", () => ({ AI_ENGINE_HTTP_AGENT: {} }));

vi.mock("../../services/websocket.service", () => ({
  websocketService: {
    broadcastLiveQuantSignal: vi.fn(),
    broadcastHighConfidenceSignal: vi.fn(),
    hasActiveSubscribers: vi.fn(() => true),
  },
}));

const getRecentWindow = vi.fn();
const getLatestSpread = vi.fn();

vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    getRecentWindow: (...args: unknown[]) => getRecentWindow(...args),
    getLatestSpread: (...args: unknown[]) => getLatestSpread(...args),
  },
}));

const post = vi.fn();

vi.mock("axios", () => ({
  default: {
    post: (...args: unknown[]) => post(...args),
    // The dispatcher's failure classifier calls this; without it a thrown
    // dispatch would raise inside the catch handler as an unhandled rejection.
    isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
  },
}));

import { liveTickSignalDispatcher } from "../../services/liveTickSignal.dispatch";
import {
  VALID_SIGNAL_TIERS,
  clampMinTierToEngineSet,
  readMinTier,
} from "../signalTiers";
import type { SignalTier } from "../signalTiers";

const SYMBOL = "EUR/USD";

describe("shared tier ladder", () => {
  it("is exactly the engine's T1..T5 set, T1 strongest", () => {
    expect([...VALID_SIGNAL_TIERS]).toEqual(["T1", "T2", "T3", "T4", "T5"]);
  });

  it("accepts every real band, case/whitespace tolerant", () => {
    for (const t of VALID_SIGNAL_TIERS) {
      expect(clampMinTierToEngineSet(t)).toBe(t);
      expect(clampMinTierToEngineSet(t.toLowerCase())).toBe(t);
      expect(clampMinTierToEngineSet(`  ${t.toLowerCase()} `)).toBe(t);
    }
  });

  it("returns null for garbage so the engine keeps its strict default", () => {
    // null — not a default tier — is the contract: a bad input must never
    // LOOSEN the executable bar.
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "T0",
      "T6",
      "T9",
      "premium",
      3,
      0,
      {},
      [],
      true,
    ]) {
      expect(clampMinTierToEngineSet(bad)).toBeNull();
    }
  });

  it("reads both wire spellings from a body", () => {
    expect(readMinTier({ min_tier: "T4" })).toBe("T4");
    expect(readMinTier({ minTier: "t2" })).toBe("T2");
    // snake_case wins when both are present.
    expect(readMinTier({ min_tier: "T1", minTier: "T4" })).toBe("T1");
    expect(readMinTier({})).toBeNull();
    expect(readMinTier(null)).toBeNull();
    expect(readMinTier("T3")).toBeNull();
  });
});

describe("per-symbol tier registry (learned from socket subscribe)", () => {
  beforeEach(() => {
    liveTickSignalDispatcher.clearSelectedMinTier(SYMBOL);
  });

  it("defaults to null so the engine's own default applies", () => {
    expect(liveTickSignalDispatcher.getSelectedMinTier(SYMBOL)).toBeNull();
  });

  it("stores every real band", () => {
    for (const t of VALID_SIGNAL_TIERS) {
      liveTickSignalDispatcher.setSelectedMinTier(SYMBOL, t);
      expect(liveTickSignalDispatcher.getSelectedMinTier(SYMBOL)).toBe(t);
    }
  });

  it("normalises case and whitespace", () => {
    liveTickSignalDispatcher.setSelectedMinTier(SYMBOL, " t3 ");
    expect(liveTickSignalDispatcher.getSelectedMinTier(SYMBOL)).toBe("T3");
  });

  it("never lets garbage widen the floor", () => {
    liveTickSignalDispatcher.setSelectedMinTier(SYMBOL, "T4");
    liveTickSignalDispatcher.setSelectedMinTier(SYMBOL, "T9");
    expect(liveTickSignalDispatcher.getSelectedMinTier(SYMBOL)).toBeNull();
  });

  it("never invents a selection from an absent value", () => {
    liveTickSignalDispatcher.setSelectedMinTier(SYMBOL, undefined);
    expect(liveTickSignalDispatcher.getSelectedMinTier(SYMBOL)).toBeNull();
  });

  it("is case-insensitive on the symbol key", () => {
    liveTickSignalDispatcher.setSelectedMinTier("eur/usd", "T4");
    expect(liveTickSignalDispatcher.getSelectedMinTier(SYMBOL)).toBe("T4");
  });

  it("keeps symbols independent", () => {
    liveTickSignalDispatcher.setSelectedMinTier(SYMBOL, "T2");
    liveTickSignalDispatcher.setSelectedMinTier("GBP/USD", "T5");
    expect(liveTickSignalDispatcher.getSelectedMinTier(SYMBOL)).toBe("T2");
    expect(liveTickSignalDispatcher.getSelectedMinTier("GBP/USD")).toBe("T5");
    liveTickSignalDispatcher.clearSelectedMinTier("GBP/USD");
    expect(liveTickSignalDispatcher.getSelectedMinTier("GBP/USD")).toBeNull();
    expect(liveTickSignalDispatcher.getSelectedMinTier(SYMBOL)).toBe("T2");
  });

  it("ignores a blank symbol", () => {
    liveTickSignalDispatcher.setSelectedMinTier("  ", "T4");
    expect(liveTickSignalDispatcher.getSelectedMinTier("")).toBeNull();
  });
});

describe("/tick-signal payload carries min_tier", () => {
  beforeEach(() => {
    // mockClear, NOT mockReset: reset would drop the resolved value and make the
    // next dispatch destructure `undefined`.
    post.mockClear();
    post.mockResolvedValue({ data: { signal: null, tier: "T1" } });
    getRecentWindow.mockReset();
    getRecentWindow.mockReturnValue([
      { price: 1.1, timestamp: Date.now() },
      { price: 1.101, timestamp: Date.now() },
      { price: 1.102, timestamp: Date.now() },
    ]);
    getLatestSpread.mockReset();
    getLatestSpread.mockReturnValue({ bid: 1.1019, ask: 1.1021 });
    liveTickSignalDispatcher.clearSelectedMinTier(SYMBOL);
    liveTickSignalDispatcher.clearSelectedHorizonMinutes(SYMBOL);
  });

  afterEach(() => {
    liveTickSignalDispatcher.clearSelectedMinTier(SYMBOL);
    for (const s of SYMBOLS_USED) liveTickSignalDispatcher.clearSelectedMinTier(s);
  });

  // The dispatcher coalesces to one POST per symbol per second, so a repeated
  // enqueue of the SAME symbol inside that budget only arms a trailing timer.
  // Each assertion therefore burns a distinct symbol to get a real dispatch.
  const SYMBOLS_USED: string[] = [];
  let symbolCounter = 0;
  function freshSymbol(): string {
    const s = `TEST/${symbolCounter++}`;
    SYMBOLS_USED.push(s);
    return s;
  }

  async function dispatchPayload(symbol: string): Promise<Record<string, unknown>> {
    await liveTickSignalDispatcher.enqueue(symbol);
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    return post.mock.calls[0][1] as Record<string, unknown>;
  }

  it("omits min_tier entirely when the operator selected nothing", async () => {
    const payload = await dispatchPayload(freshSymbol());
    expect("min_tier" in payload).toBe(false);
  });

  it("forwards the selected tier verbatim", async () => {
    for (const tier of VALID_SIGNAL_TIERS) {
      const symbol = freshSymbol();
      liveTickSignalDispatcher.setSelectedMinTier(symbol, tier);
      const payload = await dispatchPayload(symbol);
      expect(payload.min_tier).toBe(tier);
      post.mockClear();
    }
  });

  it("keeps the horizon and the tier independent on the same payload", async () => {
    const symbol = freshSymbol();
    liveTickSignalDispatcher.setSelectedHorizonMinutes(symbol, 5);
    liveTickSignalDispatcher.setSelectedMinTier(symbol, "T3");
    const payload = await dispatchPayload(symbol);
    expect(payload.horizon_minutes).toBe(5);
    expect(payload.min_tier).toBe("T3");
  });

  it("omits min_tier after the operator's selection is cleared", async () => {
    const symbol = freshSymbol();
    liveTickSignalDispatcher.setSelectedMinTier(symbol, "T4");
    liveTickSignalDispatcher.clearSelectedMinTier(symbol);
    const payload = await dispatchPayload(symbol);
    expect("min_tier" in payload).toBe(false);
  });

  it("forwards T5 losslessly — the engine alone floors it to the T4 bar", async () => {
    const symbol = freshSymbol();
    liveTickSignalDispatcher.setSelectedMinTier(symbol, "T5");
    const payload = await dispatchPayload(symbol);
    expect(payload.min_tier satisfies SignalTier).toBe("T5");
  });

  it("omits min_tier when the operator selected garbage", async () => {
    const symbol = freshSymbol();
    liveTickSignalDispatcher.setSelectedMinTier(symbol, "T9");
    const payload = await dispatchPayload(symbol);
    expect("min_tier" in payload).toBe(false);
  });
});