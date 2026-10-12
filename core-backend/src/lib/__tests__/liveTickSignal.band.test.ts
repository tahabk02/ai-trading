/**
 * liveTickSignal.band.test.ts — PART 38.1 [377]: THE HONEST BAND MUST SURVIVE
 * THE SOCKET HOP.
 *
 * The engine already returns the full execution surface on every /tick-signal
 * (signal_gatekeeper.apply_strict_execution_gate → signals.
 * _strict_execution_surface): `tier`, `tier_label`, `status`, `dispatchable`,
 * `scored_only`, `executable`, `regime_gate`, `suppressed_reason`.
 *
 * `broadcast()` copied a fixed subset of that response into the
 * `live_quant_signal` frame and dropped the band entirely. Two consequences
 * the terminal then displayed as product behaviour:
 *
 *   • `LiveVerdict` DECLARES tier/tier_label/scored_only/… ("present for every
 *     tier") but every live verdict arrived bandless, so `resolveCardTier` had
 *     to re-derive a band from a micro-quant confidence — and a verdict the
 *     engine had just suppressed to T5 (regime override, SUPPRESSED_TIER) read
 *     back as T1 and looked actionable;
 *   • the change-gate only admitted direction / confidence-step / 60% gate /
 *     waiting transitions, so an honest band flip that moved confidence by
 *     less than BROADCAST_CONFIDENCE_STEP was silently discarded and the card
 *     stayed on its previous tier.
 *
 * These tests pin the forwarded surface AND the widened change-gate.
 *
 * Harness mirrors liveTickSignal.tier.test.ts: module-level singleton, one
 * symbol per test, no reset of internal state.
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
    isAxiosError: (e: unknown) =>
      !!(e as { isAxiosError?: boolean })?.isAxiosError,
  },
}));

import { liveTickSignalDispatcher } from "../../services/liveTickSignal.dispatch";
import { websocketService } from "../../services/websocket.service";

type Frame = Record<string, any>;

const broadcastFrames = (): Frame[] =>
  (vi.mocked(websocketService.broadcastLiveQuantSignal).mock.calls as any[])
    .map((c) => c[0])
    .filter(Boolean);

const lastFrame = (): Frame => {
  const frames = broadcastFrames();
  expect(frames.length).toBeGreaterThan(0);
  return frames[frames.length - 1];
};

/** A response the dispatcher will accept (>= 2 real prices, finite confidence). */
function seedTape(): void {
  getRecentWindow.mockReturnValue([
    { price: 1.1, timestamp: Date.now() },
    { price: 1.101, timestamp: Date.now() },
    { price: 1.102, timestamp: Date.now() },
  ]);
  getLatestSpread.mockReturnValue({ bid: 1.1019, ask: 1.1021 });
}

/** The engine's full execution surface, as /tick-signal actually returns it. */
function surface(overrides: Frame = {}): { data: Frame } {
  return {
    data: {
      signal: "BUY",
      confidence: 97.2,
      current_price: 1.102,
      target_price: 1.106,
      market_waiting: false,
      tier: "T1",
      tier_label: "PREMIUM",
      status: "active",
      dispatchable: true,
      scored_only: false,
      executable: true,
      regime_gate: "tradable",
      suppressed_reason: null,
      ...overrides,
    },
  };
}

const SYMBOLS: string[] = [];
let counter = 0;
const freshSymbol = () => {
  const s = `BAND/${counter++}`;
  SYMBOLS.push(s);
  return s;
};

beforeEach(() => {
  vi.clearAllMocks();
  post.mockReset();
  hasSubscribersTrue();
  seedTape();
  // No fake timers by default: the dispatch resolves on real microtasks.
  post.mockResolvedValue(surface());
});

afterEach(() => {
  vi.useRealTimers();
  for (const s of SYMBOLS) {
    liveTickSignalDispatcher.clearSelectedMinTier(s);
    liveTickSignalDispatcher.clearSelectedHorizonMinutes(s);
  }
  SYMBOLS.length = 0;
});

function hasSubscribersTrue(): void {
  vi.mocked(websocketService.hasActiveSubscribers).mockReturnValue(true);
}

async function dispatch(symbol: string): Promise<void> {
  await liveTickSignalDispatcher.enqueue(symbol);
  await vi.waitFor(() => expect(broadcastFrames().length).toBeGreaterThan(0));
}

