/**
 * liveTickSignal.serialization.test.ts — ONE IN-FLIGHT /tick-signal PER SYMBOL.
 *
 * `dispatch` is deliberately fire-and-forget (`void this.dispatch(symbol)`) so
 * a slow AI Engine can never back-pressure the tick ingest loop. The cost of
 * that choice was that nothing stopped two requests for the SAME symbol from
 * overlapping: the 1s coalescing gate is measured from request START, while a
 * response may take up to TICK_SIGNAL_TIMEOUT_MS. Under load (training a model,
 * an exhausted inference pool) requests therefore stacked, and because HTTP
 * responses are not ordered, the SLOWER/OLDER response could land last — so
 * `broadcast` emitted a stale verdict and fed the out-of-order value into its
 * change-gate state machine, which then suppressed or admitted the NEXT real
 * transition incorrectly.
 *
 * The fix serializes per symbol and, crucially, does NOT drop the ticks that
 * arrived during the request: they are recorded and re-armed the moment the
 * in-flight call settles, so the freshest window is still scored and no
 * request pile-up can form.
 *
 * These tests pin both halves of that contract.
 *
 * NOTE: the dispatcher is a module-level singleton, and its per-symbol state
 * (coalescing anchor, in-flight slot, change-gate memory) is deliberately not
 * resettable from outside. Each test therefore uses its OWN symbol and settles
 * every outstanding promise, so no test can inherit another's in-flight slot.
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

vi.mock("axios", () => ({
  default: { isAxiosError: () => false, post: vi.fn() },
}));

const hasActiveSubscribers = vi.fn(() => true);
vi.mock("../../services/websocket.service", () => ({
  websocketService: {
    hasActiveSubscribers: (s: string) => hasActiveSubscribers(s),
    broadcastLiveQuantSignal: vi.fn(),
    broadcastHighConfidenceSignal: vi.fn(),
  },
}));

const getRecentWindow = vi.fn();
vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    getRecentWindow: (...a: unknown[]) => getRecentWindow(...a),
    getLatestSpread: () => ({ bid: 1.1057, ask: 1.1059 }),
  },
}));

import axios from "axios";
import { liveTickSignalDispatcher } from "../../services/liveTickSignal.dispatch";
import { websocketService } from "../../services/websocket.service";

/** A window the dispatcher will accept (>= 2 real prices). */
function seedWindow(): void {
  getRecentWindow.mockReturnValue([{ price: 1.1 }, { price: 1.1058 }]);
}

/** A promise the test resolves by hand, so the request stays outstanding. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tickSignalPayload = (confidence: number, price: number) => ({
  data: {
    signal: "BUY",
    confidence,
    current_price: price,
    target_price: price + 0.01,
    market_waiting: false,
  },
});

/** Advance fake time, flushing the microtasks timers interleave with. */
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

const postCount = () => vi.mocked(axios.post).mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  // `mockClear` does NOT drain the once-implementation queue, so a queue left
  // over from a previous test would silently answer the next test's request.
  // A full reset is required for this file to be order-independent.
  vi.mocked(axios.post).mockReset();
  hasActiveSubscribers.mockReturnValue(true);
  seedWindow();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  // Any request that escapes a test's own bookkeeping must fail loudly rather
  // than resolve into undefined and be mistaken for a real response.
  vi.mocked(axios.post).mockRejectedValue(
    new Error("unstubbed /tick-signal request"),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("per-symbol serialization of the fire-and-forget dispatch", () => {
  it("never runs two /tick-signal requests for the same symbol at once", async () => {
    const S = "AAA/USD";
    const first = deferred<any>();
    vi.mocked(axios.post).mockReturnValueOnce(first.promise as never);

    liveTickSignalDispatcher.enqueue(S);
    await flush();
    expect(postCount()).toBe(1);

    // A slow engine: three more ticks arrive while request #1 is outstanding.
    for (let i = 0; i < 3; i++) liveTickSignalDispatcher.enqueue(S);
    await flush();
    // Let the coalescing beat elapse too — a timer firing must not sneak a
    // second request past the in-flight guard either.
    await flush(2_000);

    expect(postCount()).toBe(1);

    first.resolve(tickSignalPayload(97, 1.1058));
    await flush();
  });

  it("re-arms exactly once when the in-flight request settles", async () => {
    const S = "BBB/USD";
    const first = deferred<any>();
    const second = deferred<any>();
    vi.mocked(axios.post)
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValueOnce(second.promise as never);

    liveTickSignalDispatcher.enqueue(S);
    await flush();
    expect(postCount()).toBe(1);

    // The tape moves while we are waiting — that data must not be discarded.
    liveTickSignalDispatcher.enqueue(S);
    await flush();
    expect(postCount()).toBe(1);

    first.resolve(tickSignalPayload(97, 1.1058));
    await flush();

    // Request #2 was armed WITHOUT waiting for the next 1s beat edge, so the
    // freshest window is scored immediately rather than up to a second later.
    expect(postCount()).toBe(2);

    // And it fires only ONCE: the trailing timer armed during the request is
    // cancelled by the re-arm, so no redundant beat follows it.
    await flush(2_000);
    expect(postCount()).toBe(2);

    second.resolve(tickSignalPayload(97, 1.1058));
    await flush();
  });

  it("a tick that arrives with nothing in flight dispatches at once", async () => {
    // The zero-latency property: the leading tick of a beat must not wait on a
    // trailing timer or on the previous response.
    const S = "CCC/USD";
    const first = deferred<any>();
    vi.mocked(axios.post).mockReturnValueOnce(first.promise as never);

    liveTickSignalDispatcher.enqueue(S);
    await flush();
    expect(postCount()).toBe(1);

    first.resolve(tickSignalPayload(97, 1.1058));
    await flush();

    // The 1s coalescing cadence still applies between settled beats; past it,
    // the next tick goes straight out.
    await flush(1_100);
    liveTickSignalDispatcher.enqueue(S);
    await flush();
    expect(postCount()).toBe(2);
  });

  it("serialization is per symbol — a busy pair never stalls another", async () => {
    const busy = deferred<any>();
    vi.mocked(axios.post)
      .mockReturnValueOnce(busy.promise as never)
      .mockReturnValueOnce(Promise.resolve(tickSignalPayload(97, 1.2)) as never);

    liveTickSignalDispatcher.enqueue("DDD/USD"); // will hang
    await flush();
    liveTickSignalDispatcher.enqueue("EEE/USD"); // different symbol
    await flush();

    // The second pair's request went out even though the first is outstanding.
    expect(postCount()).toBe(2);
    const calls = vi.mocked(axios.post).mock.calls;
    expect(calls[0][1]).toMatchObject({ symbol: "DDD/USD" });
    expect(calls[1][1]).toMatchObject({ symbol: "EEE/USD" });

    busy.resolve(tickSignalPayload(97, 1.1058));
    await flush();
  });

  it("a failed request releases the slot so the tape keeps flowing", async () => {
    const S = "FFF/USD";
    vi.mocked(axios.post)
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(tickSignalPayload(97, 1.1058) as never);

    liveTickSignalDispatcher.enqueue(S);
    await flush();
    expect(postCount()).toBe(1);
    // The downstream rider must not fabricate a direction.
    for (const [p] of vi.mocked(websocketService.broadcastLiveQuantSignal).mock
      .calls as any[]) {
      expect(p?.signal).toBeFalsy();
    }

    await flush(2_000);
    liveTickSignalDispatcher.enqueue(S);
    await flush();
    // The slot was released, so the next beat dispatches normally.
    expect(postCount()).toBe(2);
  });
});
