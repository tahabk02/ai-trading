/**
 * predict.controller.test.ts — /predict 503 CONTRACT (QUICK FIX mission [1]).
 *
 * Two hard rules under test:
 *   1. The AI timeout NEVER yields a bare 503 — it answers
 *      { error: "ai_timeout", ... } with a JSON body.
 *   2. A successful AI pass-through answers 200 with the full prediction
 *      payload (signal, confidence, target, candles, latency metadata).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {},
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../config/secrets", () => ({
  secrets: {
    AI_ENGINE_URL: "http://127.0.0.1:8000",
    AI_ENGINE_API_KEY: "test",
    POCKET_OPTION_SSID: "",
    POCKET_BRIDGE_HOST: "127.0.0.1",
    POCKET_BRIDGE_PORT: 8788,
    POCKET_BRIDGE_RECONNECT_MS: 5000,
    POCKET_BRIDGE_AUTO_SPAWN: "true",
    POCKET_BRIDGE_PYTHON: "",
  },
}));

vi.mock("../../services/symbolRegistry.service", () => ({
  symbolRegistry: {
    normalizeSymbol: (s: string) =>
      typeof s === "string" ? s.trim().toUpperCase().replace(/-/g, "/") : null,
    isValidSymbolSync: () => true,
    getAll: async () => [],
    getDigits: () => 5,
  },
}));

// ── forexDataService scan (each test re-shapes the mocked methods) ──
const forex = vi.hoisted(() => ({
  getLiveSpotFresh: vi.fn(),
  getHistoricalCandles: vi.fn(),
  getBufferedCandles: vi.fn(),
  computeAtr: vi.fn(),
  computeTargetPrice: vi.fn(),
  syncPayouts: vi.fn(),
}));
vi.mock("../../services/forexData.service", () => ({
  forexDataService: {
    getLiveSpotFresh: forex.getLiveSpotFresh,
    getHistoricalCandles: forex.getHistoricalCandles,
    getBufferedCandles: forex.getBufferedCandles,
    computeAtr: forex.computeAtr,
    computeTargetPrice: forex.computeTargetPrice,
    syncPayouts: forex.syncPayouts,
  },
}));

const tickBuffer = vi.hoisted(() => ({
  getLatestEntry: vi.fn(),
  getLatestSpread: vi.fn(),
}));
vi.mock("../../services/realtimeTickBuffer.service", () => ({
  realtimeTickBuffer: {
    getLatestEntry: tickBuffer.getLatestEntry,
    getLatestSpread: tickBuffer.getLatestSpread,
  },
}));

vi.mock("../../services/websocket.service", () => ({
  websocketService: {
    broadcastHighConfidenceSignal: vi.fn(),
    broadcastLiveTick: vi.fn(),
    broadcastEngineStatus: vi.fn(),
    broadcastFeedStatus: vi.fn(),
  },
}));

// Partial axios mock — keep the REAL AxiosError/isAxiosError (needed by the
// failure classifier) while controlling `axios.post` (the AI Engine call).
const axiosPost = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      post: axiosPost.post,
    },
  };
});

import { AxiosError } from "axios";
import {
  clampMinConfidenceToEngineRange,
  clampMinTierToEngineSet,
  readMinTier,
  clampHorizonMinutesToEngineRange,
  clampToEngineTimeframe,
  predictSignal,
  buildPredictCacheKey,
  buildStaleFallbackPayload,
  buildStaleSafetyReport,
  setLastGoodPredict,
  getLastGoodPredict,
} from "../../controllers/signal.controller";
import {
  engineCircuitOpen,
  recordEngineFailure,
  resetEngineCircuit,
} from "../../lib/engineCircuitBreaker";

// ── Express capture shim (mirrors the established test harness) ──
type JsonBody = Record<string, unknown>;
const capture = (): {
  res: Response;
  calls: { code: number; body: JsonBody }[];
  done: Promise<void>;
} => {
  const calls: { code: number; body: JsonBody }[] = [];
  let statusCode = 200;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    statusCode,
    setHeader() {
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: JsonBody) {
      calls.push({ code: statusCode, body });
      resolveDone();
      return res;
    },
  } as unknown as Response;
  return { res, calls, done };
};

const req = (body: Record<string, unknown>): Request =>
  ({ body }) as unknown as Request;

const makeBars = (n = 60): Record<string, unknown>[] => {
  const now = Date.now();
  const bars: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const price = 1.15 + i * 0.0001;
    bars.push({
      timestamp: new Date(now - (n - i) * 60_000).toISOString(),
      open: price,
      high: price + 0.0002,
      low: price - 0.0002,
      close: price,
      volume: 1,
    });
  }
  return bars;
};

const FRESH_TICK = { price: 1.1525, tsMs: Date.now() - 100 };
const AI_PAYLOAD = {
  symbol: "EUR/USD",
  signal: "BUY",
  confidence: 99,
  market_waiting: false,
  target_price: 1.16,
  current_price: 1.1525,
  timeframe: "1d",
  diagnostics: { book: {} },
  book_confluence: { book_confirm: 0.98 },
};

describe("POST /api/v1/predict — 503 body contract (QUICK FIX [1])", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEngineCircuit(); // never let breaker state bleed between tests
    axiosPost.post.mockReset();
    forex.getLiveSpotFresh.mockResolvedValue({
      success: true,
      price: 1.1525,
      source: "test_live",
      error: "",
    });
    forex.getHistoricalCandles.mockResolvedValue({
      success: true,
      symbol: "EUR/USD",
      bars: makeBars(),
      source: "test",
    });
    forex.getBufferedCandles.mockResolvedValue([]);
    forex.computeAtr.mockReturnValue({ atr: 0.004 });
    forex.computeTargetPrice.mockReturnValue(1.16);
    forex.syncPayouts.mockResolvedValue(undefined);
    tickBuffer.getLatestEntry.mockReturnValue(FRESH_TICK);
    tickBuffer.getLatestSpread.mockReturnValue({ bid: 1.1524, ask: 1.1526 });
  });

  it("test_predict_returns_503_with_body_on_timeout", async () => {
    // The AI Engine exceeds the 3s budget and axios surfaces ECONNABORTED.
    axiosPost.post.mockRejectedValue(
      new AxiosError(
        "timeout of 3000ms exceeded",
        "ECONNABORTED",
        undefined,
        undefined,
        undefined,
      ),
    );

    const { res, calls, done } = capture();
    await predictSignal(req({ symbol: "EUR/USD", timeframe: "1d" }), res);
    await done;

    expect(calls.length).toBe(1);
    const [response] = calls;
    expect(response.code).toBe(503);
    // NEVER a bare 503 — ALWAYS a JSON body with a structured error.
    expect(response.body).toBeTruthy();
    expect(response.body.error).toBe("ai_timeout");
    expect(response.body.retryAfterMs).toBe(1000);
    expect(response.body.symbol).toBe("EUR/USD");
    expect(typeof response.body.proxyLatencyMs).toBe("number");
  });

  it("test_predict_returns_200_on_success", async () => {
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    const { res, calls, done } = capture();
    await predictSignal(req({ symbol: "EUR/USD", timeframe: "1d" }), res);
    await done;

    expect(calls.length).toBe(1);
    const [response] = calls;
    expect(response.code).toBe(200);
    // Full prediction payload surfaces verbatim with authoritative metadata.
    expect(response.body.signal).toBe("BUY");
    expect(response.body.confidence).toBe(99);
    expect(response.body.target_price).toBe(1.16);
    expect(response.body.current_price).toBe(1.1525);
    expect(response.body.symbol).toBe("EUR/USD");
    expect(response.body.proxied).toBe(true);
    expect(response.body.market_waiting).toBe(false);
    // STRICT PASS-THROUGH (2026-09-24): the Python engine OWNS the strict
    // 96.5% execution gate. core-backend no longer stamps any executable /
    // regime_gate / regime_status fields — a payload that carries none is
    // proxied as-is (nothing is invented at the integration layer).
    expect(response.body.regime_gate).toBeUndefined();
    expect(response.body.executable).toBeUndefined();
    expect(response.body.regime_status).toBeUndefined();
    expect(Array.isArray(response.body.candles)).toBe(true);
    expect(response.body.candles).toHaveLength(60);
    expect(response.body.barCount).toBe(60);
    expect(typeof response.body.proxyLatencyMs).toBe("number");
  });

  it("test_predict_passes_engine_strict_gate_verbatim — sub-96.5% demotion survives the integration layer", async () => {
    // The engine's strict 96.5% gate is authoritative: a SCORED-ONLY verdict
    // (executable=false, regime_gate="pending_high_precision") must reach the
    // client exactly as the engine emitted it — core-backend never re-stamps.
    axiosPost.post.mockResolvedValue({
      data: {
        ...AI_PAYLOAD,
        executable: false,
        regime_gate: "pending_high_precision",
        regime_status: "PENDING_HIGH_PRECISION",
        suppressed_reason: "below_high_precision_bar",
      },
    });

    const { res, calls, done } = capture();
    await predictSignal(req({ symbol: "EUR/JPY", timeframe: "5m" }), res);
    await done;

    expect(calls.length).toBe(1);
    const [response] = calls;
    expect(response.code).toBe(200);
    expect(response.body.executable).toBe(false);
    expect(response.body.regime_gate).toBe("pending_high_precision");
    expect(response.body.regime_status).toBe("PENDING_HIGH_PRECISION");
    expect(response.body.suppressed_reason).toBe("below_high_precision_bar");
  });

  // ── HIGH-PRECISION GATE TIMEOUT MISSION (2026-09-24) ──
  it("test_clamp_to_engine_timeframe_maps_non_supported_buckets", () => {
    // Buckets the engine Pydantic whitelist rejects must be clamped to the
    // nearest valid DISPATCH bucket so strict validation never 400s → 503.
    expect(clampToEngineTimeframe("1d")).toBe("1d");
    expect(clampToEngineTimeframe("2d")).toBe("2d");
    expect(clampToEngineTimeframe("5d")).toBe("5d");
    expect(clampToEngineTimeframe("25m")).toBe("25m");
    expect(clampToEngineTimeframe("30m")).toBe("30m");
    // "7d" is NOT in the engine whitelist (1d/2d/3d/5d/10d) → clamp UP, never
    // undershoot the horizon.
    expect(clampToEngineTimeframe("7d")).toBe("10d");
    expect(clampToEngineTimeframe("4d")).toBe("5d");
    // minutes ≥ 35 collapse onto the engine's "35m+" bucket (no undershoot).
    expect(clampToEngineTimeframe("35m")).toBe("35m+");
    expect(clampToEngineTimeframe("40m")).toBe("35m+");
    expect(clampToEngineTimeframe("45m")).toBe("35m+");
    // unlisted minutes clamp UP to the smallest valid covering bucket.
    expect(clampToEngineTimeframe("4m")).toBe("5m");
    expect(clampToEngineTimeframe("12m")).toBe("15m");
    // hours: 1h / 4h / ≥1d buckets only.
    expect(clampToEngineTimeframe("2h")).toBe("1h");
    expect(clampToEngineTimeframe("12h")).toBe("4h");
    expect(clampToEngineTimeframe("36h")).toBe("1d");
    // days clamp up to the largest valid bucket.
    expect(clampToEngineTimeframe("21d")).toBe("10d");
    // garbage / sub-minute / empty all land on the "1m" floor.
    expect(clampToEngineTimeframe("20ms")).toBe("1m");
    expect(clampToEngineTimeframe("S5")).toBe("1m");
    expect(clampToEngineTimeframe("")).toBe("1m");
  });

  it("test_clamp_min_confidence_to_engine_range", () => {
    // The engine Pydantic schema enforces 50..99 via ge/le (out-of-range →
    // 400 → permanent 503), so the integration layer clamps the Confidence
    // Filter before forwarding. Absent / non-numeric → null (engine default).
    expect(clampMinConfidenceToEngineRange(undefined)).toBeNull();
    expect(clampMinConfidenceToEngineRange(null)).toBeNull();
    expect(clampMinConfidenceToEngineRange("nope")).toBeNull();
    expect(clampMinConfidenceToEngineRange()).toBeNull();
    // In-range values ride through untouched.
    expect(clampMinConfidenceToEngineRange(75)).toBe(75);
    expect(clampMinConfidenceToEngineRange(50)).toBe(50);
    expect(clampMinConfidenceToEngineRange(99)).toBe(99);
    expect(clampMinConfidenceToEngineRange("80.5")).toBe(80.5);
    // Below/above the engine range clamp hard to 50 / 99.
    expect(clampMinConfidenceToEngineRange(30)).toBe(50);
    expect(clampMinConfidenceToEngineRange(49.9)).toBe(50);
    expect(clampMinConfidenceToEngineRange(0)).toBe(50);
    expect(clampMinConfidenceToEngineRange(99.1)).toBe(99);
    expect(clampMinConfidenceToEngineRange(120)).toBe(99);
  });

  it("test_predict_forwards_min_confidence_to_engine_payload", async () => {
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    // Sent → clamped value rides the engine payload under `min_confidence`.
    const withFilter = capture();
    await predictSignal(
      req({ symbol: "EUR/USD", timeframe: "1d", minConfidence: 88 }),
      withFilter.res,
    );
    await withFilter.done;
    const sentPayload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
    expect(sentPayload.min_confidence).toBe(88);

    // Out-of-range Filter still forwards a valid (clamped) value — never 400s.
    axiosPost.post.mockClear();
    const clamped = capture();
    await predictSignal(
      req({ symbol: "EUR/GBP", timeframe: "1d", minConfidence: 25 }),
      clamped.res,
    );
    await clamped.done;
    const clampedPayload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
    expect(clampedPayload.min_confidence).toBe(50);

    // Absent → NOT forwarded (engine default 96.5% bar, no behavior change).
    // Distinct symbol so the shared 5s result cache is not warm for this key.
    axiosPost.post.mockClear();
    const noFilter = capture();
    await predictSignal(req({ symbol: "EUR/AUD", timeframe: "1d" }), noFilter.res);
    await noFilter.done;
    const defaultPayload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
    expect("min_confidence" in defaultPayload).toBe(false);
  });

  it("test_predict_reads_min_confidence_from_snake_case_wire", async () => {
    // The browser client sends `min_confidence` (the engine-native key), NOT
    // `minConfidence`. A camelCase-only destructure silently dropped the
    // operator's Confidence Filter, so the engine always applied its default
    // 96.5% bar. Both spellings must reach the payload.
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    const snake = capture();
    await predictSignal(
      req({ symbol: "EUR/CAD", timeframe: "1d", min_confidence: 88 }),
      snake.res,
    );
    await snake.done;
    const snakePayload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
    expect(snakePayload.min_confidence).toBe(88);
  });

  // ── FLEXIBLE TIER FLOOR (min_tier) ──────────────────────────────────────
  it("test_predict_forwards_min_tier_to_engine_payload", async () => {
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    // Every valid tier reaches the engine verbatim.
    for (const tier of ["T1", "T2", "T3", "T4", "T5"]) {
      axiosPost.post.mockClear();
      const c = capture();
      await predictSignal(
        req({ symbol: "EUR/CHF", timeframe: "1d", min_tier: tier }),
        c.res,
      );
      await c.done;
      const payload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.min_tier).toBe(tier);
    }
  });

  it("test_predict_normalises_min_tier_case_and_whitespace", async () => {
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    axiosPost.post.mockClear();
    const lower = capture();
    await predictSignal(
      req({ symbol: "AUD/CAD", timeframe: "1d", min_tier: "t3" }),
      lower.res,
    );
    await lower.done;
    expect((axiosPost.post.mock.calls[0][1] as Record<string, unknown>).min_tier).toBe(
      "T3",
    );

    axiosPost.post.mockClear();
    const spaced = capture();
    await predictSignal(
      req({ symbol: "AUD/CHF", timeframe: "1d", min_tier: "  t4  " }),
      spaced.res,
    );
    await spaced.done;
    expect((axiosPost.post.mock.calls[0][1] as Record<string, unknown>).min_tier).toBe(
      "T4",
    );
  });

  it("test_predict_reads_min_tier_from_camelCase_wire", async () => {
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    const camel = capture();
    await predictSignal(
      req({ symbol: "GBP/CAD", timeframe: "1d", minTier: "T2" }),
      camel.res,
    );
    await camel.done;
    expect((axiosPost.post.mock.calls[0][1] as Record<string, unknown>).min_tier).toBe(
      "T2",
    );
  });

  it("test_predict_omits_garbage_min_tier_so_engine_default_applies", async () => {
    // The bridge must never invent a preference. An unrecognised tier is
    // dropped, leaving the engine on its documented T1 default — forwarding
    // garbage would either 422 or silently widen the executable bar.
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    // A distinct timeframe per case keeps each request on its own cache key, so
    // every iteration genuinely reaches the engine.
    const garbage = ["T9", "", "   ", "premium", 3, null, {}];
    const frames = ["1d", "2d", "3d", "5d", "10d", "1h", "4h"];
    for (let i = 0; i < garbage.length; i++) {
      axiosPost.post.mockClear();
      const c = capture();
      await predictSignal(
        req({ symbol: "NZD/USD", timeframe: frames[i], min_tier: garbage[i] }),
        c.res,
      );
      await c.done;
      const payload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
      expect("min_tier" in payload).toBe(false);
    }
  });

  it("test_predict_omits_min_tier_when_absent", async () => {
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    const c = capture();
    await predictSignal(req({ symbol: "USD/CAD", timeframe: "1d" }), c.res);
    await c.done;
    expect("min_tier" in (axiosPost.post.mock.calls[0][1] as Record<string, unknown>)).toBe(
      false,
    );
  });

  it("test_min_tier_is_part_of_the_predict_cache_identity", () => {
    // A T4 request must never be served a verdict evaluated under the T1
    // default bar from inside the shared 5s result cache.
    const t1 = buildPredictCacheKey("EUR/USD", "1d", null, null, "T1");
    const t4 = buildPredictCacheKey("EUR/USD", "1d", null, null, "T4");
    const def = buildPredictCacheKey("EUR/USD", "1d", null, null, null);
    expect(new Set([t1, t4, def]).size).toBe(3);
    // Legacy 4-arg calls stay distinct from an explicit "T1" selection only
    // where it matters; both must be stable and non-empty.
    expect(buildPredictCacheKey("EUR/USD", "1d", null, null)).toBe(
      buildPredictCacheKey("EUR/USD", "1d", null, null),
    );
  });

  it("test_clamp_min_tier_to_engine_set", () => {
    expect(clampMinTierToEngineSet("T1")).toBe("T1");
    expect(clampMinTierToEngineSet("t5")).toBe("T5");
    expect(clampMinTierToEngineSet(" T3 ")).toBe("T3");
    expect(clampMinTierToEngineSet("T0")).toBeNull();
    expect(clampMinTierToEngineSet("PREMIUM")).toBeNull();
    expect(clampMinTierToEngineSet("")).toBeNull();
    expect(clampMinTierToEngineSet(undefined)).toBeNull();
    expect(clampMinTierToEngineSet(2)).toBeNull();
    expect(clampMinTierToEngineSet({ tier: "T2" })).toBeNull();
  });

  it("test_read_min_tier_accepts_both_wire_spellings", () => {
    expect(readMinTier({ min_tier: "T4" })).toBe("T4");
    expect(readMinTier({ minTier: "t2" })).toBe("T2");
    // snake_case wins when both are present (engine-native key is canonical).
    expect(readMinTier({ min_tier: "T1", minTier: "T4" })).toBe("T1");
    expect(readMinTier({})).toBeNull();
    expect(readMinTier(null)).toBeNull();
    expect(readMinTier("T3")).toBeNull();
  });

  it("test_clamp_horizon_minutes_to_engine_range", () => {
    // Mirrors resolve_horizon_minutes() in ai-engine horizon_engine.py,
    // including the floor bias on ties.
    expect(clampHorizonMinutesToEngineRange(undefined)).toBeNull();
    expect(clampHorizonMinutesToEngineRange(null)).toBeNull();
    expect(clampHorizonMinutesToEngineRange("")).toBeNull();
    expect(clampHorizonMinutesToEngineRange("nope")).toBeNull();
    expect(clampHorizonMinutesToEngineRange(0)).toBeNull();
    expect(clampHorizonMinutesToEngineRange(-5)).toBeNull();
    // Supported steps pass through untouched.
    for (const h of [1, 2, 3, 5, 10]) {
      expect(clampHorizonMinutesToEngineRange(h)).toBe(h);
    }
    // String numerics from JSON are accepted.
    expect(clampHorizonMinutesToEngineRange("3")).toBe(3);
    // Unsupported steps snap to the NEAREST step, ties going SHORTER.
    expect(clampHorizonMinutesToEngineRange(4)).toBe(3);
    expect(clampHorizonMinutesToEngineRange(6)).toBe(5);
    expect(clampHorizonMinutesToEngineRange(7)).toBe(5);
    expect(clampHorizonMinutesToEngineRange(30)).toBe(10);
  });

  it("test_predict_forwards_horizon_minutes_to_engine_payload", async () => {
    // THE REGRESSION: the Pro Expiry Bar selection must reach the engine so a
    // 3m request is actually evaluated at 3m. Before this fix the field was
    // never forwarded and the engine fell back to its 1m default for every
    // request, which is why the expiry buttons appeared inert.
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    const picked = capture();
    await predictSignal(
      req({ symbol: "USD/CHF", timeframe: "1d", horizon_minutes: 3 }),
      picked.res,
    );
    await picked.done;
    const pickedPayload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
    expect(pickedPayload.horizon_minutes).toBe(3);
  });

  it("test_predict_accepts_camel_case_horizon_minutes", async () => {
    // The inference-bridge spelling is accepted alongside the engine-native one.
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    const camel = capture();
    await predictSignal(
      req({ symbol: "EUR/NZD", timeframe: "1d", horizonMinutes: 10 }),
      camel.res,
    );
    await camel.done;
    const camelPayload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
    expect(camelPayload.horizon_minutes).toBe(10);
  });

  it("test_predict_snaps_unsupported_horizon_to_engine_step", async () => {
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    const snapped = capture();
    await predictSignal(
      req({ symbol: "GBP/CHF", timeframe: "1d", horizon_minutes: 4 }),
      snapped.res,
    );
    await snapped.done;
    const snappedPayload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
    // 4m is unsupported → snaps to 3m (floor bias), never 5m.
    expect(snappedPayload.horizon_minutes).toBe(3);
  });

  it("test_predict_omits_horizon_when_absent_so_engine_default_applies", async () => {
    // Absent → NOT forwarded. The engine's own resolve_horizon_minutes()
    // default applies; the integration layer never invents a horizon.
    axiosPost.post.mockResolvedValue({ data: AI_PAYLOAD });

    const absent = capture();
    await predictSignal(
      req({ symbol: "AUD/CAD", timeframe: "1d" }),
      absent.res,
    );
    await absent.done;
    const absentPayload = axiosPost.post.mock.calls[0][1] as Record<string, unknown>;
    expect("horizon_minutes" in absentPayload).toBe(false);
  });

  it("test_predict_does_not_serve_cached_result_across_horizons", async () => {
    // The 5s result cache must key on the horizon too. Sharing one key across
    // horizons let a 3m request be answered with a 5m verdict from inside the
    // TTL — the button appeared to do nothing even with the field forwarded.
    axiosPost.post.mockReset();
    axiosPost.post.mockResolvedValue({
      data: { ...AI_PAYLOAD, horizon_minutes: 3, target_price: 1.16 },
    });

    const first = capture();
    await predictSignal(
      req({ symbol: "USD/JPY", timeframe: "1d", horizon_minutes: 3 }),
      first.res,
    );
    await first.done;
    expect(axiosPost.post).toHaveBeenCalledTimes(1);

    // Same symbol/timeframe, DIFFERENT horizon → must NOT be served from cache.
    axiosPost.post.mockResolvedValue({
      data: { ...AI_PAYLOAD, horizon_minutes: 10, target_price: 1.19 },
    });
    const second = capture();
    await predictSignal(
      req({ symbol: "NZD/USD", timeframe: "1d", horizon_minutes: 10 }),
      second.res,
    );
    await second.done;
    expect(axiosPost.post).toHaveBeenCalledTimes(2);
    // The response is the 10m verdict, not the cached 3m one.
    // (target_price is NOT asserted: the controller authoritatively recomputes
    // it from ATR, so it never reflects the engine's echoed value.)
    expect(second.calls[0].body.horizon_minutes).toBe(10);

    // Repeating the SAME horizon inside the TTL IS served from cache.
    const third = capture();
    await predictSignal(
      req({ symbol: "NZD/USD", timeframe: "1d", horizon_minutes: 10 }),
      third.res,
    );
    await third.done;
    expect(axiosPost.post).toHaveBeenCalledTimes(2);
  });

  it("test_predict_serves_last_good_stale_payload_when_engine_budget_exceeded", async () => {
    // When the strict 96.5% evaluation exceeds its inference budget and a REAL
    // prior verdict exists for this pair, the endpoint MUST serve that real
    // verdict stamped stale (never a bare 503), with recoverable diagnostics.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // 1) Warm the last-good cache with a genuine success (EUR/USD::1h).
      axiosPost.post.mockReset();
      axiosPost.post.mockResolvedValueOnce({
        data: { ...AI_PAYLOAD, timeframe: "1h" },
      });
      const first = capture();
      await predictSignal(req({ symbol: "EUR/USD", timeframe: "1h" }), first.res);
      await first.done;
      expect(first.calls.length).toBe(1);
      expect(first.calls[0].code).toBe(200);

      // 2) Age out the 5s dedupe cache (last-good TTL is 60s → still valid).
      vi.setSystemTime(Date.now() + 6_000);

      // 3) Engine blows its budget → stale fallback, not a hard 503.
      axiosPost.post.mockReset();
      axiosPost.post.mockRejectedValue(
        new AxiosError(
          "timeout of 120000ms exceeded",
          "ECONNABORTED",
          undefined,
          undefined,
          undefined,
        ),
      );
      const second = capture();
      await predictSignal(req({ symbol: "EUR/USD", timeframe: "1h" }), second.res);
      await second.done;

      expect(second.calls.length).toBe(1);
      const stale = second.calls[0];
      expect(stale.code).toBe(200);
      expect(stale.body.error).toBe("ai_timeout");
      expect(stale.body.stale).toBe(true);
      expect(stale.body.recoverable).toBe(true);
      expect(stale.body.aiEngineAvailable).toBe(false);
      expect(stale.body.aiEngineFailure.kind).toBe("timeout");
      expect(stale.body.retryAfterMs).toBe(1000);
      // The real directional verdict is preserved (never re-computed/faked).
      expect(stale.body.signal).toBe("BUY");
      expect(stale.body.confidence).toBe(99);
      expect(stale.body.symbol).toBe("EUR/USD");
      expect(typeof stale.body.stale_at).toBe("string");
      expect(typeof stale.body.proxyLatencyMs).toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER + STALE RE-ARM SAFETY BOUNDS (resilient fallback)
// ════════════════════════════════════════════════════════════════════
describe("CIRCUIT BREAKER — fast fail into fallback, never a retry storm", () => {
  const ENGINE_URL = "http://127.0.0.1:8000/api/v1/predict";

  beforeEach(() => {
    resetEngineCircuit();
  });

  it("test_predict_skips_engine_when_circuit_open_and_serves_rearmed_stale", async () => {
    // Seed a REAL prior verdict under the exact cacheKey predictSignal
    // computes for GBP/USD::1d (no filter, no horizon) — an executable,
    // directional one. Built with the shared helper so it can never drift
    // from the controller's own identity.
    setLastGoodPredict(
      buildPredictCacheKey("GBP/USD", "1d", null, null),
      {
        ...AI_PAYLOAD,
        symbol: "GBP/USD",
        executable: true,
        regime_gate: "tradable",
        confidence: 99,
        current_price: 1.1525,
      },
    );
    // Trip the breaker past its threshold.
    recordEngineFailure(ENGINE_URL);
    recordEngineFailure(ENGINE_URL);
    recordEngineFailure(ENGINE_URL);
    expect(engineCircuitOpen(ENGINE_URL)).toBe(true);

    axiosPost.post.mockClear();
    const { res, calls, done } = capture();
    await predictSignal(req({ symbol: "GBP/USD", timeframe: "1d" }), res);
    await done;

    // The engine was NOT re-attempted (no storm against a down service).
    expect(axiosPost.post).not.toHaveBeenCalled();
    expect(calls.length).toBe(1);
    const [response] = calls;
    // Stale-while-unavailable serves the last-good verdict (200, not 503).
    expect(response.code).toBe(200);
    expect(response.body.error).toBe("ai_unavailable");
    expect(response.body.stale).toBe(true);
    expect(response.body.signal).toBe("BUY");
    expect(response.body.confidence).toBe(99);
    // Safe volatility bounds verified from FRESH bars on THIS request:
    // price drift 0, ATR 0.004/1.1525 ≈ 0.347% < 0.8% → executable RE-ARMED.
    expect(response.body.executable).toBe(true);
    const fallback = response.body.fallback as {
      rearmed_executable: boolean;
      bounded: boolean;
      price_drift_pct: number;
      atr_pct: number;
      safety_bounds: { max_price_drift_pct: number; max_atr_pct: number };
    };
    expect(fallback.rearmed_executable).toBe(true);
    expect(fallback.bounded).toBe(true);
    expect(fallback.price_drift_pct).toBe(0);
    expect(fallback.atr_pct).toBeGreaterThan(0);
    expect(fallback.atr_pct).toBeLessThan(fallback.safety_bounds.max_atr_pct);
  });
});

describe("STALE RE-ARM SAFETY BOUNDS — unit contract", () => {
  beforeEach(() => {
    resetEngineCircuit();
  });

  it("buildStaleSafetyReport returns safe inside the bounds", () => {
    const lastGood = {
      response: { signal: "BUY", current_price: 1.1525, executable: true },
    };
    const rep = buildStaleSafetyReport(lastGood, 1.1525, 0.004);
    expect(rep.safe).toBe(true);
    expect(rep.priceDriftPct).toBe(0);
    expect(rep.atrPct).toBeCloseTo(0.3471, 3);
    expect(rep.reasons).toEqual([]);
  });

  it("buildStaleSafetyReport flags price drift outside bounds", () => {
    const lastGood = {
      response: { signal: "BUY", current_price: 1.15, executable: true },
    };
    const rep = buildStaleSafetyReport(lastGood, 1.2, 0.004);
    expect(rep.safe).toBe(false);
    expect(rep.reasons).toContain("price_drift_exceeds_bounds");
  });

  it("buildStaleSafetyReport flags a volatility burst outside bounds", () => {
    const lastGood = {
      response: { signal: "BUY", current_price: 1.1525, executable: true },
    };
    // ATR 2% of price ≈ 1.73% > 0.8% safe ceiling.
    const rep = buildStaleSafetyReport(lastGood, 1.1525, 0.02);
    expect(rep.safe).toBe(false);
    expect(rep.reasons).toContain("volatility_exceeds_safe_bounds");
  });

  it("buildStaleSafetyReport refuses to re-arm when ATR cannot be verified", () => {
    const lastGood = {
      response: { signal: "BUY", current_price: 1.1525, executable: true },
    };
    const rep = buildStaleSafetyReport(lastGood, 1.1525, 0);
    expect(rep.safe).toBe(false);
    expect(rep.reasons).toContain("atr_unavailable");
  });

  it("buildStaleFallbackPayload re-arms executable ONLY inside safe bounds", () => {
    const key = "unit-test::rearm::ok";
    setLastGoodPredict(key, {
      signal: "BUY",
      confidence: 99,
      current_price: 1.1525,
      executable: true,
    });
    const safety = buildStaleSafetyReport(getLastGoodPredict(key), 1.1525, 0.004);
    const payload = buildStaleFallbackPayload(
      key,
      "ai_unavailable",
      42,
      { kind: "unreachable", code: "ECONNREFUSED", detail: "down" },
      safety,
    );
    expect(payload).not.toBeNull();
    const fallback = payload?.fallback as {
      rearmed_executable: boolean;
      bounded: boolean;
      safety_bounds: { max_price_drift_pct: number };
    };
    expect(payload?.executable).toBe(true);
    expect(payload?.stale).toBe(true);
    expect(fallback.rearmed_executable).toBe(true);
    expect(fallback.bounded).toBe(true);
    expect(fallback.safety_bounds.max_price_drift_pct).toBeGreaterThan(0);
  });

  it("buildStaleFallbackPayload demotes executable outside safe bounds", () => {
    const key = "unit-test::rearm::drift";
    setLastGoodPredict(key, {
      signal: "BUY",
      confidence: 99,
      current_price: 1.1525,
      executable: true,
    });
    const safety = buildStaleSafetyReport(getLastGoodPredict(key), 1.2, 0.004);
    const payload = buildStaleFallbackPayload(
      key,
      "ai_unavailable",
      42,
      { kind: "unreachable", code: "ECONNREFUSED", detail: "down" },
      safety,
    );
    expect(payload).not.toBeNull();
    const fallback = payload?.fallback as {
      rearmed_executable: boolean;
      bounded: boolean;
    };
    expect(payload?.executable).toBe(false);
    expect(payload?.regime_gate).toBe("pending_high_precision");
    expect(payload?.suppressed_reason).toBe("stale_market_out_of_safety_bounds");
    expect(fallback.rearmed_executable).toBe(false);
    expect(fallback.bounded).toBe(false);
  });

  it("buildStaleFallbackPayload never promotes a non-executable verdict", () => {
    const key = "unit-test::rearm::scored_only";
    setLastGoodPredict(key, {
      signal: "BUY",
      confidence: 80,
      current_price: 1.1525,
      executable: false,
    });
    const safety = buildStaleSafetyReport(getLastGoodPredict(key), 1.1525, 0.004);
    const payload = buildStaleFallbackPayload(
      key,
      "ai_unavailable",
      42,
      { kind: "unreachable", code: "ECONNREFUSED", detail: "down" },
      safety,
    );
    expect(payload).not.toBeNull();
    const fallback = payload?.fallback as { rearmed_executable: boolean };
    expect(payload?.executable).toBe(false);
    expect(fallback.rearmed_executable).toBe(false);
  });
});