describe("[377] the engine's execution surface is forwarded, not dropped", () => {
  it("carries tier / tier_label / status / the executable flags on the frame", async () => {
    const S = freshSymbol();
    await dispatch(S);

    const frame = lastFrame();
    expect(frame.symbol).toBe(S);
    expect(frame.tier).toBe("T1");
    expect(frame.tier_label).toBe("PREMIUM");
    expect(frame.status).toBe("active");
    expect(frame.dispatchable).toBe(true);
    expect(frame.scored_only).toBe(false);
    expect(frame.executable).toBe(true);
    expect(frame.regime_gate).toBe("tradable");
    expect(frame.suppressed_reason).toBeNull();
    // The pre-existing fields are untouched — this is additive.
    expect(frame.signal).toBe("BUY");
    expect(frame.confidence).toBe(97.2);
    expect(frame.market_waiting).toBe(false);
  });

  it("forwards a SUPPRESSED band verbatim (regime override ⇒ T5, scored-only)", async () => {
    const S = freshSymbol();
    post.mockResolvedValue(
      surface({
        signal: "BUY",
        confidence: 97.2,
        tier: "T5",
        tier_label: "WEAK",
        dispatchable: true,
        scored_only: true,
        executable: false,
        regime_gate: "pending_high_precision",
        suppressed_reason: "below_high_precision_bar",
      }),
    );
    await dispatch(S);

    const frame = lastFrame();
    // The exact defect [377] exists to prevent: 97.2% MUST NOT read back as a
    // tradable T1 just because the band never crossed the socket.
    expect(frame.tier).toBe("T5");
    expect(frame.scored_only).toBe(true);
    expect(frame.executable).toBe(false);
    expect(frame.regime_gate).toBe("pending_high_precision");
    expect(frame.suppressed_reason).toBe("below_high_precision_bar");
  });

  it("resolves a malformed tier to null — never invents a band", async () => {
    const S = freshSymbol();
    post.mockResolvedValue(surface({ tier: "T9", tier_label: "MADE UP" }));
    await dispatch(S);

    expect(lastFrame().tier).toBeNull();
  });

  it("passes no band through on a waiting-only rider (no direction, no tier)", async () => {
    const S = freshSymbol();
    post.mockResolvedValue({
      data: { signal: null, confidence: 0, market_waiting: true },
    });
    await dispatch(S);

    const frame = lastFrame();
    expect(frame.signal).toBeFalsy();
    expect(frame.market_waiting).toBe(true);
    expect(frame.tier).toBeNull();
  });
});

describe("[377] the change-gate admits an honest band change", () => {
  it("emits a tier flip even when confidence moves less than the 2.0 step", async () => {
    vi.useFakeTimers();
    const S = freshSymbol();
    let beat = 0;
    post.mockImplementation(async () =>
      beat++ === 0
        ? surface({ confidence: 70.4, tier: "T4", tier_label: "LOW" })
        : surface({
            confidence: 69.8,
            tier: "T5",
            tier_label: "WEAK",
            executable: false,
            scored_only: true,
          }),
    );

    liveTickSignalDispatcher.enqueue(S);
    await vi.advanceTimersByTimeAsync(0);
    expect(broadcastFrames()).toHaveLength(1);
    expect(lastFrame().tier).toBe("T4");

    // A fresh tick lands after the 1s coalescing beat (production ticks arrive
    // continuously; the dispatcher has no timer of its own to re-fire on).
    await vi.advanceTimersByTimeAsync(1_100);
    liveTickSignalDispatcher.enqueue(S);
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(broadcastFrames()).toHaveLength(2);
    // 70.4 → 69.8 is a 0.6 step (below BROADCAST_CONFIDENCE_STEP) and stays on
    // the same side of the 60% gate: without `tier` in the gate this frame is
    // silently dropped and the card keeps showing T4.
    expect(lastFrame().tier).toBe("T5");
    expect(lastFrame().scored_only).toBe(true);
  });

  it("still suppresses a flat repeat with an unchanged band", async () => {
    vi.useFakeTimers();
    const S = freshSymbol();
    post.mockResolvedValue(
      surface({ confidence: 66.4, tier: "T5", tier_label: "WEAK" }),
    );

    liveTickSignalDispatcher.enqueue(S);
    await vi.advanceTimersByTimeAsync(0);
    expect(broadcastFrames()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_100);
    liveTickSignalDispatcher.enqueue(S);
    await vi.advanceTimersByTimeAsync(0);
    // Identical verdict, same band ⇒ the socket stays clean.
    expect(post).toHaveBeenCalledTimes(2);
    expect(broadcastFrames()).toHaveLength(1);
  });
});
