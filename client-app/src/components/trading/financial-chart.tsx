"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  CrosshairMode,
  UTCTimestamp,
  LineStyle,
  LineData,
  IPriceLine,
} from "lightweight-charts";
import { useTradingStore, realtimeAggregator } from "@/store/useTradingStore";
import { useTheme } from "@/hooks/useTheme";
import { useLangContext } from "@/hooks/useLangContext";
import {
  TIMEFRAME_MS,
  isTimeframe,
  bucketStart,
  leadShiftBucket,
  LOOKAHEAD_HORIZON_OPTIONS,
  type LookaheadEvent,
  type LookaheadCandle,
  type LookaheadHorizonMinutes,
  type Candle,
  type Timeframe as AggTimeframe,
  detectSystematicSeedSkew,
  toHeikinAshiSeries,
} from "@/lib/realtimeCandleAggregator";
import { getPriceDigits, getPairLabel } from "@/constants/symbols";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";

interface APICandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface FinancialChartProps {
  symbol: string;
  timeframe?: string;
  data?: APICandle[];
  height?: number;
  currentPrice?: number;
  /** AI-predicted target price — the level the predictive candles drive toward. */
  predictedTargetPrice?: number;
  /** Price at which the active prediction was computed (backend `current_price`). */
  predictionAnchorPrice?: number;
  /** Real ATR from the live prediction — scales the predictive candle wicks. */
  atr?: number;
  /** Expiry horizon in minutes (maps to the 1m/2m/3m… expiration selector). */
  projectionMinutes?: number;
  /** Active AI signal — drives the predictive-candle direction & colour. */
  signal?: "BUY" | "SELL" | null;
  /**
   * Predictive lookahead horizon in minutes (1|2|3|5). How far AHEAD of the
   * external platform's timeline the aggregator pre-renders projected target
   * candles. Optional — the aggregator's configured default is used when unset.
   */
  lookaheadHorizon?: LookaheadHorizonMinutes;
  /**
   * True when the Socket.io transport is connected but no live_tick has
   * arrived recently (stream stall). When set, the chart shows a genuine
   * "WAITING FOR LIVE STREAM..." overlay on top of the existing series —
   * never fabricated/filler bars.
   */
  streamStalled?: boolean;
  /**
   * True when the most recent PRICE packet is older than 2 seconds (the price
   * is stale). The chart warns the user instead of displaying it as live.
   */
  stalePrice?: boolean;
}

const CHART_THEMES = {
  // ── OBSIDIAN INSTITUTIONAL DARK (neutral slate-on-deep-charcoal) ──
  // Chart wells drop one step below the #0B0E14 shell into #070910; grid and
  // axis text use neutral slate (no legacy navy tint).
  dark: {
    background: "#070910",
    text: "#94a3b8",
    grid: "rgba(148, 163, 184, 0.14)",
    border: "#2a3448",
    crosshair: "rgba(148, 163, 184, 0.35)",
    crosshairLabelBg: "#171c28",
    containerBg: "#070910",
    containerBorder: "rgba(30, 41, 59, 0.9)",
  },
} as const;

/** Pocket Option professional candles — subdued teal/coral that render crisp
 *  bodies, borders and wicks at all zoom levels without bloom. Matches the
 *  classic Pocket Option terminal palette (#26a69a / #ef5350). */
const BULLISH = "#26a69a";
const BEARISH = "#ef5350";
/** Leading (predictive) projection line — a distinct animated marker that
 *  anticipates where the ACTIVE forming candle's close will land, drawn from
 *  the aggregator's real-data momentum model. Amber keeps it visually separate
 *  from the confirmed green/red candles; a dotted dash reads as "projection",
 *  never as a real traded price. */
const LEADING_LINE = "rgba(250,204,21,0.8)";
/** Dim neutral shade for forecast candles that have not opened yet — they sit
 *  on their grid slot as quiet "planning" stubs and light up in signal colour
 *  only when their own formation window begins (no instant dump of targets). */
const FORECAST_PENDING = "rgba(100,116,139,0.55)";
const FORECAST_PENDING_WICK = "rgba(100,116,139,0.35)";
/** Predictive-lookahead target candles — pre-rendered AHEAD of the live
 *  timeline (the amount of external-platform latency beaten). Colour IS the
 *  signal: teal for projected-up candles, coral for projected-down, so the
 *  trader reads the closing direction (Green/Red) of the upcoming bars at a
 *  glance — exactly the info needed before placing against the projected
 *  high/low. Hollow dashed bodies reinforce "not yet traded". */
const LOOKAHEAD_WICK = "rgba(56,189,248,0.35)";

// ── AI PROJECTED PRICE-TARGET BAND ──
// High/Low horizontal boundaries rendered as dashed native price lines on the
// confirmed candle series. The backend exposes a single target level plus ATR
// volatility (never an explicit range), so the band is derived client-side:
// Teal marks the projected CEILING (High), Amber the projected FLOOR (Low), so
// the trader reads the exact expected wick range — the two levels the AI
// expects price to reach — at a glance, without a fabricating forward candle.
const TARGET_HIGH_COLOR = "rgba(45,212,191,0.9)";
const TARGET_LOW_COLOR = "rgba(251,191,36,0.9)";

// ── PREDICTIVE LEAD-TIME OFFSET OPTIONS ──
// Wall-clock lead (ms) the forming candle is projected AHEAD of the external
// platform's confirmed timeline. NULL = aggregator default (exactly one
// selected timeframe bucket ahead).
const LEAD_OFFSET_OPTIONS: { label: string; value: number | null }[] = [
  { label: "AUTO", value: null },
  { label: "20S", value: 20_000 },
  { label: "1M", value: 60_000 },
];

// ── GHOST GLOW TRAIL (HA_Close momentum after-glow) ──
// A two-layer professional after-glow riding the aggregator's native HA_Close:
// a wide low-alpha HALO line + a thin bright CORE line. Colour follows the
// bar's own direction (teal up / coral down) per point, so the trail reads as
// the candle's genuine momentum shadow — purely decorative, price-scale neutral
// (autoscaleInfoProvider: () => null) and zero layout impact.
const GHOST_HALO_BULL = "rgba(38,166,154,0.13)";
const GHOST_HALO_BEAR = "rgba(239,83,80,0.13)";
const GHOST_CORE_BULL = "rgba(56,207,192,0.95)";
const GHOST_CORE_BEAR = "rgba(255,107,107,0.95)";

// ── EXACT GEOMETRY / PROPORTIONAL SPACING (zero distortion, zero stubs) ──
// Candle columns start at a dense professional 9px terminal density so ~42
// candles stay in view on every screen. Zoom is REAL: `minBarSpacing` pins a
// 2px floor (bars can never compress into invisible stubs) and zoom-IN widens
// columns continuously — lightweight-charts scales body + wick proportionally
// at every level, so a zoomed bar is always a full-width, full-shadow candle.
const MIN_BAR_SPACING_PX = 2;
const INITIAL_BAR_SPACING_PX = 9;
/** Constant dense candle count in view (matches DENSE_VISIBLE_BARS below). */
const BARS_PER_FRAME = 42;

/** Clamp any real number into the closed [0,1] interval (formation pct). */
function clamp01(n: number): number {
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
}

/**
 * GHOST GLOW TRAIL data — maps a candle array onto directional line points for
 * the halo/core pair. `value` is the bar's close (HA_Close on the live path,
 * where the aggregator already folds Heikin-Ashi); colour per point follows the
 * bar's own direction (teal up / coral down). Reflexive for the live tip push.
 */
function ghostGlowData(
  candles: Array<{ time: unknown; open: number; close: number }>,
  bull: string,
  bear: string,
): LineData[] {
  return candles.map((c) => ({
    time: c.time as UTCTimestamp,
    value: c.close,
    color: c.close >= c.open ? bull : bear,
  }));
}

/**
 * GHOST GLOW TIP push — advances the halo/core pair in place for a live bar
 * (one `update` call each, same tick stack as the confirmed candle). Idempotent
 * and disposal-safe: a disposed/null series is a silent no-op.
 */
function updateGhostTip(
  glow: ISeriesApi<"Line"> | null,
  trail: ISeriesApi<"Line"> | null,
  candle: { time: unknown; open: number; close: number },
): void {
  if (!glow && !trail) return;
  const t = candle.time as unknown as UTCTimestamp;
  const up = candle.close >= candle.open;
  try {
    glow?.update({
      time: t,
      value: candle.close,
      color: up ? GHOST_HALO_BULL : GHOST_HALO_BEAR,
    });
    trail?.update({
      time: t,
      value: candle.close,
      color: up ? GHOST_CORE_BULL : GHOST_CORE_BEAR,
    });
  } catch {
    // Cosmetic overlay — a transient race must never break the live path.
  }
}

/**
 * WICK-SHAPE GUARD — canonical Japanese candlestick geometry.
 *
 * Guarantees a candle can never render a truncated/absent shadow: high must be
 * >= max(open, close) and low <= min(open, close). Any upstream feed that ever
 * delivers INVERTED OHLC (e.g. high < open or low > close) makes
 * lightweight-charts draw a zero-height wick rect — the shadow silently
 * vanishes → "stubby/truncated" bars. This guard normalises the real numbers
 * back to a well-formed body: it only REPAIRS a malformed readout and never
 * invents a price level. Applied at every candle entry point (zero-hop push,
 * merged live slice) so wicks stay full and sharp on every pair and zoom.
 */
function normalizeOHLC(
  o: number,
  h: number,
  l: number,
  c: number,
): { open: number; high: number; low: number; close: number } {
  const close = Number.isFinite(c) && c > 0 ? c : 0;
  const open =
    close > 0 && Number.isFinite(o) && o > 0 ? o : close > 0 ? close : 0;
  let high = Number.isFinite(h)
    ? Math.max(h, open, close)
    : Math.max(open, close);
  let low = Number.isFinite(l)
    ? Math.min(l, open, close)
    : Math.min(open, close);
  // L1-PURE: no synthetic wick interpolation. A fully degenerate bar
  // (open === high === low === close, a genuine quiet-print flat line) renders
  // 1:1 with the real tape — identical to Pocket Option's own print. We never
  // fabricate an envelope around a real price level.
  return { open, high, low, close };
}

// ── SIGNAL-DRIVEN LIVE CANDLE COLOR ──
// The rightmost forming candle's colour is strictly pinned to the ACTIVE AI
// signal so the terminal visually reinforces the trade direction:
//   BUY      → bullish green
//   SELL     → bearish red
//   none     → neutral (falls back to real price direction).
// Returns [fill, wick] so callers can paint both the body and its shadows.
function signalColor(signal: string | null | undefined): string | null {
  if (signal === "BUY" || signal === "CALL") return BULLISH;
  if (signal === "SELL" || signal === "PUT") return BEARISH;
  return null;
}

// ── NATIVE RAW CANDLESTICK RENDERING (1:1 PO parity) ──
// The main candle series is the aggregator's RAW OHLC output (getSeries
// returns standard close-based candlesticks — no Heikin-Ashi fold anywhere in
// the live path). This mirrors Pocket Option's raw candle formation: the
// forming candle morphs on every real tick, the body is a real open→close
// range, and wick extremes are the true high/low. History+live share one RAW
// encoding, so the history→live seam never mixes bar types. (Legacy HA fold
// machinery — chart-side or aggregator emissions — has been removed; the
// aggregator's continuity/gap bars are emitted RAW for the same reason.)

/**
 * UNIFIED TIMESTAMP NORMALISATION — the single source of truth for the chart's
 * x-axis grid. Every incoming live tick AND every historical candle timestamp
 * MUST pass through this one function.
 *
 * It accepts epoch-ms OR epoch-seconds (ISO strings are parsed to ms by the
 * caller first) and strictly returns the ACTIVE bucket's floor-aligned wall-
 * clock boundary (`Math.floor(ts / bucketMs) * bucketMs`) as a chart
 * UTCTimestamp (seconds). This is byte-identical to the live aggregator's
 * `bucketStart`, so generated, historical and live candles all land on the
 * SAME x-axis with zero sub-second drift, zero raw `Date.now()` residue and
 * zero disconnected coordinates.
 *
 * Idempotent: re-floors an already-floored instant to the same boundary.
 */
function toChartTime(timestamp: number, bucketMs?: number): UTCTimestamp {
  let ms = Number(timestamp);
  if (!Number.isFinite(ms) || ms <= 0) return 0 as UTCTimestamp;
  // Epoch-seconds → ms so every input lands on one unit BEFORE flooring.
  if (ms < 1_000_000_000_000) ms = ms * 1000;
  const bucket = bucketMs && bucketMs > 0 ? bucketMs : 60_000;
  const flooredMs = Math.floor(ms / bucket) * bucket;
  return (flooredMs / 1000) as UTCTimestamp;
}

export const FinancialChart: React.FC<FinancialChartProps> = ({
  symbol,
  timeframe = "1m",
  data = [],
  height = 400,
  currentPrice,
  predictedTargetPrice,
  predictionAnchorPrice,
  atr = 0,
  projectionMinutes = 1,
  signal,
  lookaheadHorizon,
  streamStalled = false,
  stalePrice = false,
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  // ── PREDICTIVE LEAD-TIME OFFSET (projection-ahead config) ──
  // User-chosen wall-clock lead (ms) the forming candle projects ahead of the
  // external feed. NULL = aggregator default (one selected timeframe). Bound to
  // the store so the selector persists, re-buckets live and triggers a full
  // grid reset on change.
  const selectedLeadOffsetMs = useTradingStore((s) => s.selectedLeadOffsetMs);
  const setLeadOffset = useTradingStore((s) => s.setLeadOffset);
  const dataEpoch = useTradingStore((s) => s.dataEpoch);
  const hardResetLiveData = useTradingStore((s) => s.hardResetLiveData);
  /**
   * CHART ALIVE GUARD — the single disposal gate for the entire imperative
   * pipeline. Every async updater (rAF frame, 100ms beat, ResizeObserver
   * callback, zero-hop tick subscription, projection/lookahead renderers and
   * the React data-push effect) MUST check this flag first and bail when
   * false. It is cleared at the VERY START of the chart effect's cleanup —
   * BEFORE `chart.remove()` runs — so no paint or update method can ever be
   * invoked on a disposed chart instance or canvas context, even for an
   * in-flight tick/frame that was scheduled before the destruction.
   */
  const isChartLiveRef = useRef(false);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const livePriceLineRef = useRef<IPriceLine | null>(null);
  /** AI projected High/Low price-target band — dashed horizontal boundaries on
   *  the confirmed series, driven imperatively via updateTargetLinesRef. */
  const targetLinesRef = useRef<{
    high: IPriceLine | null;
    low: IPriceLine | null;
  }>({ high: null, low: null });
  const clearTargetLinesRef = useRef<() => void>(() => {});
  /** Band-location signature (symbol + levels) — identical frames are skipped. */
  const targetBandSignatureRef = useRef<string>("");
  /** Imperative updater — re-aims the dashed High/Low target lines. Driven by
   *  the zero-hop tick subscription (via renderProjectionRef) and the 100ms beat.
   *  Reads fresh data from the store; never captures stale props. */
  const updateTargetLinesRef = useRef<() => void>(() => {});
  /** Last-applied predictive lead offset (ms) — triggers a grid reset on change. */
  const lastLeadOffsetMsRef = useRef<number | null>(selectedLeadOffsetMs ?? null);
  /** Predictive-candle series (target/expiry forecast) — fed by the real-time
   * progressive engine (renderProjectionRef) below. */
  const projectionLineRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  /** LEADING-PROJECTION line — a dotted amber marker that anticipates where the
   * ACTIVE forming candle's close WILL land (aggregator momentum model). It is
   * updated synchronously on every tick via the zero-hop aggregator stream and
   * re-drifts between ticks on a light beat loop, so the chart draws AHEAD of
   * confirmed candles / external feeds. Never merged into the real OHLC. */
  const leadingLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  /** Last leading-projection frame pushed to the leading line (for skip of
   * zero-delta frames and idempotent series.update). */
  const leadingPointRef = useRef<LineData | null>(null);
  const leadingColorRef = useRef<string>(LEADING_LINE);
  /** GHOST GLOW TRAIL — the halo (wide, low-alpha) + core (thin, vivid) line
   * pair riding the aggregator's native HA_Close. Decorative only: both series
   * are price-scale neutral and never influence autoscale. */
  const ghostGlowLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ghostTrailLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  /** Freshest live candle, cached in a ref so the animation loop can push it
   * straight into the chart without triggering a full React round-trip. */
  const liveCandleRef = useRef<CandlestickData | null>(null);
  const liveVolumeRef = useRef<HistogramData | null>(null);

  const lastPushedTimeRef = useRef<number>(-1);
  const lastPushedWidthRef = useRef<number>(-1);
  /** Last live-tick bucket pushed by the animation loop — used to detect a
   * bucket rollover (a fresh candle opening at the live edge) so the viewport
   * scrolls right to keep the newly-formed bar continuous and flush. */
  const liveTickTimeRef = useRef<number>(-1);
  const needsFullResetRef = useRef(true);
  /** Count of consecutive live/backfill candles DISCARDED as out-of-sync while
   * waiting for a synchronised live stream (e.g. after an SSID-less poll where
   * the historical backfill lags the session by thousands of seconds). When it
   * rises, the chart surfaces an "Awaiting Live Feed / Connecting..." overlay
   * instead of a misleading LIVE badge — it never distorts the price scale with
   * a fabricated baseline. */
  const desyncCountRef = useRef<number>(0);
  const activeSymbolRef = useRef<string>("");
  const activeTimeframeRef = useRef<string>("");

  /** Last frame pushed to the projection series. The progressive loop diffs it
   * against the freshly-computed forecast frame: same slot set → morph with
   * `update()`, different slot set (expiry rollover / horizon change) → clean
   * `setData()` replace. Guarantees fluid in-place growth with zero flicker,
   * zero duplicate bars and zero stale slots. */
  const projectionCacheRef = useRef<CandlestickData[]>([]);
  /** Latest closure of the progressive forecast renderer — kept in a ref so the
   * zero-hop tick subscription, the 100ms leading beat loop and prop-change
   * triggers all drive ONE engine without ever reading a stale render closure. */
  const renderProjectionRef = useRef<(() => void) | null>(null);
  /** Predictive-lookahead series — forward-projected target candles pre-rendered
   * AHEAD of the live timeline (beats the external platform by the configured
   * 1m/2m/3m/5m horizon). A distinct cool-cyan dashed series, driven by the
   * aggregator's lookahead projector on its own cadence + this pane's rAF loop. */
  const lookaheadSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  /** Last frame pushed to the lookahead series — diffs against the fresh
   * series so the same slot set morphs with `update()` (zero flicker) instead
   * of a full `setData()` churn per projector beat. */
  const lookaheadCacheRef = useRef<CandlestickData[]>([]);
  /** Latest closure of the lookahead renderer (driven by rAF + subscription). */
  const renderLookaheadRef = useRef<(() => void) | null>(null);
  /** Live lookahead horizon (minutes) mirrored for the rAF renderer. */
  const lookaheadHorizonRef = useRef<LookaheadHorizonMinutes>(1);
  if (
    lookaheadHorizon != null &&
    LOOKAHEAD_HORIZON_OPTIONS.includes(lookaheadHorizon)
  ) {
    lookaheadHorizonRef.current = lookaheadHorizon;
  }
  /** Applied to the realtime aggregator when valid (non-null only when a valid
   * horizon prop was passed) — keeps the aggregator's own horizon in lock-step
   * so its projector broadcasts match this pane. */
  const requestedLookaheadHorizon: LookaheadHorizonMinutes | null =
    lookaheadHorizon != null &&
    LOOKAHEAD_HORIZON_OPTIONS.includes(lookaheadHorizon)
      ? lookaheadHorizon
      : null;
  /** Stream-stall mirror for the animation loop (loops hold stale props). */
  const streamStalledRef = useRef<boolean>(streamStalled);
  streamStalledRef.current = streamStalled;
  /** Signal mirror so the per-tick push and 300ms loop can colour the live
   *  forming candle from the freshest signal without stale closures. */
  const signalRef = useRef<typeof signal>(signal);
  signalRef.current = signal;
  /** Sub-minute (M20) mirror — initialised false, populated once subMinute is
   *  computed below. The chart's time formatter reads this ref so the
   *  hh:mm:ss toggle works outside the React render lifecycle. */
  const subMinuteRef = useRef<boolean>(false);

  // ── SIGNAL-ALIGNED LIVE CANDLE ──
  // Returns a copy of the live candle with its colours pinned to the ACTIVE
  // signal (green BUY / red SELL). When no signal is present it returns the
  // candle unchanged so colour follows real price direction as normal.
  const signalAligned = (c: CandlestickData): CandlestickData => {
    const sc = signalColor(signalRef.current);
    if (!sc) return c;
    return {
      ...c,
      color: sc,
      borderColor: sc,
      wickColor: sc,
    };
  };

  // ── POCKET-OPTION STYLE DENSE VISIBLE WINDOW ──
  // Candles render continuous side-by-side at a dense packing so the pane is
  // always filled with REAL Japanese candlesticks (wicks + solid bodies) —
  // never sparse, wide, blocky bars with empty gutters. Exactly ~42 candles
  // fit at the live edge on every screen size, matching the classic
  // binary-option terminal density (30-50 visible candles).
  const RIGHT_GUTTER = 2;
  const DENSE_VISIBLE_BARS = 42; // constant dense candle count in view

  // Fixed dense candle count (no width-based cramming) so spacing auto-packs to
  // fill the pane. Remaining 30-50 range guarantees compatibility with the
  // requested density target.
  const visibleBars = DENSE_VISIBLE_BARS;

  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // ── CHART-INSTANCE EPOCH ──
  // Bumped once per chart (re)creation in the chart-creation effect. Effects
  // that must re-run against a FRESH instance (full history repaint, time-scale
  // style re-application) key on this reactive counter rather than on the
  // mutable `chartRef.current` (which exhaustive-deps rejects). Recreation
  // happens on symbol / theme / height changes only.
  const [chartEpoch, setChartEpoch] = useState(0);

  // ── RENDER-COUNT METER ──
  // Counts React renders of the chart component. Exposed via __chartDebug so
  // QA can prove live ticks do NOT churn React (the live candle rides the
  // zero-hop imperative stream; React only re-renders ≤ ~5Hz from the throttled
  // realtimeCandles publish).
  const renderCountRef = useRef<number>(0);
  renderCountRef.current += 1;

  // ── PER-SYMBOL STORE SELECTORS ──
  // Both `realtimeCandles[SYMBOL]` and `candlesCache[SYMBOL]` are subscribed by
  // SLICE (not the whole record), so a tick publish for ANOTHER pair never
  // re-renders this pane and never re-runs the merge below. Only THIS pair's
  // signals (realtimeCandles publish, /predict depth refresh) trigger work.
  const liveSeries = useTradingStore(
    (s) => s.realtimeCandles[symbol.toUpperCase()],
  );
  const seedAggregatorHistory = useTradingStore((s) => s.seedAggregatorHistory);
  const setAggregatorTimeframe = useTradingStore(
    (s) => s.setAggregatorTimeframe,
  );
  const candlesCache = useTradingStore(
    (s) => s.candlesCache[symbol.toUpperCase()],
  );

  const { resolvedTheme } = useTheme();
  const { t } = useLangContext();
  const palette = CHART_THEMES.dark;

  // ── SUB-MINUTE DETECTION (M20 / 20s candles) ──
  // When the active bucket is shorter than one minute the x-axis must render
  // SECONDS (hh:mm:ss) and the timeScale must show second ticks, otherwise all
  // the 20s candles collapse onto the same :00 minute label and become
  // indistinguishable. `subMinute` is derived purely from the requestCactive
  // timeframe's real bucket width — never assumed.
  const activeBucketMs =
    typeof realtimeAggregator?.getBucketMs === "function" &&
    realtimeAggregator.getBucketMs() > 0
      ? realtimeAggregator.getBucketMs()
      : TIMEFRAME_MS[isTimeframe(timeframe) ? timeframe : "1m"];
  const subMinute = activeBucketMs < 60_000;
  subMinuteRef.current = subMinute;

  useEffect(() => {
    if (timeframe) {
      setAggregatorTimeframe(timeframe);
    }
  }, [timeframe, setAggregatorTimeframe]);

  // ── LOOKAHEAD HORIZON SYNC ──
  // Push the predictive-lookahead horizon into the aggregator whenever the
  // prop changes (1m|2m|3m|5m) so its self-driven projector broadcasts target
  // candles at the configured lookahead, then immediately re-render this pane's
  // forward series at the new horizon.
  useEffect(() => {
    if (requestedLookaheadHorizon == null) return;
    realtimeAggregator?.setLookaheadHorizon(requestedLookaheadHorizon);
    renderLookaheadRef.current?.();
  }, [requestedLookaheadHorizon]);

  // ═══════════════════════════════════════════════════════════════════════
  // ZERO-HOP LIVE PUSH ENGINE (sub-millisecond tick → canvas)
  // ═══════════════════════════════════════════════════════════════════════
  // The active forming candle is pushed STRAIGHT into the chart's series from
  // inside the aggregator's synchronous emit stack — the SAME call stack as
  // the WebSocket handler — bypassing React state, useMemo and the scheduler
  // entirely. All closures below read only refs, so they never go stale across
  // renders and can be handed to the aggregator's live subscription once.
  const normSymbolRef = useRef<string>(symbol.toUpperCase());
  normSymbolRef.current = symbol.toUpperCase();
  const lastQuantDispatchSigRef = useRef<string>("");
  const lastResetEpochRef = useRef<number>(0);
  /** Latest real candle received while the full series was not yet populated
   *  (history still loading / awaiting first render) — flushed by the coarse
   *  React effect the moment setData() has planted the dense series. */
  const pendingLiveCandleRef = useRef<Candle | null>(null);
  const pushLiveCandleRef = useRef<(candle: Candle) => void>(() => {});
  const paintLeadingRef = useRef<(nowMs?: number) => void>(() => {});
  const updatePriceLineRef = useRef<(price?: number, color?: string) => void>(
    () => {},
  );
  const lastPriceLineValueRef = useRef<number>(-1);

  // Wire the zero-hop push handlers (refs stable → subscription runs the same
  // closures for the lifetime of the chart instance).
  useEffect(() => {
    pushLiveCandleRef.current = (candle: Candle) => {
      const series = seriesRef.current;
      const chart = chartRef.current;
      const volumeSeries = volumeRef.current;
      if (!isChartLiveRef.current) return;
      if (!series || !chart) return;

      // ── TICK→CANVAS LATENCY METER ──
      // Records the synchronous imperative chain (subscriber entry → series
      // update return) in microseconds — the portion that used to carry two
      // React hops and a setInterval cadence, now one call stack.
      const chainStart =
        typeof performance !== "undefined" ? performance.now() : 0;
      const recordChain = () => {
        if (chainStart > 0 && typeof window !== "undefined") {
          (window as unknown as Record<string, number>).__lastChainUs =
            (performance.now() - chainStart) * 1000;
        }
      };

      // Series not populated yet (dense history still rendering) — buffer the
      // freshest candle; the coarse React effect flushes it after setData().
      if (lastPushedTimeRef.current < 0) {
        pendingLiveCandleRef.current = candle;
        return;
      }

      const bucketMsInner =
        typeof realtimeAggregator?.getBucketMs === "function"
          ? realtimeAggregator.getBucketMs()
          : TIMEFRAME_MS[
              isTimeframe(activeTimeframeRef.current)
                ? activeTimeframeRef.current
                : "1m"
            ];
      const ohlc = normalizeOHLC(candle.open, candle.high, candle.low, candle.close);
      let point: CandlestickData = {
        time: toChartTime(candle.timestamp, bucketMsInner),
        open: ohlc.open,
        high: ohlc.high,
        low: ohlc.low,
        close: ohlc.close,
      };
      const timeNum = point.time as number;
      const sigPoint = signalAligned(point);

      // ── ZERO-DELTA SKIP ──
      // Identical bucket + identical OHLC is a no-op frame (duplicate network
      // delivery / volume-only update). Skip the canvas redraw but still let
      // the leading projection + price line re-aim.
      const prev = liveCandleRef.current;
      if (
        prev &&
        timeNum === liveTickTimeRef.current &&
        prev.open === point.open &&
        prev.high === point.high &&
        prev.low === point.low &&
        prev.close === point.close
      ) {
        paintLeadingRef.current();
        updatePriceLineRef.current(point.close);
        return;
      }

      // ── SAFE UPDATE GUARD ──
      // Strictly-older tick (late/desynced delivery) is discarded with a
      // structured warning — never fed to update(), which would throw.
      const seriesData = series.data();
      const tip =
        seriesData && seriesData.length > 0
          ? (seriesData[seriesData.length - 1]?.time as number)
          : -1;
      if (tip >= 0 && timeNum < tip) {
        desyncCountRef.current += 1;
        liveCandleRef.current = sigPoint;
        console.warn(
          `[FinancialChart] Skipped out-of-order zero-hop push for ${timeNum} ` +
            `(series tip is ${tip})`,
        );
        return;
      }

      try {
        series.update(sigPoint);
        liveCandleRef.current = sigPoint;
        desyncCountRef.current = 0;
      } catch {
        // Transient out-of-order push — the coarse React flow self-heals.
        liveCandleRef.current = sigPoint;
      }

      // ── LIVE VOLUME (mirrors the candle in real time) ──
      if (volumeSeries && candle.volume != null) {
        const vp: HistogramData = {
          time: point.time,
          value: candle.volume,
          color:
            point.close >= point.open
              ? "rgba(34,171,148,0.45)"
              : "rgba(242,54,69,0.45)",
        };
        try {
          volumeSeries.update(vp);
          liveVolumeRef.current = vp;
        } catch {
          // Cosmetic — the price candle is authoritative.
        }
      }

      // ── BUCKET ROLLOVER → FLUSH AT THE LIVE EDGE ──
      // A brand-new bucket opened: scroll the viewport right so the forming
      // lead candle + forecast stay flush at the live edge, pinned by an
      // explicit visible-logical-range (lead tip at right edge + gutter) —
      // never a shallower scrollToRealTime() last-point align.
      if (liveTickTimeRef.current >= 0 && timeNum !== liveTickTimeRef.current) {
        try {
          const total = series.data().length;
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(total - DENSE_VISIBLE_BARS, 0),
            to: Math.max(
              total + RIGHT_GUTTER,
              total - DENSE_VISIBLE_BARS + RIGHT_GUTTER + 1,
            ),
          });
        } catch {}
      }
      liveTickTimeRef.current = timeNum;

      // The ghost glow trail re-aims synchronously with the confirmed candle —
      // same call stack as the WebSocket tick, so the after-glow never lags.
      updateGhostTip(
        ghostGlowLineRef.current,
        ghostTrailLineRef.current,
        point,
      );

      // All cheap, synchronous, and imperative — same call stack as the tick.
      // The LEADING projection re-aims synchronously (single-point `update`,
      // sub-ms so the marker reacts the frame the burst lands). The full
      // forecast FRAME (up to `numCandles` series updates) is delegated to the
      // rAF coalescer below — display-refresh cadence, so a 100Hz tick burst
      // can never trigger 100×60 canvas updates per second.
      paintLeadingRef.current();
      updatePriceLineRef.current(candle.close);
      recordChain();
    };

    paintLeadingRef.current = (nowMs?: number) => {
      if (!isChartLiveRef.current) return;
      const leading = leadingLineRef.current;
      const candle = liveCandleRef.current;
      if (!leading || !candle) return;
      if (!realtimeAggregator) return;
      // Cached leading projection on the aggregator's LEADING clock (default):
      // the weighted fit is throttled (PROJECTION_CACHE_MS) and the cache is
      // burst-invalidated per tick, so this frame-rate path is near-zero-cost
      // while still re-aiming at the exact expiry boundary ahead of sync.
      const proj = realtimeAggregator.getCachedProjection(
        normSymbolRef.current,
        nowMs,
      );
      if (!proj) {
        // Fewer than two real ticks yet — nothing to project; keep prior frame.
        if (leadingPointRef.current) {
          try {
            leading.setData([]);
          } catch {}
          leadingPointRef.current = null;
        }
        return;
      }
      const point: LineData = {
        // The live candle's chart time is already the bucket-floored
        // UTCTimestamp — the leading point rides the SAME coordinate.
        time: candle.time,
        value: proj.close,
      };
      const prev = leadingPointRef.current;
      if (
        prev &&
        prev.time === point.time &&
        Math.abs((prev.value as number) - (point.value as number)) < 1e-9
      ) {
        // Lead is already at the projected close for this instant — no redraw.
        return;
      }
      try {
        leading.update(point);
      } catch {
        try {
          leading.setData([point]);
        } catch {}
      }
      leadingPointRef.current = point;
    };

    updatePriceLineRef.current = (price?: number, color?: string) => {
      if (!isChartLiveRef.current) return;
      const series = seriesRef.current;
      if (!series) return;
      const statePrice = useTradingStore.getState().currentPrice;
      const live =
        price && price > 0
          ? price
          : Number.isFinite(statePrice) && statePrice > 0
            ? statePrice
            : 0;
      if (!Number.isFinite(live) || live <= 0) return;
      let c = color;
      if (!c) {
        const lastCandle = liveCandleRef.current;
        if (lastCandle) {
          if (lastCandle.close >= lastCandle.open) c = "rgba(34,171,148,1)";
          else c = "rgba(242,54,69,1)";
        }
        if (!c) c = "rgba(148,163,184,0.85)";
      }
      if (lastPriceLineValueRef.current === live && livePriceLineRef.current) {
        return;
      }
      lastPriceLineValueRef.current = live;
      if (livePriceLineRef.current) {
        try {
          livePriceLineRef.current.applyOptions({ price: live, color: c });
        } catch {}
        return;
      }
      try {
        livePriceLineRef.current = series.createPriceLine({
          price: live,
          color: c,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
        });
      } catch {}
    };

    // ── AI PROJECTED PRICE-TARGET BAND RENDERER ──
    // Imperatively re-aims the dashed High/Low target lines on every tick /
    // prop change / display frame (driven from renderProjectionRef). Reads the
    // FRESH prediction recipe from the store (single source of truth — the
    // parents derive the same props from it), never possibly-stale props.
    clearTargetLinesRef.current = () => {
      const series = seriesRef.current;
      if (!series) return;
      const t = targetLinesRef.current;
      if (t.high) {
        try {
          series.removePriceLine(t.high);
        } catch {}
        t.high = null;
      }
      if (t.low) {
        try {
          series.removePriceLine(t.low);
        } catch {}
        t.low = null;
      }
      targetBandSignatureRef.current = "";
    };

    updateTargetLinesRef.current = () => {
      if (!isChartLiveRef.current) return;
      const series = seriesRef.current;
      if (!series) return;

      const st = useTradingStore.getState();
      const prediction = st.predictionData ?? null;
      const target = Number(prediction?.target_price);
      const anchor = Number(prediction?.current_price);
      const atrVal = Number(prediction?.scalping_indicators?.atr_14 ?? 0);
      const live =
        Number.isFinite(st.currentPrice) && st.currentPrice > 0
          ? st.currentPrice
          : liveCandleRef.current != null &&
              Number.isFinite(liveCandleRef.current.close) &&
              liveCandleRef.current.close > 0
            ? liveCandleRef.current.close
            : Number.isFinite(anchor) && anchor > 0
              ? anchor
              : 0;

      // ── BAND DERIVATION ──
      // High/Low levels bracket the projected settle: the ceiling sits above
      // `max(live, target)` and the floor below `min(live, target)`, widened by
      // ATR scale (with a delta/price-floor fallback when ATR is absent) so the
      // AI's expected wick range reads as two clear horizontal boundaries. No
      // target or price → the band is removed, never fabricated.
      if (!Number.isFinite(target) || target <= 0 || !live || live <= 0) {
        clearTargetLinesRef.current();
        return;
      }
      const move = Math.abs(target - live);
      const vol = atrVal > 0 ? atrVal : Math.max(move * 1.5, live * 2e-4);
      const hw = Math.max(vol * 0.8, move * 0.3, live * 1e-4);
      const highLevel = Math.max(live, target) + hw;
      const lowLevel = Math.min(live, target) - hw;
      const sig = `${activeSymbolRef.current}|${highLevel.toFixed(6)}|${lowLevel.toFixed(
        6,
      )}`;

      // Zero-delta skip — the band already sits at these exact levels.
      if (
        targetBandSignatureRef.current === sig &&
        targetLinesRef.current.high &&
        targetLinesRef.current.low
      ) {
        return;
      }
      targetBandSignatureRef.current = sig;

      clearTargetLinesRef.current();
      try {
        const t = targetLinesRef.current;
        t.high = series.createPriceLine({
          price: highLevel,
          color: TARGET_HIGH_COLOR,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "TGT HI",
        });
        t.low = series.createPriceLine({
          price: lowLevel,
          color: TARGET_LOW_COLOR,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "TGT LO",
        });
      } catch {}
    };
  }, []);

  // ── HISTORICAL + REALTIME CANDLE ENGINE (100% REAL DATA) ──
  // Depth comes from the backend: /predict serves TIMEFRAME_DESIRED_BARS (200+
  // validated real OHLCV bars per timeframe). Those bars reach the chart through
  // the store's per-symbol candlesCache (and the `data` prop), while live socket
  // ticks arrive through realtimeCandles. Nothing is synthesized client-side —
  // until real bars/ticks exist the chart shows the awaiting-stream overlay.
  // ── HISTORICAL BASE SERIES (memoized ONCE per symbol+timeframe) ──
  // The expensive half of the old pipeline (timestamp normalisation, on-grid
  // boundary filtering, flat-line guard, strict sanitization, dense-run anomaly
  // pruning) runs ONLY over the static/backend sources here. Crucially this
  // memo does NOT depend on `liveSeries`, so a sub-millisecond WebSocket burst
  // can never re-run an O(200+) sanitization pass just to shift one forming
  // candle. Live candles are merged onto this base in the cheap zip below.
  const historySeries = useMemo<{
    candles: CandlestickData[];
    volume: Map<number, number>;
    bucketMs: number;
  }>(() => {
    const cached = candlesCache;

    // Wall-clock reference for the STRICT timestamp filter (below). Captured
    // once per merge so all three sources are judged against the same instant.
    const nowMs = Date.now();

    // ── SAME-GRID CONTINUITY GUARANTEE ──
    // Every candlestick must sit on the ACTIVE timeframe's wall-clock bucket
    // grid (epoch-floored), exactly like a Pocket/binary terminal. The backend
    // can legitimately return bars on a DIFFERENT grid than the live intraday
    // aggregate — e.g. a daily-bar fallback served while the user watches a 1m
    // pane. Mixing two grids into one series makes lightweight-charts spread
    // the bars by their raw timestamps, producing the isolated candles with
    // huge empty gaps. FIX: keep only bars aligned to the active bucket grid
    // (bucketStart(ts) === ts); off-grid history is excluded from THIS pane so
    // what renders is one continuous, dense array with no invented buckets and
    // no straddling whitespace. The live aggregator output is always on-grid —
    // on the PO-PARITY floor grid by default (lead 0), and `toAggGrid` below
    // folds this base onto that same axis (1:1 parity, no off-by-one seam at
    // history→live).
    const bucketMs = TIMEFRAME_MS[isTimeframe(timeframe) ? timeframe : "1m"];
    // ── PREDICTIVE-LEAD GRID OFFSET (1:1 parity with the live aggregator) ──
    // The live engine buckets every tick on the PO-PARITY grid by default
    // (leadMs 0 → `floor(ts/bucketMs) * bucketMs`, byte-identical to the
    // backend's m20_engine). The historical base must land on that SAME axis or
    // the merge paints an off-by-one drop seam / duplicate-stale bar. Read the
    // live offset from the shared aggregator; default to 0 (parity) when it is
    // not yet available (SSR/first frame). A configured lead (> 0) re-engages
    // the lead-shifted grid here and on the live tip below.
    const leadShiftMs = selectedLeadOffsetMs ?? 0;
    // Fold a raw instant onto the SAME grid as the aggregator live buckets:
    // parity (lead 0) = pure floor grid; leaded = leadShiftBucket. This is the
    // single mapping history, the systematic-skew live tip, and the future
    // filter all share so no layer drifts off the live axis.
    const toAggGrid = (ts: number) =>
      leadShiftMs > 0
        ? leadShiftBucket(ts, bucketMs, leadShiftMs)
        : bucketStart(ts, bucketMs);
    // Accept bars aligned to the bucket START or END boundary (open-time and
    // close-time feeds both render on-grid). The tolerance is deliberately wide
    // (5% of bucket width — 3s for 1m candles) so legitimate historical bars
    // from the backend (which may land ±1-2s off the ideal grid due to clock
    // skew, ISO→epoch rounding, or non-UTC timezone parsing) are not rejected.
    // The old ±0.5% tolerance silently discarded valid candles and caused the
    // chart's desync counter to inflate (~132k s lag) by starving the series
    // of historical depth.
    const onGridBoundary = (tsMs: number) => {
      if (!Number.isFinite(tsMs) || tsMs <= 0) return false;
      const ms = tsMs % bucketMs;
      return ms < bucketMs * 0.05 || ms > bucketMs * 0.95;
    };

    // ── Merge REAL backend history sources into ONE ascending series ──
    // Priority (later sources overwrite earlier ones at the same bucket):
    //   1. `data` prop (backend history via /predict response)
    //   2. candlesCache (same backend history, keyed per symbol in the store)
    // A Map keyed by bucket timestamp collapses duplicates (no ghost bars, no
    // flicker) and the ascending sort satisfies Lightweight-Charts' strict
    // ordering contract. LIVE candles are merged on top of this base by the
    // cheap two-pointer zip in `normalizedData`, never re-sanitized.
    const volumeByTime = new Map<number, number>();
    const byTime = new Map<number, CandlestickData>();

    const ingest = (source: unknown) => {
      if (!Array.isArray(source)) return;
      // ── SYSTEMATIC-SKEW GRID RE-ANCHOR (per source) ──
      // A backend series can arrive on a systematically-shifted wall-clock grid
      // (e.g. every bar ~21h ahead — the lag≈75780s case). Detect that pattern
      // and shift the WHOLE source back by the whole-bucket multiple so the
      // series lands on the live grid BEFORE the strict future filter runs —
      // otherwise the filter drops the ENTIRE history and the desync counter
      // inflates. Uses the SAME shared detector as the aggregator's seedHistory
      // (judged against the lead-shifted live-tip grid, phase-robust against
      // the sub-minute residue of Date.now()); genuine anomalies stay anomalous.
      let sourceShiftMs = 0;
      {
        const rawTsOf = (x: unknown): number => {
          const raw = (x as Record<string, unknown>)?.timestamp;
          if (typeof raw === "number") {
            const f = Number(raw);
            return f < 1_000_000_000_000 ? f * 1000 : f;
          }
          if (typeof raw === "string") {
            const p = new Date(raw).getTime();
            return Number.isFinite(p) ? p : Number(raw);
          }
          return Number(raw);
        };
        const normTimes = source
          .map(rawTsOf)
          .filter((t) => Number.isFinite(t) && t > 0)
          .map((t) => ({ timestamp: t }));
        if (normTimes.length > 0) {
          // The LIVE-TIP GRID on the same axis as the aggregator's live buckets:
          // parity → floor(now) (exact PO grid); leaded → leadShiftBucket(now).
          // Judged against the SAME grid the live buckets ride.
          const liveTipGrid = toAggGrid(nowMs);
          sourceShiftMs = detectSystematicSeedSkew(
            normTimes,
            liveTipGrid,
            bucketMs,
          );
        }
      }
      for (const c of source) {
        // ── TIMESTAMP NORMALISATION ──
        // The backend serves candles with ISO-8601 string timestamps (via
        // mapCandlesToAiFormat) even though the TS type says `number`. Real
        // brokers also mix epoch-ms / epoch-seconds / ISO. Normalise every
        // flavour to epoch MILLISECONDS so history and live ticks share one
        // axis; a NaN timestamp drops the bar (never a fabricated bucket).
        let ts: number;
        const rawTs = (c as Record<string, unknown>)?.timestamp;
        if (typeof rawTs === "number") {
          const finite = Number(rawTs);
          ts = finite < 1_000_000_000_000 ? finite * 1000 : finite;
        } else if (typeof rawTs === "string") {
          const parsed = new Date(rawTs).getTime();
          ts = Number.isFinite(parsed) ? parsed : Number(rawTs);
        } else {
          ts = Number(rawTs);
        }
        if (!Number.isFinite(ts) || ts <= 0) continue;
        ts -= sourceShiftMs;
        // ── AGGRID SHIFT (1:1 parity with the aggregator buckets) ──
        // Fold the bar onto the SAME grid the live/replay buckets occupy —
        // the historical base and the forming candle must share one slot grid
        // or the merge zip renders the opening series one bucket behind the
        // live tip (the off-by-one drop seam). In parity (default) that is the
        // exact PO floor grid; with a configured lead it is the aggregator's
        // OWN lead mapping, so the result is byte-identical to every window
        // the engine renders through.
        ts = toAggGrid(ts);
        // ── INVALID-FUTURE FILTER ──
        // A candle whose open time is more than one bucket ahead of now is
        // corrupt (a future timestamp cannot be a real forming bar). Drop the
        // specific item cleanly with a warning instead of letting it smash the
        // ascending order / trigger an unnecessary full setData rebuild. The
        // tolerance absorbs the lead-shift itself (a genuinely lead-shifted
        // historical tip sits at most ~one bucket + lead ahead of "now").
        if (ts > nowMs + bucketMs + leadShiftMs) {
          console.warn(
            `[FinancialChart] Dropped future-timestamp candle at ${ts} ` +
              `(now=${nowMs}, bucketMs=${bucketMs})`,
          );
          continue;
        }
        const o = Number(c?.open);
        const h = Number(c?.high);
        const l = Number(c?.low);
        const cl = Number(c?.close);
        // Reject bars that don't belong on the active grid (prevents the
        // mixed-grid gap/straddle symptom in the visible pane).
        if (!onGridBoundary(ts)) continue;
        if (!Number.isFinite(o) || !Number.isFinite(cl) || cl <= 0) continue;
        if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
        const time = toChartTime(ts, bucketMs);
        if ((time as number) <= 0) continue;
        // ── FLAT-LINE GUARD ──
        // A bar that has collapsed to a point (h === l === o === c) renders as
        // a degenerate zero-height "flat line-bar" — the exact all-flatline
        // symptom this chart is being overhauled to eliminate. When the raw
        // source is genuine and only the wick collapsed, keep the body at the
        // real close so wicks still show. We NEVER invent a price level; a
        // flat bar stays flat if that is truly the data.
        const realHigh = Math.max(h, o, cl);
        const realLow = Math.min(l, o, cl);
        byTime.set(time as number, {
          time,
          open: o,
          high: realHigh,
          low: realLow,
          close: cl,
        });
        const vol = Number(c?.volume);
        volumeByTime.set(
          time as number,
          (volumeByTime.get(time as number) ?? 0) +
            (Number.isFinite(vol) && vol > 0 ? vol : 0),
        );
      }
    };
    ingest(data);
    ingest(cached);

    const merged = Array.from(byTime.entries()).sort((a, b) => a[0] - b[0]);

    let finalCandles: CandlestickData[] = merged.map(([, candle]) => candle);

    // ── STRICT SANITIZATION (guard against malformed / null / undefined) ──
    // Every downstream pass (dense-run prune, volume mapping,
    // series.setData) indexes candles. To guarantee NONE of them can ever crash
    // on `.time`/`.close` of a missing item, we strip and normalize the array
    // ONCE right here:
    //   • drop any null/undefined/non-object element outright;
    //   • require a finite, valid `time` AND a finite positive `close`;
    //   • coerce high/low/open to finite numbers (fall back to close) so the
    //     earlier flat-guard + later purges never see NaN/garbage.
    finalCandles = finalCandles
      .filter((c): c is CandlestickData => {
        if (!c || typeof c !== "object") return false;
        const time = c.time;
        const close = Number(c.close);
        const hasValidTime =
          (typeof time === "number" && Number.isFinite(time) && time > 0) ||
          (typeof time === "object" && time !== null);
        if (!hasValidTime || !Number.isFinite(close) || close <= 0) {
          return false;
        }
        return true;
      })
      .map((c) => {
        const close = Number(c.close);
        const open = Number.isFinite(Number(c.open)) ? Number(c.open) : close;
        const high = Number.isFinite(Number(c.high)) ? Number(c.high) : close;
        const low = Number.isFinite(Number(c.low)) ? Number(c.low) : close;
        const data: CandlestickData = {
          time: c.time as CandlestickData["time"],
          open,
          high: Math.max(high, open, close),
          low: Math.min(low, open, close),
          close,
        };
        return data;
      });

    // ── STRICT SORT + DEDUPE (already guaranteed by the Map+sort above) ──
    // `byTime` is keyed by bucket timestamp so duplicate timestamps are
    // collapsed (later sources win at the same slot), and the final sort is
    // strictly ascending — lightweight-charts' ordering contract is satisfied.

    // ── DISCONNECTED / DISTANT-PAST ANOMALY PRUNE ──
    // Purpose: remove an ISOLATED corrupt timestamp wedged into an otherwise
    // contiguous dense series (e.g. one 1788097800 bar inside a minute-paced
    // series whose tip is 1788172080 — a ~20h orphan that belongs to neither
    // the historical run nor the live edge).
    //
    // NOTE: this pass iterates over `finalCandles` (which may be SHORTER than
    // `merged` after the strict sanitization above), so every bound and index uses
    // `finalCandles.length` — never `merged.length` (which can index past the
    // end of a purged array and crash on `undefined.time`).
    //
    // Guard: only prune when the series is PREDOMINANTLY DENSE (most
    // consecutive gaps are a single bucket step). A genuine historical series
    // delivered on a coarser grid than the active pane (e.g. REAL daily OTC
    // bars served while the user watches an intraday pane) is legitimately
    // comprised of large adjacent gaps — every one of those bars is real, not
    // a corrupt orphan. Running the dense-run prune on such a series would
    // classify EVERY bar as a "lone outlier" and collapse the whole multi-candle
    // history down to the live ticks alone — the exact "single candle" symptom
    // this fix restores. When the series is predominantly sparse we skip the
    // prune entirely so the full historical array reaches series.setData().
    if (finalCandles.length > 2) {
      const bucketStepSec = Math.round(bucketMs / 1000);
      const MAX_ANOMALY_GAP = Math.max(bucketStepSec * 12, 120);

      // Measure how "dense" the series is before deciding to prune. A bar is
      // counted as a dense-contiguous step when it sits exactly one bucket
      // step from its previous neighbour. Guard each access: a candle missing
      // a valid `time` is skipped (never crashes the map/render).
      let denseSteps = 0;
      for (let i = 1; i < finalCandles.length; i++) {
        const cur = finalCandles[i];
        const prev = finalCandles[i - 1];
        if (!cur || !prev) continue;
        const curTime =
          typeof cur.time === "number" && Number.isFinite(cur.time)
            ? (cur.time as number)
            : Number.NaN;
        const prevTime =
          typeof prev.time === "number" && Number.isFinite(prev.time)
            ? (prev.time as number)
            : Number.NaN;
        if (!Number.isFinite(curTime) || !Number.isFinite(prevTime)) continue;
        const gap = curTime - prevTime;
        if (gap === bucketStepSec) denseSteps += 1;
      }
      const denseFraction = denseSteps / Math.max(1, finalCandles.length - 1);

      // Only a predominantly dense, contiguous series should be scrubbed for
      // lone-outlier anomalies. A sparse/coarse real history is preserved as-is.
      const predominantlyDense = denseFraction >= 0.6;

      if (predominantlyDense) {
        const pruned: CandlestickData[] = [];
        for (let i = 0; i < finalCandles.length; i++) {
          const item = finalCandles[i];
          // Guard: skip any malformed/null element — never index `.time` on it.
          if (
            !item ||
            typeof item.time !== "number" ||
            !Number.isFinite(item.time)
          ) {
            continue;
          }
          const cur = item.time as number;
          const prevCandle = i > 0 ? finalCandles[i - 1] : null;
          const nextCandle =
            i < finalCandles.length - 1 ? finalCandles[i + 1] : null;
          const prev =
            prevCandle &&
            typeof prevCandle.time === "number" &&
            Number.isFinite(prevCandle.time)
              ? (prevCandle.time as number)
              : Number.NEGATIVE_INFINITY;
          const next =
            nextCandle &&
            typeof nextCandle.time === "number" &&
            Number.isFinite(nextCandle.time)
              ? (nextCandle.time as number)
              : Number.POSITIVE_INFINITY;
          const gapPrev = cur - prev;
          const gapNext = next - cur;
          const isLoneOutlier =
            Number.isFinite(prev) &&
            Number.isFinite(next) &&
            gapPrev > MAX_ANOMALY_GAP &&
            gapNext > MAX_ANOMALY_GAP;
          if (isLoneOutlier) {
            console.warn(
              `[FinancialChart] Dropped disconnected/corrupt candle at ${cur} ` +
                `(gap before=${gapPrev}s, gap after=${gapNext}s)`,
            );
            continue;
          }
          pruned.push(finalCandles[i]);
        }
        finalCandles = pruned;
      }
    }

    // ── NATIVE HEIKIN-ASHI SINGLE-ENCODING RULE (vertical-seam fix) ──
    // The history base and the live aggregator series both render Heikin-Ashi:
    // this base is folded to HA ONCE (the exact recursion the aggregator's
    // carry uses), and the aggregator's live/realtime series is already native
    // HA. `normalizedData` zips two HA arrays with no re-fold and no bar-type
    // mix over the history→live seam — every candle in the pane shares ONE
    // encoding, morphing tick-by-tick through the same fold.
    return {
      candles: toHeikinAshiSeries(finalCandles),
      volume: volumeByTime,
      bucketMs,
    };
    // `candlesCache` is already the per-symbol store slice, so the symbol is
    // encoded in the deps via that slice (no need for a redundant key).
  }, [data, candlesCache, timeframe, selectedLeadOffsetMs]);

  // ── FINAL MERGED SERIES (history base + live candles, cheap two-pointer zip) ──
  // Live candles come from the aggregator's own series (already ascending,
  // wall-clock aligned, deduped at the tip) and are merged ON TOP of the
  // precomputed history base in linear time — NO re-sanitization, NO sort, NO
  // prune on live updates. Live wins at every overlapping bucket slot, and any
  // historical candle claiming a time NEWER than the live tip is dropped as a
  // desynced backfill (keeps the ascending order clean; the counter feeds the
  // awaiting-live overlay exactly like before).
  const normalizedData = useMemo<{
    candles: CandlestickData[];
    volume: HistogramData[];
  }>(() => {
    const history = historySeries.candles;
    const volumeByTime = historySeries.volume;
    const liveGridMs =
      typeof realtimeAggregator?.getBucketMs === "function" &&
      realtimeAggregator.getBucketMs() > 0
        ? realtimeAggregator.getBucketMs()
        : historySeries.bucketMs;
    const liveArr = Array.isArray(liveSeries) ? liveSeries : [];
    const liveTipMs =
      liveArr.length > 0
        ? liveArr[liveArr.length - 1]?.timestamp
        : Number.NEGATIVE_INFINITY;

    const merged: CandlestickData[] = [];
    const volOut = new Map<number, number>();
    let hi = 0;
    let li = 0;

    while (hi < history.length || li < liveArr.length) {
      const h = hi < history.length ? history[hi] : null;
      const l = li < liveArr.length ? liveArr[li] : null;
      // ── LIVE GRID GUARD ──
      // Live candles are bucketed by the aggregator on the ACTIVE timeframe
      // grid; if one is ever off-grid (transient mismatch between the chart's
      // `timeframe` prop and the aggregator during a switch), drop it rather
      // than let a wrong-grid coordinate create a gap/straddle in the pane.
      if (l && liveGridMs > 0 && l.timestamp % liveGridMs !== 0) {
        li += 1;
        continue;
      }
      const hTime = h ? (h.time as number) : Number.POSITIVE_INFINITY;
      const lTime = l
        ? toChartTime(l.timestamp, liveGridMs)
        : Number.POSITIVE_INFINITY;

      // ── OUT-OF-SYNC HISTORY DISCARD (live tip is the authoritative edge) ──
      // Static/backfill candles claiming a bucket NEWER than the live tip are
      // desynced and must never render ahead of the forming candle.
      if (
        h &&
        Number.isFinite(liveTipMs) &&
        hTime * 1000 > liveTipMs + liveGridMs
      ) {
        desyncCountRef.current += 1;
        console.warn(
          `[FinancialChart] Discarded out-of-sync backfill candle at ${hTime} ` +
            `(live tip is ${liveTipMs}ms, ahead=${hTime * 1000 - liveTipMs}ms)`,
        );
        hi += 1;
        continue;
      }

      if (h && l && hTime === lTime) {
        // Live wins at the same slot (dedupe → no ghost bars, no flicker).
        const ohlc = normalizeOHLC(l.open, l.high, l.low, l.close);
        merged.push({
          time: lTime as UTCTimestamp,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
        });
        volOut.set(lTime, l.volume ?? 0);
        hi += 1;
        li += 1;
      } else if (l && (h === null || lTime < hTime)) {
        const ohlc = normalizeOHLC(l.open, l.high, l.low, l.close);
        merged.push({
          time: lTime as UTCTimestamp,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
        });
        volOut.set(lTime, l.volume ?? 0);
        li += 1;
      } else if (h) {
        merged.push(h);
        volOut.set(hTime, volumeByTime.get(hTime) ?? 0);
        hi += 1;
      }
    }

    const deduped: CandlestickData[] = [];
    for (const row of merged) {
      const prev =
        deduped.length > 0 ? deduped[deduped.length - 1] : null;
      const prevTime = prev ? (prev.time as number) : Number.NEGATIVE_INFINITY;
      if (prevTime === (row.time as number)) {
        deduped[deduped.length - 1] = row;
      } else {
        deduped.push(row);
      }
    }

    // ── HEIKIN-ASHI RENDERING RULE (single fold, never a mix) ──
    // `historySeries` folds the RAW backend base to native HA ONCE (the exact
    // fold the aggregator's carry uses), and the aggregator's live chain
    // (`liveSeries` → `getSeries`) is already native HA. Every candle in
    // `merged` therefore shares ONE encoding — re-folding here would be a
    // HA-of-HA double transform, and leaving raw rows would reintroduce the
    // vertical seam drop. No conditional: `merged` is uniformly HA.
    const chartCandles: CandlestickData[] = deduped;

    const candleVolume: HistogramData[] = chartCandles.map((candle) => ({
      time: candle.time,
      value: volOut.get(candle.time as number) ?? 0,
      color:
        candle.close >= candle.open
          ? "rgba(34,171,148,0.45)"
          : "rgba(242,54,69,0.45)",
    }));

    return { candles: chartCandles, volume: candleVolume };
  }, [historySeries, liveSeries]);

  const hasRealData = normalizedData.candles.length > 0;

  // ── DESYNCED-LIVE-STREAM DETECTION (chart canvas) ──
  // `streamDesynced` is true while the chart is actively rejecting incoming
  // candles as out-of-sync (the await/desync counter is non-zero) → the live
  // edge has not synchronised a fresh, wall-clock-aligned candle. In this state
  // we do NOT pretend the feed is live and we do NOT inject a static baseline —
  // we surface an "Awaiting Live Feed / Connecting..." overlay on the canvas.
  // A single successful in-place live update resets the counter (above).
  //
  // The threshold must be tolerant: a few transient discarded candles during a
  // bucket rollover or a reconnect backfill are NORMAL and must NOT flip the
  // overlay to "AWAITING LIVE FEED". Only a SUSTAINED rejection pattern (many
  // consecutive drops) indicates a genuinely desynced session.
  const [streamDesynced, setStreamDesynced] = useState(false);
  useEffect(() => {
    setStreamDesynced(desyncCountRef.current >= 10);
  }, [normalizedData]);

  // ── TEMP DIAGNOSTIC HOOK ──
  // Exposes the exact arrays handed to the chart (history `setData`, live
  // `update`, forecast slots) plus a contiguity audit so disconnected / isolated
  // candle coordinates can be traced from the console: `window.__chartDebug`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isChartLiveRef.current) return;
    const w = window as unknown as Record<string, unknown>;
    const c = normalizedData.candles;
    const bucketSeconds = Math.round(
      (TIMEFRAME_MS[isTimeframe(timeframe) ? timeframe : "1m"] || 60000) / 1000,
    );

    // Contiguity audit: find every gap between consecutive candles that is
    // NOT exactly one bucket step (the signature of a disconnected coordinate).
    const gaps: { at: number; from: number; to: number; gapSec: number }[] = [];
    for (let i = 1; i < c.length; i++) {
      const g = (c[i].time as number) - (c[i - 1].time as number);
      if (g !== bucketSeconds)
        gaps.push({
          at: i,
          from: c[i - 1].time as number,
          to: c[i].time as number,
          gapSec: g,
        });
    }

    w.__chartDebug = {
      rawDataLen: (data as unknown[]).length,
      timeframe,
      bucketSeconds,
      mergedCandles: c.length,
      contiguityGaps: gaps,
      // ── EXACT DATA PASSED TO series.setData (history + live merged) ──
      setData_last6: c.slice(-6).map((x) => ({
        time: x.time,
        open: x.open,
        high: x.high,
        low: x.low,
        close: x.close,
        color: x.color,
      })),
      mergedFirst: c[0],
      mergedLast: c[c.length - 1],
      times: c.slice(0, 5).map((x) => x.time),
      lastTimes: c.slice(-5).map((x) => x.time),
      seriesLen: (
        seriesRef.current as unknown as { data: () => unknown[] } | null
      )?.data()?.length,
      // ── FORECAST SLOTS (added AFTER the live series tip via projection) ──
      forecastSlots: (projectionCacheRef.current ?? []).map((x) => ({
        time: x.time,
        close: x.close,
        color: x.color,
      })),
      forecastAnchorBase: (projectionCacheRef.current ?? [])[0]?.time,
      // ── TIP-TO-FORECAST ADJACENCY AUDIT ──
      // HARD INVARIANT: the first forecast slot must sit exactly ONE bucket
      // step to the right of the last live candle with ZERO offset gap.
      //   gapSec === bucketSeconds  (contiguous, no padding / no disconnected shift)
      // If lastCandleTime is missing the series is empty, and if firstForecastTime
      // is undefined the forecast has not rendered a frame yet.
      lastCandleTime:
        c.length > 0 ? (c[c.length - 1].time as number) : undefined,
      firstForecastTime: (projectionCacheRef.current ?? [])[0]?.time,
      forecastGapSec:
        c.length > 0 && (projectionCacheRef.current ?? [])[0]
          ? ((projectionCacheRef.current as CandlestickData[])[0]
              .time as number) - (c[c.length - 1].time as number)
          : undefined,
      visRange: chartRef.current?.timeScale().getVisibleLogicalRange(),
      symbol,
      signal: signalRef.current,
      // ── REACT RENDER METER (proof ticks don't churn React) ──
      reactRenderCount: renderCountRef.current,
      // ── LEADING PROJECTION SNAPSHOT ──
      leadingProjection: realtimeAggregator
        ? realtimeAggregator.getProjection(normSymbolRef.current)
        : null,
      // ── TICK → CANVAS LATENCY (microseconds, best-effort chain) ──
      lastZeroHopChainUs:
        (w as { __lastChainUs?: number }).__lastChainUs ?? null,
      zeroHopLatencySamplesUs:
        (w as { __chainSamples?: number[] }).__chainSamples ?? [],
      // ── QA TICK PUMP — drives a real aggregator tick end-to-end and records
      //    the synchronous tick→canvas round-trip. Mirrors the socket "live_tick"
      //    path (ingestLiveTick → aggregator.ingest → zero-hop subscriber →
      //    series.update) with NO React involvement. ──
      pumpTick: (
        price: number,
        volume = 1,
        ts: number = Date.now(),
      ): { totalMs: number; chainUs: number; last: CandlestickData } => {
        const t0 = performance.now();
        const st = useTradingStore.getState();
        st.ingestLiveTick({
          symbol: normSymbolRef.current,
          price,
          volume,
          timestamp: ts,
        });
        const totalMs = performance.now() - t0;
        const chainUs = (w as { __lastChainUs?: number }).__lastChainUs ?? 0;
        const samples = (w as { __chainSamples?: number[] }).__chainSamples;
        if (samples && samples.length >= 120) samples.shift();
        if (samples) samples.push(chainUs);
        return {
          totalMs,
          chainUs,
          last: liveCandleRef.current as unknown as CandlestickData,
        };
      },
    };
  });
  // ── END TEMP DIAGNOSTIC HOOK ──

  // ═══════════════════════════════════════════════════════════════════════
  // REAL-TIME PROGRESSIVE EXPIRE-FORECAST ENGINE (POCKET-OPTION CANDLE FLOW)
  // ═══════════════════════════════════════════════════════════════════════
  // Replaces the old static "dump the whole target sequence at once" approach
  // with a genuine candle-form loop, paced by the SELECTED expiration:
  //
  //   1. PROGRESSIVE FORMATION — forecast candles materialize one by one on
  //      the SAME wall-clock bucket grid as the live series, each starting as
  //      a flat silhouette at its open and morphing toward its waypoint in
  //      lock-step with real time. Nothing is pre-painted at the target.
  //
  //   2. EXACT EXPIRY MAPPING — the horizon is converted into the exact number
  //      of ACTIVE-timeframe candle intervals (R = minutes ÷ bucket width).
  //      The final candle closes exactly at the expiry instant
  //      (liveBucketStart + R × interval) and its close converges on the AI
  //      target price tick-by-tick, so the target is reached at expiry.
  //
  //   3. FLUID FLUSH ALIGNMENT — forecast slots sit strictly to the RIGHT of
  //      the freshest real candle (close-aligned, one slot ahead of the live
  //      forming bar), recomputed from the live edge on every bucket rollover,
  //      so there are never jagged dots, empty gutters or overlapping bars.
  //
  // The engine is a ref-hosted closure so the zero-hop tick subscription, the
  // 100ms leading beat and the prop-change trigger all drive the
  // same code path. The trajectory NEVER freezes or vanishes: even when the
  // live stream stalls it stays rendered toward the AI target (muted, never
  // removed) so the predictive candles are always alive and legible.
  renderProjectionRef.current = () => {
    const projectionSeries = projectionLineRef.current;
    const chart = chartRef.current;
    const mainSeries = seriesRef.current;
    if (!isChartLiveRef.current) return;
    if (!projectionSeries || !chart) return;

    // ── PRICE-TARGET BAND RE-AIM ──
    // The dashed High/Low target boundaries are the live surface of the AI's
    // projected price range. They re-aim here, on every tick, prop change and
    // display frame (renderProjectionRef is the shared drive point of the
    // whole pipeline), straight into the forward lead-candle render below.
    updateTargetLinesRef.current();

    // ── NEVER-FREEZE GUARANTEE ──
    // A stalled live stream must NOT halt the target trajectory. The forecast
    // path stays rendered toward the AI target (driven by signal + target). We
    // only degrade it visually (see `stalled` below) — it never vanishes and
    // never dead-ends. This is what keeps the predictive candles alive when
    // the WebSocket hiccups.
    const stalled = streamStalledRef.current;

    const requestedTarget = Number(predictedTargetPrice);
    // ── RESPECTED START (never 0) ──
    // The trajectory origin ALWAYS tracks the LIVE tick line first (the same
    // stream the chart candlesticks render). `predictionAnchorPrice` is only
    // used as an absolute last resort when no live price is available — never
    // allowed to override fresher live ticks.
    const anchor =
      Number(currentPrice) > 0
        ? Number(currentPrice)
        : Number.isFinite(Number(predictionAnchorPrice)) &&
            predictionAnchorPrice > 0
          ? Number(predictionAnchorPrice)
          : 0;
    const lastLive = liveCandleRef.current;
    // ── RESOLVED START (never 0) ──
    // Prefer the freshest live close, then currentPrice, then the store's
    // aggregate price — so the trajectory always has a real origin to attach
    // to and never degrades to a 0-level point (which would kill the forecast).
    const storeLivePrice = useTradingStore.getState().currentPrice;
    const resolvedStart =
      lastLive && Number.isFinite(lastLive.close) && lastLive.close > 0
        ? lastLive.close
        : Number(currentPrice) > 0
          ? Number(currentPrice)
          : Number(storeLivePrice) > 0
            ? Number(storeLivePrice)
            : anchor;

    // ── CONTINUOUS FORECAST GATE ──
    // A genuine backend target activates the trajectory. Once active it NEVER
    // vanishes or freezes: even if the live price has already reached (or
    // crossed) the target, the engine keeps a rendered path that simply
    // consolidates around the target level — there is no dead-zone where the
    // forecast disappears the moment live equals target. The path is driven by
    // signal direction, so the trajectory can never flicker between up/down.
    const rawAtr = Number(atr);
    const maxProjectionDistance = resolvedStart * 0.08;
    const target =
      Number.isFinite(requestedTarget) && requestedTarget > 0
        ? Math.min(
            Math.max(requestedTarget, resolvedStart - maxProjectionDistance),
            resolvedStart + maxProjectionDistance,
          )
        : 0;
    const hasTarget =
      target > 0 && Number.isFinite(resolvedStart) && resolvedStart > 0;
    if (!hasTarget) {
      if (projectionCacheRef.current.length > 0) {
        try {
          projectionSeries.setData([]);
        } catch {}
        projectionCacheRef.current = [];
      }
      return;
    }

    // ── SIGNAL-DRIVEN DIRECTION ──
    const bullish = signal === "BUY";
    const bearish = signal === "SELL";
    let foreColor = bullish
      ? BULLISH
      : bearish
        ? BEARISH
        : "rgba(148,163,184,0.9)";
    // When the live stream is stalled we keep the SAME trajectory visible but
    // slightly muted — never removed, never frozen into a dim full-stop.
    if (stalled)
      foreColor = bullish
        ? "rgba(34,171,148,0.6)"
        : bearish
          ? "rgba(242,54,69,0.6)"
          : "rgba(148,163,184,0.55)";

    // ── EXACT EXPIRY MAPPING ──
    // Convert the selected horizon (minutes) into the exact number of candle
    // intervals on the ACTIVE timeframe's grid. 1m expiry on a 1m grid → 1
    // interval; 5m expiry on a 1m grid → 5 intervals; 1h expiry on a 1h grid
    // → 1 interval. The final candle lands exactly on the expiry bucket.
    const bucketMs = TIMEFRAME_MS[isTimeframe(timeframe) ? timeframe : "1m"];
    const rawCount = Math.round(projectionMinutes * (60_000 / bucketMs)) || 1;
    const numCandles = Math.min(Math.max(1, rawCount), 60);

    // ── STRICT TIP ALIGNMENT / HARD INVARIANT (live tip + 1 slot, zero offset) ──
    // baseSlotSec is the timestamp of the freshest painted candle (the live tip),
    // so forecast[0].time === baseSlotSec + bucketSeconds — byte-contiguous with
    // the real series, never a stale merge or a fabricated wall-clock slot.
    const bucketSeconds = Math.round(bucketMs / 1000);
    const paintedTip = seriesRef.current?.data?.();
    let baseSlotSec =
      paintedTip && paintedTip.length > 0
        ? (paintedTip[paintedTip.length - 1].time as number)
        : normalizedData.candles.length > 0
          ? (normalizedData.candles[normalizedData.candles.length - 1]
              .time as number)
          : 0;
    // ── STRICT SYNCHRONISED-ANCHOR GATE (NEVER FABRICATE A SLOT) ──
    // The forecast MUST attach flush to a REAL, synchronised candle (the live
    // series tip). If no real candle exists yet (awaiting SSID / out-of-sync
    // backfill discarded / stream never delivered a tick) there is NO anchor to
    // attach to — falling back to a raw `Date.now()` wall-clock slot would paint
    // forecast candles on a fabricated x-coordinate and distort the pane. We
    // clear the projection and bail instead, letting the chart show only its
    // clean awaiting overlay. Never invent a baseline slot.
    if (baseSlotSec <= 0) {
      if (projectionCacheRef.current.length > 0) {
        try {
          projectionSeries.setData([]);
        } catch {}
        projectionCacheRef.current = [];
      }
      return;
    }

    // Wick width — scales the forecast candle shadows. Driven by real ATR when
    // available (scaled to the horizon) so wicks stay realistic at every
    // timeframe; falls back to a fraction of the gap otherwise.
    const wickRaw =
      Number.isFinite(rawAtr) && rawAtr > 0
        ? rawAtr * 0.5
        : Math.max(
            Math.abs(target - resolvedStart) * (0.06 / Math.max(1, numCandles)),
            0.0002,
          );
    const wick = Math.min(wickRaw, resolvedStart * 0.003);

    // ── CONTINUOUS ENDPOINT ──
    // When the live price has already reached the target, the trajectory keeps
    // rendering as a small continuation band around the target level (in the
    // signal direction) so the path never collapses to a vanishing freeze — it
    // simply consolidates at the goal until a fresh prediction re-anchors it.
    const reached = target === resolvedStart;
    const endRef = reached
      ? target + (bullish ? 1 : -1) * Math.max(Math.abs(target) * 0.0005, wick)
      : target;
    const gap = endRef - resolvedStart;
    // Waypoint i = the predicted close the i-th interval should reach. The
    // path is a monotonic easing from origin → endpoint across the R intervals,
    // so consecutive candles connect end-to-end with no price discontinuity.
    const waypointAt = (i: number) => resolvedStart + gap * (i / numCandles);

    const now = Date.now();
    const frame: CandlestickData[] = [];

    for (let i = 1; i <= numCandles; i++) {
      // ── CHRONOLOGICAL FORWARD STEPPING (flush, zero-gap) ──
      // Candle i occupies the bucket immediately AFTER the live candle. The
      // loop STARTS at i = 1, so the very first projected slot
      // (forecast[0]) is exactly:
      //    forecast[0].time === baseSlotSec + bucketSeconds
      // — one contiguous bucket step past the live tip, with NO padding slot
      // inserted before it and NO offset gap. Slots then ascend by exactly one
      // interval each, forming a tight contiguous chain that marches forward
      // in time to the expiration bucket. Nothing is placed at
      // historical/mismatched timestamps.
      const slotSec = baseSlotSec + i * bucketSeconds;
      const openTMs = baseSlotSec * 1000 + (i - 1) * bucketMs;
      const elapsedPct = clamp01((now - openTMs) / bucketMs);
      const segStart = waypointAt(i - 1);
      const segEnd = waypointAt(i);
      const open = segStart;
      // ── SOLID JAPANESE BODY (never a flat dashed stub) ──
      // Even before its window opens, every forecast candle carries a real
      // directional body (a minimum fraction of the segment already drawn) plus
      // upper/lower wicks, so the whole forecast reads as a chain of solid
      // candles stepping toward the target — never thin dashed/dotted marks.
      const MIN_BODY_FRAC = 0.12;
      const drawFrac = Math.max(elapsedPct, MIN_BODY_FRAC);
      const drawClose = segStart + (segEnd - segStart) * drawFrac;
      const high = Math.max(open, drawClose) + wick;
      const low = Math.min(open, drawClose) - wick;
      const color = elapsedPct <= 0 ? FORECAST_PENDING : foreColor;
      frame.push({
        time: slotSec as UTCTimestamp,
        open,
        high,
        low,
        close: drawClose,
        color,
        borderColor: color,
        wickColor: elapsedPct <= 0 ? FORECAST_PENDING_WICK : foreColor,
      });
    }

    // ── DIFFED FRAME PUSH ──
    // Same slot set → morph each candle in place (smooth tick-by-tick growth).
    // Slot set changed (expiry rollover / horizon edit) → clean full replace,
    // then re-anchor the viewport so the forming forecast stays flush at the
    // live edge — without ever disturbing a manual pan/zoom.
    const prev = projectionCacheRef.current;
    const sameWindow =
      prev.length === frame.length &&
      prev.every((c, i) => c.time === frame[i].time);
    try {
      if (sameWindow) {
        // ── EPSILON-SKIP (no canvas churn on static/unmoved forecast candles) ──
        // Early-horizon "planning" stubs whose window hasn't opened yet hold a
        // constant close/colour; skipping them avoids ~numCandles series.update
        // calls per frame for candles that canonically cannot have changed.
        for (let i = 0; i < frame.length; i++) {
          const nxt = frame[i];
          const cur = prev[i];
          if (
            cur &&
            cur.time === nxt.time &&
            cur.close === nxt.close &&
            cur.open === nxt.open &&
            cur.high === nxt.high &&
            cur.low === nxt.low &&
            cur.color === nxt.color &&
            cur.wickColor === nxt.wickColor
          ) {
            continue;
          }
          projectionSeries.update(nxt);
        }
      } else {
        projectionSeries.setData(frame);
        try {
          const ts = chart.timeScale();
          const mainCount = (mainSeries?.data().length as number) || 0;
          const vis = ts.getVisibleLogicalRange();
          const userAtLiveEdge = vis == null || (vis.to ?? 0) >= mainCount;
          if (userAtLiveEdge) {
            const to = mainCount + numCandles + RIGHT_GUTTER;
            const from = Math.max(
              to - (vis ? vis.to - vis.from : DENSE_VISIBLE_BARS),
              0,
            );
            ts.setVisibleLogicalRange({ from, to });
          }
        } catch {}
      }
    } catch (err) {
      console.warn("[FinancialChart] Projection frame skipped:", err);
      try {
        projectionSeries.setData(frame);
      } catch {}
    }
    projectionCacheRef.current = frame;
  };

  // ── PREDICTIVE-LOOKAHEAD RENDERER ──
  // Drives the forward-projected target-candle series strictly AHEAD of the
  // live timeline. Every rAF frame + every aggregator lookahead projector beat
  // calls this closure; it pulls the cache-throttled lookahead series from the
  // aggregator and morphs in place (same slot set) or cleanly replaces (horizon
  // / rollover change). The projected candles are hollow cool-cyan dashes so
  // they read unmistakably as future targets — the chart visually outruns the
  // external platform by the full configured horizon, on real-tape momentum.
  renderLookaheadRef.current = () => {
    const lookaheadSeries = lookaheadSeriesRef.current;
    const chart = chartRef.current;
    if (!isChartLiveRef.current) return;
    if (!lookaheadSeries || !chart || !realtimeAggregator) return;
    try {
      const event: LookaheadEvent | null =
        realtimeAggregator.getCachedLookahead(
          normSymbolRef.current,
          lookaheadHorizonRef.current,
        );
      if (!event || event.candles.length === 0) {
        if (lookaheadCacheRef.current.length > 0) {
          lookaheadSeries.setData([]);
          lookaheadCacheRef.current = [];
        }
        return;
      }
      // ── COLOR-BY-DIRECTION + STRENGTH FADE ──
      // Each projected candle carries its closing direction in its COLOUR —
      // teal = projected up, coral = projected down — so the trader reads the
      // upcoming Green/Red outcome before execution. Alpha fades with distance
      // (projectionStrength 0..1), so the future honestly reads as "less
      // certain the further out". OHLC passes through normalizeOHLC so a
      // projected bar can never render truncated/absent wicks.
      const frame: CandlestickData[] = event.candles.map(
        (c: LookaheadCandle) => {
          const ohlc = normalizeOHLC(c.open, c.high, c.low, c.close);
          const up = ohlc.close >= ohlc.open;
          const alpha = Math.max(
            0.4,
            Math.min(0.95, 0.45 + c.projectionStrength * 0.5),
          );
          const rgb = up ? "38,166,154" : "239,83,80";
          const color = `rgba(${rgb},${alpha.toFixed(2)})`;
          return {
            time: (c.timestamp / 1000) as UTCTimestamp,
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
            color,
            borderColor: color,
            wickColor: `rgba(${rgb},${(alpha * 0.6).toFixed(2)})`,
          };
        },
      );
      const prev = lookaheadCacheRef.current;
      const sameWindow =
        prev.length === frame.length &&
        prev.every((c, i) => c.time === frame[i].time);
      if (sameWindow) {
        for (let i = 0; i < frame.length; i++) {
          const nxt = frame[i];
          const cur = prev[i];
          if (
            cur &&
            cur.time === nxt.time &&
            cur.open === nxt.open &&
            cur.high === nxt.high &&
            cur.low === nxt.low &&
            cur.close === nxt.close
          ) {
            continue;
          }
          lookaheadSeries.update(nxt);
        }
      } else {
        lookaheadSeries.setData(frame);
        // Keep the viewport flush at the live edge so the ahead-of-timeline
        // target candles stay visible without disturbing a manual pan/zoom.
        try {
          const mainCount = (seriesRef.current?.data().length as number) || 0;
          const vis = chart.timeScale().getVisibleLogicalRange();
          const userAtLiveEdge = vis == null || (vis.to ?? 0) >= mainCount;
          if (userAtLiveEdge) {
            const to = mainCount + frame.length + RIGHT_GUTTER;
            const from = Math.max(
              to - (vis ? vis.to - vis.from : DENSE_VISIBLE_BARS),
              0,
            );
            chart.timeScale().setVisibleLogicalRange({ from, to });
          }
        } catch {}
      }
      lookaheadCacheRef.current = frame;
    } catch {
      // Never let a stale lookahead frame break the render loop.
    }
  };

  useEffect(() => {
    const normSymbol = symbol.toUpperCase();
    // A change in the predictive lead offset moves the WHOLE lead-shifted grid
    // (bucketForTimestamp → leadShiftBucket), so it is treated as a first-class
    // grid change: the series must re-render from scratch on the new axis —
    // same full-reset path as a symbol/timeframe switch, never a partial walk.
    const gridChanged =
      activeSymbolRef.current !== normSymbol ||
      activeTimeframeRef.current !== timeframe ||
      lastLeadOffsetMsRef.current !== (selectedLeadOffsetMs ?? null);
    if (gridChanged) {
      // ── NUCLEAR RESET ON SYMBOL / TIMEFRAME / LEAD-OFFSET CHANGE ──
      // Guarantee the incoming pair (or re-bucketed grid) renders its OWN
      // dense contiguous history from scratch — never a stale single bar or a
      // leftover tip from the previous symbol leaking into the pane. Resetting
      // every tracking ref forces the React push effect (which holds the full
      // merged/dense set) to do a clean full render and the 300ms loop's
      // series-populated guard to yield until that dense set is live.
      needsFullResetRef.current = true;
      lastPushedTimeRef.current = -1;
      lastPushedWidthRef.current = -1;
      liveCandleRef.current = null;
      liveVolumeRef.current = null;
      liveTickTimeRef.current = -1;
      desyncCountRef.current = 0;
      activeSymbolRef.current = normSymbol;
      activeTimeframeRef.current = timeframe;
      lastLeadOffsetMsRef.current = selectedLeadOffsetMs ?? null;
    }
  }, [symbol, timeframe, selectedLeadOffsetMs]);

  // ── HARD FEED RESET (dataEpoch) ──
  // A store `hardResetLiveData` clears every aggregator symbol state, cache and
  // the WebSocket transport, then bumps the epoch. This effect wipes the local
  // canvas + series buffers so nothing stale survives: the series is emptied,
  // every tick-tracking ref is zeroed, and the coarse merge path re-renders
  // from the replayed broker tick ring alone.
  useEffect(() => {
    if (dataEpoch === 0 || lastResetEpochRef.current === dataEpoch) return;
    lastResetEpochRef.current = dataEpoch;
    needsFullResetRef.current = true;
    lastPushedTimeRef.current = -1;
    lastPushedWidthRef.current = -1;
    liveCandleRef.current = null;
    liveVolumeRef.current = null;
    liveTickTimeRef.current = -1;
    pendingLiveCandleRef.current = null;
    lastQuantDispatchSigRef.current = "";
    desyncCountRef.current = 0;
    lastPriceLineValueRef.current = -1;
    livePriceLineRef.current = null;
    leadingPointRef.current = null;
    projectionCacheRef.current = [];
    lookaheadCacheRef.current = [];
    const safeClear = (s: { setData: (d: never[]) => void } | null) => {
      if (!s) return;
      try {
        s.setData([]);
      } catch {
      }
    };
    safeClear(seriesRef.current);
    safeClear(volumeRef.current);
    safeClear(projectionLineRef.current);
    safeClear(leadingLineRef.current);
    safeClear(lookaheadSeriesRef.current);
    safeClear(ghostGlowLineRef.current);
    safeClear(ghostTrailLineRef.current);
    try {
      clearTargetLinesRef.current();
    } catch {
    }
  }, [dataEpoch]);

  // Chart Canvas Initialization
  useEffect(() => {
    if (!isMounted || !chartContainerRef.current) return;

    const container = chartContainerRef.current;
    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.text,
        fontFamily: "'Inter', monospace, sans-serif",
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: palette.crosshair,
          width: 1,
          style: LineStyle.Solid,
          labelBackgroundColor: palette.crosshairLabelBg,
        },
        horzLine: {
          color: palette.crosshair,
          width: 1,
          style: LineStyle.Solid,
          labelBackgroundColor: palette.crosshairLabelBg,
        },
      },
      rightPriceScale: {
        borderColor: palette.border,
        borderVisible: true,
        scaleMargins: { top: 0.06, bottom: 0.2 },
      },
      // ── LOCAL TIMEZONE ALIGNMENT (GMT+1 / Casablanca etc.) ──
      // By default lightweight-charts renders axis labels in UTC, which is why
      // the terminal showed 07:20 while the user's local clock read 08:20.
      // The formatter below renders every timestamp in the browser's own
      // timezone so chart X-axis labels match local wall-clock time exactly.
      localization: {
        // ── PRECISE PRICE AXIS ──
        // Format every price-axis tick to the pair's real decimal precision
        // (e.g. 5 for most forex, 2 for JPY crosses), so gridline labels read
        // like a broker terminal instead of rounded 4-6 digit truncations.
        priceFormatter: (price: number) => {
          const digits = getPriceDigits(symbol) || 5;
          if (!Number.isFinite(price)) return String(price);
          let p = price;
          if (price >= 1000) {
            p = Math.round(price * 100) / 100;
          }
          return p.toLocaleString("en-US", {
            minimumFractionDigits: p >= 1000 ? 2 : digits,
            maximumFractionDigits: p >= 1000 ? 2 : digits,
          });
        },
        timeFormatter: (
          time:
            | { year: number; month: number; day: number; value?: number }
            | number,
        ) => {
          try {
            let date: Date;
            if (typeof time === "number") {
              date = new Date(time * 1000);
            } else if (typeof time === "object" && time !== null) {
              // BusinessDay { year, month, day }
              date = new Date(Date.UTC(time.year, time.month - 1, time.day));
            } else {
              return String(time);
            }
            // Local time rendering — never hardcodes UTC/GMT.
            const hh = String(date.getHours()).padStart(2, "0");
            const mm = String(date.getMinutes()).padStart(2, "0");
            // Sub-minute buckets (M20 / 20s) MUST render seconds — otherwise
            // every 20s candle in the same minute collapses onto one label.
            if (subMinuteRef.current) {
              const ss = String(date.getSeconds()).padStart(2, "0");
              return `${hh}:${mm}:${ss}`;
            }
            return `${hh}:${mm}`;
          } catch {
            return String(time);
          }
        },
      },
      timeScale: {
        borderColor: palette.border,
        // ── COMMON BINARY-OPTION TERMINAL SCALING ──
        // timeVisible keeps the intraday clock on the x-axis; secondsVisible is
        // ON for sub-minute buckets (M20) so each 20s candle gets its own label,
        // and OFF for minute+ buckets to match a 1m+ binary terminal cadence.
        // granularity) instead of flashing seconds. fixLeftEdge pins the left
        // side while new bars form on the right, and fixRightEdge stays false so
        // the pane rolls forward naturally with each fresh candle — preventing
        // candles from bunching up or vanishing during live streaming.
        timeVisible: true,
        secondsVisible: subMinute,
        // ── PROPORTIONAL GEOMETRY — DENSE DEFAULT, REAL ZOOM ──
        // Starts at the dense professional 9px column width (≈42 candles in
        // view). `minBarSpacing` = 2px bounds zoom-OUT so bars can never
        // compress into stubs or overlap, while zoom-IN is completely free:
        // bodies and wicks scale proportionally by lightweight-charts at every
        // barSpacing, so a zoomed bar is always full-width with visible wicks.
        barSpacing: INITIAL_BAR_SPACING_PX,
        minBarSpacing: MIN_BAR_SPACING_PX,
        rightOffset: RIGHT_GUTTER,
        // Pin the LEFT edge fixed while new live bars arrive; the right edge
        // stays free to grow so the forming candle never bunches up or vanishes.
        fixLeftEdge: true,
        fixRightEdge: false,
        // Snap on horizontal scroll keeps the candle columns crisp and aligned.
        shiftVisibleRangeOnNewBar: true,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
      },
      width: container.clientWidth || 640,
      height: container.clientHeight || height || 420,
      autoSize: false,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        pinch: true,
        mouseWheel: true,
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: BULLISH,
      downColor: BEARISH,
      borderUpColor: BULLISH,
      borderDownColor: BEARISH,
      wickUpColor: BULLISH,
      wickDownColor: BEARISH,
      wickVisible: true,
      borderVisible: true,
      priceLineVisible: true,
      priceLineColor: "rgba(148,163,184,0.4)",
      priceLineStyle: LineStyle.Solid,
      lastValueVisible: true,
      priceFormat: {
        type: "price",
        precision: getPriceDigits(symbol) || 5,
        minMove: 1 / Math.pow(10, getPriceDigits(symbol) || 5),
      },
      // ── LIVE-ZONE Y-AXIS CONSTRAINT ──
      // Defense-in-depth below the normalizedData purge: clamps the auto-scaled
      // price axis to a band around the trailing LIVE candles (median + ATR)
      // so a stale flat bar surviving any upstream merge can never drag the
      // scale down into an old price zone. `autoscaleInfoProvider` is a SERIES
      // option (v4) — it returns { priceRange } and the chart fits the axis to
      // that window, keeping the forming candle glued to Pocket Option's price.
      //
      // WICK-PRESERVATION INVARIANT: the band must always ENCOMPASS the real
      // high/low extremes of the trailing candles (+ breathing room), otherwise
      // a genuine shadow poking past the constraint is clipped at the pane edge
      // and renders as a truncated/stubby wick. `minValue`/`maxValue` therefore
      // expand beyond BOTH the median pad AND the observed tail extremes.
      autoscaleInfoProvider: (() => {
        // ── DISPOSAL-SAFE PROVIDER ──
        // lightweight-charts can invoke series autoscale logic during/after
        // `chart.remove()`; reading a disposed series here would re-throw the
        // "Object is disposed" error from inside the library's own render loop.
        // Bail to the default scale the instant the chart instance is not live.
        if (!isChartLiveRef.current) return null;
        try {
          const api = seriesRef.current as unknown as {
            data: () => Array<{
              close: number;
              high: number;
              low: number;
            }>;
            priceScale: () => unknown;
          } | null;
          const candles = api?.data?.() ?? [];
          const N = candles.length;
          if (N < 20) return null;
          const tail = candles.slice(-40);
          // ── OUTLIER-WICK EXCLUSION ──
          // A single distorted bar (a spike tick folded into a forming candle,
          // a desynced backfill candle, a synthetic jump) must NEVER stretch the
          // whole axis. The clean majority compute the extremes: a bar whose
          // high-low range blows out past `OUTLIER_MULT` × the MEDIAN tail range
          // is a data artefact, not a move — it is excluded from tailHi/tailLo/
          // span/ATR, so a lone "long drop" cannot squash the live candles.
          const ranges: number[] = [];
          for (const c of tail) {
            if (Number.isFinite(c.high) && Number.isFinite(c.low)) {
              ranges.push(Math.max(0, c.high - c.low));
            }
          }
          const sortedRanges = ranges.slice().sort((a, b) => a - b);
          const rangeMid = Math.floor(sortedRanges.length / 2);
          const medianRange =
            sortedRanges.length === 0
              ? NaN
              : sortedRanges.length % 2 === 0
                ? (sortedRanges[rangeMid - 1] + sortedRanges[rangeMid]) / 2
                : sortedRanges[rangeMid];
          if (!Number.isFinite(medianRange) || medianRange <= 0) return null;
          const OUTLIER_MULT = 8;
          const outlierCap = medianRange * OUTLIER_MULT;
          const closes = tail.map((c) => c.close).sort((a, b) => a - b);
          const mid = Math.floor(closes.length / 2);
          const median =
            closes.length % 2 === 0
              ? (closes[mid - 1] + closes[mid]) / 2
              : closes[mid];
          if (!Number.isFinite(median)) return null;
          let atrSum = 0;
          let atrN = 0;
          let tailHi = -Infinity;
          let tailLo = Infinity;
          for (const c of tail) {
            const range = c.high - c.low;
            const clean =
              Number.isFinite(c.high) &&
              Number.isFinite(c.low) &&
              Number.isFinite(range) &&
              range >= 0 &&
              range <= outlierCap;
            if (!clean) continue;
            atrSum += range;
            atrN += 1;
            if (c.high > tailHi) tailHi = c.high;
            if (c.low > 0 && c.low < tailLo) tailLo = c.low;
          }
          if (atrN === 0) return null;
          // ── FRESHEST-CANDLE WICK GUARANTEE ──
          // The band must ALWAYS encompass the forming candle's FULL high/low —
          // a genuine broad wick on the live tip is a real move and must never
          // be clipped flat at the pane edge. The outlier-exclusion loop above
          // can drop that tip (a wide wick exceeds `outlierCap`), so the tip's
          // extremes are folded into the band here; `maxStretch` still caps
          // any pathological blowout.
          const tipCandle = tail[tail.length - 1];
          if (
            tipCandle &&
            Number.isFinite(tipCandle.high) &&
            tipCandle.high > 0
          ) {
            tailHi = Math.max(tailHi, tipCandle.high);
          }
          if (
            tipCandle &&
            Number.isFinite(tipCandle.low) &&
            tipCandle.low > 0
          ) {
            tailLo = Math.min(tailLo, tipCandle.low);
          }
          const localAtr = Math.max(atrSum / atrN, median * 1e-5);
          const span = Number.isFinite(tailHi - tailLo)
            ? tailHi - tailLo
            : localAtr;
          // Median-anchored pad (anti-drag) is widened by a real-extremes margin
          // + relative span so shadows can never clip at the pane edges.
          const pad = Math.max(localAtr * 2.5, span * 0.35, median * 4e-4);
          const edge = Math.max(localAtr * 0.5, span * 0.08);
          // ── STRICT MIN/MAX HARD BOUND (anti-rachet) ──
          // Even a clean bar may not drag the axis further than `maxStretch`
          // from the median. Generous for genuine moves (18 local ATRs of
          // headroom) yet it caps any pathological blowout, so candle bodies
          // stay full-width instead of being squashed into a sliver under one
          // extreme long drop. minValue < maxValue is guaranteed.
          const maxStretch = Math.max(localAtr * 18, pad * 2);
          const minValue = Math.max(
            Math.min(median - pad, tailLo - edge),
            median - maxStretch,
          );
          const maxValue = Math.min(
            Math.max(median + pad, tailHi + edge),
            median + maxStretch,
          );
          if (
            !Number.isFinite(minValue) ||
            !Number.isFinite(maxValue) ||
            maxValue - minValue < localAtr
          ) {
            return null;
          }
          return {
            priceRange: { minValue, maxValue },
          };
        } catch {
          // A transient disposed/null series must never break chart scaling.
          return null;
        }
      }) as unknown as (
        baseImplementation: () =>
          | import("lightweight-charts").AutoscaleInfo
          | null,
      ) => import("lightweight-charts").AutoscaleInfo | null,
    });

    // ── PREDICTIVE TARGET CANDLES (POCKET-OPTION STYLE FORECAST) ──
    // A clean SECONDARY candlestick series fed by the real-time progressive
    // forecast engine below. Candles form one at a time on the live bucket
    // grid — dim "planning" stubs that light up and morph in signal colour
    // (green for BUY, red for SELL) as their own formation window arrives,
    // converging on the AI target price exactly at the selected expiry.
    // Never dots/lines — real Japanese candlesticks only.
    //
    // PRICE-SCALE NEUTRAL: `autoscaleInfoProvider: () => null` keeps forecast
    // candles VISIBLE but excluded from the axis auto-fit (lightweight-charts
    // merges every non-neutral series' range into the visible price scale, and
    // a forward target candle routinely extends several local ATRs past the
    // live zone — without this guard it would stretch the whole vertical scale
    // and squash the live candles into a sliver). The LIVE-ZONE Y-AXIS
    // CONSTRAINT on the main series is then the ONLY driver of the right scale
    // (matches the lookahead series — same neutrality contract).
    const projectionSeries = chart.addCandlestickSeries({
      upColor: BULLISH,
      downColor: BEARISH,
      borderUpColor: BULLISH,
      borderDownColor: BEARISH,
      wickUpColor: BULLISH,
      wickDownColor: BEARISH,
      wickVisible: true,
      borderVisible: true,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
      priceFormat: {
        type: "price",
        precision: getPriceDigits(symbol) || 5,
        minMove: 1 / Math.pow(10, getPriceDigits(symbol) || 5),
      },
    });

    // ── PREDICTIVE-LOOKAHEAD TARGET CANDLES (ahead-of-timeline) ──
    // A clean THIRD candlestick series pre-rendered strictly AHEAD of the live
    // timeline at the aggregator's configured lookahead horizon — the forward-
    // projected OHLCV target candles that visually outrun the external platform
    // by 1m to 5m. The renderer colours each bar by its projected closing
    // direction (teal = up, coral = down — the Green/Red of the upcoming bars),
    // with full shadow wicks; these series-level defaults are the same
    // direction palette and only apply to rows without an explicit colour.
    const lookaheadSeries = chart.addCandlestickSeries({
      upColor: BULLISH,
      downColor: BEARISH,
      borderUpColor: BULLISH,
      borderDownColor: BEARISH,
      wickUpColor: LOOKAHEAD_WICK,
      wickDownColor: LOOKAHEAD_WICK,
      wickVisible: true,
      borderVisible: true,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
      priceFormat: {
        type: "price",
        precision: getPriceDigits(symbol) || 5,
        minMove: 1 / Math.pow(10, getPriceDigits(symbol) || 5),
      },
    });

    // ── LEADING-PROJECTION LINE ──
    // A dotted amber marker that anticipates where the ACTIVE forming candle's
    // close will land (aggregator momentum model driven by the REAL tick
    // stream). It is a forecast — drawn as a distinct dotted marker, never
    // merged into the confirmed OHLC candles.
    const leading = chart.addLineSeries({
      color: LEADING_LINE,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      crosshairMarkerVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      // PRICE-SCALE NEUTRAL — the forecast marker must never stretch the axis.
      autoscaleInfoProvider: () => null,
      priceFormat: {
        type: "price",
        precision: getPriceDigits(symbol) || 5,
        minMove: 1 / Math.pow(10, getPriceDigits(symbol) || 5),
      },
    });

    // ── GHOST GLOW TRAIL (HA_Close after-glow) ──
    // Two decorative line series overlaid on the live candles: a wide halo and
    // a thin bright core, both fed the same HA_Close points and coloured per
    // bar direction. `autoscaleInfoProvider: () => null` keeps them PRICE-SCALE
    // NEUTRAL — they can never stretch or drag the axis, so there is zero
    // layout shift and zero impact on the WICK-PRESERVATION invariant.
    const ghostGlow = chart.addLineSeries({
      color: GHOST_HALO_BULL,
      lineWidth: 4,
      lineStyle: LineStyle.Solid,
      crosshairMarkerVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
      priceFormat: {
        type: "price",
        precision: getPriceDigits(symbol) || 5,
        minMove: 1 / Math.pow(10, getPriceDigits(symbol) || 5),
      },
    });
    const ghostTrail = chart.addLineSeries({
      color: GHOST_CORE_BULL,
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      crosshairMarkerVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
      priceFormat: {
        type: "price",
        precision: getPriceDigits(symbol) || 5,
        minMove: 1 / Math.pow(10, getPriceDigits(symbol) || 5),
      },
    });

    // ── VOLUME HISTOGRAM ──
    // Rendered on its own price scale pinned to the top of the bottom 18% of
    // the pane (professional Pocket/TradingView layout), colored by bar
    // direction and driven by REAL tick volume from the aggregator / backend.
    const histogram = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = histogram;
    projectionLineRef.current = projectionSeries;
    lookaheadSeriesRef.current = lookaheadSeries;
    lookaheadCacheRef.current = [];
    leadingLineRef.current = leading;
    leadingPointRef.current = null;
    ghostGlowLineRef.current = ghostGlow;
    ghostTrailLineRef.current = ghostTrail;
    projectionCacheRef.current = [];
    //
    // ── PRISTINE-INSTANCE RESET ──
    // A chart (re)creation must start from a clean slate: zero all tracking
    // refs so no candle/volume/tip/desync state from the PREVIOUS instance (or
    // a leaking pair) can bleed into the fresh series. `pendingLiveCandleRef`
    // is cleared too — the freshest candle is already present in normalizedData
    // and the data-push effect (keyed on the chart instance) repaints it.
    // The alive flag is armed LAST, after every ref is committed, so no async
    // callback can observe a half-wired instance.
    liveCandleRef.current = null;
    liveVolumeRef.current = null;
    lastPushedTimeRef.current = -1;
    lastPushedWidthRef.current = -1;
    liveTickTimeRef.current = -1;
    desyncCountRef.current = 0;
    pendingLiveCandleRef.current = null;
    needsFullResetRef.current = true;
    isChartLiveRef.current = true;
    // Notify the data-push / time-scale effects (keyed on this epoch) that a
    // fresh instance now owns the canvas, so they re-paint WITHOUT keying on the
    // mutable chart ref (rejected by exhaustive-deps).
    setChartEpoch((e) => e + 1);
    // Draw the very first progressive forecast frame immediately after the
    // projection series exists.
    renderProjectionRef.current?.();

    // ── RESIZE OBSERVER (DISPOSAL-SAFE) ──
    // Never closes over the local `chart` const: the callback re-reads
    // `chartRef.current` each delivery and bails via the alive guard. A batch
    // of resize notifications that survives `disconnect()` (or lands during an
    // in-progress recreation) therefore can never target a removed instance.
    const resizeObserver = new ResizeObserver((entries) => {
      if (!isChartLiveRef.current) return;
      const liveChart = chartRef.current;
      if (!liveChart) return;
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        // Width/height ONLY — candle geometry is governed by barSpacing +
        // minBarSpacing (initial dense 9px, zoom-proportional), so a resize
        // just refits the pane without re-deriving column widths.
        try {
          liveChart.applyOptions({
            width: rect.width,
            height: rect.height,
          });
        } catch {
          // A resize that races a disposal must never crash the app.
        }
      }
    });
    resizeObserver.observe(container);

    return () => {
      // ── DISPOSAL ORDER (single source of truth) ──
      // 1. Disarm the alive guard FIRST — in-flight ticks / rAF frames / resize
      //    deliveries scheduled for this instance immediately no-op.
      // 2. Tear down the ResizeObserver (drops queued notifications).
      // 3. Remove the chart (destroys the canvas + all series/price lines).
      // 4. Null every ref so no late closure can observe half-disposed state.
      isChartLiveRef.current = false;
      resizeObserver.disconnect();
      try {
        chart.remove();
      } catch {
        // A double-remove (StrictMode dev remount) must never throw.
      }
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      projectionLineRef.current = null;
      lookaheadSeriesRef.current = null;
      lookaheadCacheRef.current = [];
      leadingLineRef.current = null;
      leadingPointRef.current = null;
      ghostGlowLineRef.current = null;
      ghostTrailLineRef.current = null;
      livePriceLineRef.current = null;
      targetLinesRef.current = { high: null, low: null };
      targetBandSignatureRef.current = "";
      liveCandleRef.current = null;
      liveVolumeRef.current = null;
      lastPushedTimeRef.current = -1;
      lastPushedWidthRef.current = -1;
      liveTickTimeRef.current = -1;
      needsFullResetRef.current = true;
    };
    // Recreate the chart when the symbol changes so the price-axis precision
    // (pair-specific digits) and series price format apply to the new pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subMinute is read for initial secondsVisible, but updates are handled by the dedicated dynamic effect below to avoid a heavy chart re-creation on every timeframe change.
  }, [height, palette, isMounted, symbol]);

  // ── DYNAMIC SUB-MINUTE TIME SCALE UPDATE ──
  // When the timeframe changes to/from sub-minute (M20), the chart must re-apply
  // timeScale.secondsVisible and the localization.timeFormatter so the X-axis
  // label cadence switches between hh:mm:ss (sub-minute) and hh:mm (minute+)
  // without needing a full chart re-creation. The ref-based formatter already
  // reads subMinuteRef.current dynamically; only the timeScale option needs the
  // explicit applyOptions() call.
  useEffect(() => {
    if (!isChartLiveRef.current) return;
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.applyOptions({
        timeScale: {
          secondsVisible: subMinute,
        },
      });
    } catch {}
  }, [subMinute, timeframe, chartEpoch]);

  // Push / Update Candlestick Data
  useEffect(() => {
    if (!isChartLiveRef.current) return;
    const series = seriesRef.current;
    const chart = chartRef.current;
    const volumeSeries = volumeRef.current;
    const candles = normalizedData.candles;
    const volume = normalizedData.volume;
    if (!series || !chart || candles.length === 0) return;

    try {
      const newest = candles[candles.length - 1];
      const newestTime = newest.time as number;
      // Snapshot the last frame ACTUALLY painted — the zero-hop subscriber may
      // have already drawn this exact candle synchronously on the tick, in
      // which case the React-path update below must be skipped (see guard).
      const prevPushed = liveCandleRef.current;
      liveCandleRef.current = newest;
      if (volume.length > 0) liveVolumeRef.current = volume[volume.length - 1];
      const timeScale = chart.timeScale();
      const userAtLiveEdge =
        timeScale.getVisibleLogicalRange() == null ||
        lastPushedTimeRef.current < 0;
      // True when the candle BUCKET rolled over (a brand-new bar opened) rather
      // than just the in-progress bar acquiring a new tick.
      const rolledOver =
        lastPushedTimeRef.current >= 0 &&
        newestTime !== lastPushedTimeRef.current;
      // The in-progress candle must update on every tick (fast, cheap) but the
      // viewport should only shift right when a NEW bucket opens — otherwise the
      // chart would yank left/right on every real tick instead of animating in
      // place, which is what makes the live bar look laggy/jumpy.
      const shouldScroll =
        userAtLiveEdge && (rolledOver || needsFullResetRef.current);
      // ── EXPLICIT LEAD-TIP ANCHOR ──
      // Pins the viewport so the LEADING candle (the forming bar that renders
      // one full grid slot ahead of the raw feed) is always seated at the right
      // edge with a real RIGHT_GUTTER gap. Guaranteed by setVisibleLogicalRange
      // — never a blind scrollToRealTime() last-point alignment — so the future
      // slot stays visible by construction (to === n + RIGHT_GUTTER) and the
      // timeScale tracks the lead candle on every rollover, not the raw bucket
      // the market is still printing inside.
      const anchorAtLiveEdge = (n: number) => {
        timeScale.setVisibleLogicalRange({
          from: Math.max(n - visibleBars, 0),
          to: Math.max(n + RIGHT_GUTTER, n - visibleBars + RIGHT_GUTTER + 1),
        });
      };

      if (needsFullResetRef.current || lastPushedTimeRef.current < 0) {
        // Apply signal colour to the live tip on the initial full render too,
        // so the rightmost bar is signal-aligned from the very first frame.
        const initial = candles.map((c, i) =>
          i === candles.length - 1 ? signalAligned(c) : c,
        );
        series.setData(initial);
        if (volumeSeries) volumeSeries.setData(volume);
        // ── GHOST GLOW TRAIL SEED ──
        // The full-history render also seeds the halo/core overlay from the
        // merged candles' closes (native HA_Close on the live path) so the glow
        // is continuous from the very first frame — never a pop-in artefact.
        try {
          ghostGlowLineRef.current?.setData(
            ghostGlowData(
              candles as Array<{ time: number; open: number; close: number }>,
              GHOST_HALO_BULL,
              GHOST_HALO_BEAR,
            ),
          );
          ghostTrailLineRef.current?.setData(
            ghostGlowData(
              candles as Array<{ time: number; open: number; close: number }>,
              GHOST_CORE_BULL,
              GHOST_CORE_BEAR,
            ),
          );
        } catch {}
        needsFullResetRef.current = false;
        // ── PENDING LIVE FLUSH ──
        // Any real candle that arrived via the zero-hop stream while the dense
        // series was still rendering is re-pushed now that the series exists —
        // the freshest tip morphs in immediately, nothing is ever dropped.
        if (pendingLiveCandleRef.current) {
          pushLiveCandleRef.current(pendingLiveCandleRef.current);
          pendingLiveCandleRef.current = null;
        }
        // Anchor to the most recent intraday window so 1m candles stay legible.
        const logical = timeScale.getVisibleLogicalRange();
        if (!logical || logical.from === 0) {
          const total = candles.length;
          // ── DYNAMIC WINDOW FILL ──
          // Show only `visibleBars` wide candles (resolved from container
          // width), so bars are THICK and fully fill the pane instead of a
          // fixed 120 thin sticks. The in-progress bar stays at the right edge.
          timeScale.setVisibleLogicalRange({
            from: Math.max(total - visibleBars, 0),
            to: Math.max(
              total + RIGHT_GUTTER,
              total - visibleBars + RIGHT_GUTTER + 1,
            ),
          });
        } else if (shouldScroll) {
          anchorAtLiveEdge(candles.length);
        }
      } else {
        // ── LIVE WINDOW RE-ANCHOR ON RESIZE ──
        // When the container width changes (visibleBars changed), snap back to
        // the live edge so the newly-wider/narrower candles fill the pane.
        if (lastPushedWidthRef.current !== visibleBars) {
          const total = candles.length;
          timeScale.setVisibleLogicalRange({
            from: Math.max(total - visibleBars, 0),
            to: Math.max(
              total + RIGHT_GUTTER,
              total - visibleBars + RIGHT_GUTTER + 1,
            ),
          });
          lastPushedWidthRef.current = visibleBars;
        }
        // ── LIVE TICK-BY-TICK ANIMATION ──
        // The in-progress candle (and its volume) is updated in place on every
        // real tick so the bar visibly grows/shrinks into its final OHLC before
        // the next bucket rollover spawns a fresh candle. Its colour is pinned
        // to the active signal (see signalAligned). This runs on EVERY single
        // incoming tick (the store updates realtimeCandles per tick, which
        // recomputes normalizedData and fires this effect) — the open/high/low/
        // close of the ACTIVE candle are mutated instantly, never deferred to
        // the interval close.
        const sigLive = signalAligned(newest);
        // ── REDUNDANT-FRAME SKIP (zero-hop already painted this exact bar) ──
        // The zero-hop subscription pushed the freshest signal-aligned candle
        // into the series synchronously on the tick. When this React-path frame
        // is byte-identical to that push (same time + OHLC + colour), calling
        // series.update() again would schedule a needless canvas redraw on top
        // of the sub-millisecond zero-hop paint.
        if (
          prevPushed &&
          prevPushed.time === newestTime &&
          prevPushed.open === newest.open &&
          prevPushed.high === newest.high &&
          prevPushed.low === newest.low &&
          prevPushed.close === newest.close &&
          prevPushed.color === sigLive.color
        ) {
          if (shouldScroll) anchorAtLiveEdge(candles.length);
          lastPushedTimeRef.current = newestTime;
          updateGhostTip(
            ghostGlowLineRef.current,
            ghostTrailLineRef.current,
            newest,
          );
          renderProjectionRef.current?.();
          return;
        }
        // ── SAFE UPDATE GUARD (strict time-window check, no setData reload) ──
        // STORE TIME WINDOW CHECK: the incoming bar's timestamp must be >= the
        // session's latest active bar (the series tip). Three cases:
        //
        //   ·  same timestamp            → legitimate IN-PLACE overwrite of the
        //                                 current open candle: update its
        //                                 high/low/close directly via
        //                                 series.update(). This is the whole
        //                                 point of live tick-by-tick rendering.
        //   ·  newer timestamp           → bucket rollover; append a clean new
        //                                 candle (series.update() adds it).
        //   ·  STRICTLY OLDER timestamp  → a legacy/desynced tick or an
        //                                 out-of-sync historical backfill that
        //                                 lags the active session (by hours or
        //                                 days). It is SILENTLY DISCARDED with a
        //                                 structured warning — never fed to
        //                                 update() (which would throw) and never
        //                                 routed through a full setData reload
        //                                 (which could collapse the layout or
        //                                 blank the pane mid-stream).
        //
        // No setData() is ever triggered here during live streaming — stale
        // bars are just dropped, so the UI flow never breaks.
        const seriesData = series.data();
        const seriesLast =
          seriesData && seriesData.length > 0
            ? (seriesData[seriesData.length - 1]?.time as number)
            : -1;
        if (seriesLast >= 0 && newestTime < seriesLast) {
          // ── REQUESTED REJECTION — NO BASELINE INJECTION ──
          // The out-of-sync/desynced candle is discarded outright. It is never
          // replaced by a static baseline and never distorts the price scale.
          // The counter feeds the awaiting-live overlay (below).
          desyncCountRef.current += 1;
          console.warn(
            `[FinancialChart] Discarded out-of-sync candle at ${newestTime} ` +
              `(session tip is ${seriesLast}, lag=${seriesLast - newestTime}s)`,
          );
          lastPushedTimeRef.current = seriesLast;
        } else {
          series.update(sigLive);
          liveCandleRef.current = sigLive;
          desyncCountRef.current = 0;
          updateGhostTip(
            ghostGlowLineRef.current,
            ghostTrailLineRef.current,
            sigLive,
          );
          if (volumeSeries && volume.length > 0) {
            volumeSeries.update(volume[volume.length - 1]);
          }
        }
        if (shouldScroll) {
          anchorAtLiveEdge(candles.length);
        }
      }
      lastPushedTimeRef.current = newestTime;
      // ── PER-TICK FORECAST FLOW ──
      // Every real tick event advances the progressive expiry-forecast frame
      // too, so the projected path re-anchors off the freshest real close and
      // the forming target candle morphs in lock-step with the live bar.
      renderProjectionRef.current?.();
    } catch (err) {
      console.error("[FinancialChart] Error setting data:", err);
      // ── SELF-HEALING FULL-RENDER RECOVERY ──
      // An out-of-order bucket (e.g. a backend history bar landing inside the
      // live bucket's slot) can make series.update() throw. Recover by
      // rebuilding the ENTIRE series from the merged real dataset on the next
      // pass — the chart must never stay blank, frozen, or stale.
      try {
        series.setData(candles);
        if (volumeSeries) volumeSeries.setData(volume);
        try {
          ghostGlowLineRef.current?.setData(
            ghostGlowData(
              candles as Array<{ time: number; open: number; close: number }>,
              GHOST_HALO_BULL,
              GHOST_HALO_BEAR,
            ),
          );
          ghostTrailLineRef.current?.setData(
            ghostGlowData(
              candles as Array<{ time: number; open: number; close: number }>,
              GHOST_CORE_BULL,
              GHOST_CORE_BEAR,
            ),
          );
        } catch {}
        const recoveryTip = candles[candles.length - 1];
        lastPushedTimeRef.current = recoveryTip.time as number;
        needsFullResetRef.current = false;
      } catch {
        // Even the full rebuild failed (transient state) — force a clean
        // reset as soon as the next real dataset arrives.
        needsFullResetRef.current = true;
      }
    }
    // The chart EPOCH is a dependency: a re-creation (symbol/theme/height) must
    // FULLY re-paint the merged history onto the fresh series — otherwise
    // `normalizedData` (referentially stable across recreation) would skip this
    // effect and leave the new chart blank until the next tick.
  }, [normalizedData, visibleBars, chartEpoch]);

  // ── ZERO-LATENCY LIVE SUBSCRIPTION (tick → canvas in ONE call stack) ──
  // Subscribes directly to the shared aggregator's zero-hop live stream so every
  // WebSocket tick reforms the active candle synchronously INSIDE the socket
  // handler's own call stack — no React state, no useMemo, no scheduler hop.
  //
  //   1. `subscribeLive` fires pushLiveCandleRef synchronously per tick: the
  //      forming bar (and volume) is series.update()'d in place, the price line
  //      re-aims and the leading projection re-drifts — all in one stack
  //      (sub-millisecond UI sync).
  //
  //   2. A requestAnimationFrame loop re-aims the LEADING projection and
  //      advances the progressive forecast FRAME at display-refresh cadence.
  //      High-frequency tick bursts (100Hz+) coalesce onto ≤60-120Hz of canvas
  //      work for the predictive overlays, while the confirmed candle itself
  //      never waits for a frame.
  //
  //   3. A light 100ms beat loop remains as the safety net: it re-syncs the
  //      aggregator's wall clock (in case the module heartbeat ever stops) and
  //      keeps the price line fresh when no tick has just arrived.
  useEffect(() => {
    const agg = realtimeAggregator;
    if (!agg) return;

    const unsubscribe = agg.subscribeLive((candle, symbol) => {
      // Only this pane's pair — the aggregator aggregates every subscribed pair.
      if (!candle || symbol !== normSymbolRef.current) return;
      pushLiveCandleRef.current(candle);
    });

    const unsubQuantDispatch = useTradingStore.subscribe((state, prevState) => {
      if (state.lastQuantDispatch === prevState.lastQuantDispatch) return;
      const dispatch = state.lastQuantDispatch;
      if (!dispatch) return;
      if (!isChartLiveRef.current) return;
      if (dispatch.symbol.toUpperCase() !== normSymbolRef.current) return;
      const sig = `${dispatch.timestamp}:${dispatch.price}`;
      if (lastQuantDispatchSigRef.current === sig) return;
      lastQuantDispatchSigRef.current = sig;
      const activeNow = useTradingStore.getState().activeSymbol;
      if (
        activeNow &&
        activeNow.toUpperCase() !== dispatch.symbol.toUpperCase()
      ) {
        return;
      }
      try {
        const agg = realtimeAggregator;
        const fresh = agg && agg.getLiveCandle(normSymbolRef.current);
        if (fresh) {
          pushLiveCandleRef.current(fresh);
        }
      } catch {
      }
    });

    // Self-driving projector: the AGGREGATOR is the computational heart of the
    // leading target. On its own drone cadence (PROJECTION_DRIFT_MS) it emits a
    // fresh projection for the active pair even when no tick just landed — this
    // subscription re-aims the leading marker from that forward-looking buffer,
    // guaranteeing the target keeps drifting toward expiry on a silent tape.
    const unsubscribeProjection = agg.subscribeProjection((event) => {
      if (event.symbol !== normSymbolRef.current) return;
      paintLeadingRef.current();
    });

    // Predictive-lookahead subscriber: each projector beat that recomputes the
    // forward target candles for the ACTIVE pair re-paints the ahead-of-timeline
    // series through the same rAF-coalesced renderer — the chart keeps
    // outrunning the external feed even between ticks.
    const unsubscribeLookahead = agg.subscribeLookahead((event) => {
      if (event.symbol !== normSymbolRef.current) return;
      renderLookaheadRef.current?.();
    });

    let rafId = 0;
    const rafLoop = () => {
      // The frame is ALWAYS re-requested first so the loop survives chart
      // re-creations; the alive guard below only skips the paint work while the
      // chart instance is mid-teardown/creation.
      rafId = window.requestAnimationFrame(rafLoop);
      if (!isChartLiveRef.current) return;
      try {
        // Predictive overlays re-draw once per DISPLAY frame regardless of the
        // (much higher) tick rate: the leading marker drifts smoothly and the
        // forming forecast candles morph in lock-step with real time.
        paintLeadingRef.current();
        renderProjectionRef.current?.();
        renderLookaheadRef.current?.();
      } catch {
        // Never let a foreground re-paint hiccup kill the loop.
      }
    };
    rafId = window.requestAnimationFrame(rafLoop);

    const beat = window.setInterval(() => {
      // Safety net on the 100ms cadence — wall-clock sync + price-line fallback.
      if (!isChartLiveRef.current) return;
      try {
        realtimeAggregator?.syncWallClock();
      } catch {
        // Never let a sync hiccup kill the beat loop.
      }
      paintLeadingRef.current();
      updatePriceLineRef.current();
      renderLookaheadRef.current?.();
    }, 100);

    return () => {
      unsubscribe();
      unsubscribeProjection();
      unsubscribeLookahead();
      unsubQuantDispatch();
      window.cancelAnimationFrame(rafId);
      clearInterval(beat);
    };
  }, []);

  // ── LIVE PRICE LINE ──
  // A persistent tracking line pinned to the real live price so the forming
  // candle's close visibly rides it tick-by-tick. It is driven IMPERATIVELY by
  // `updatePriceLineRef` — invoked from the zero-hop tick subscription (sub-ms
  // re-aim, `priceLine.applyOptions`, never a remove/create churn) and from the
  // 100ms beat loop as a fallback when no tick arrived. This effect exists only
  // to (re)establish the line once the series is mounted; per-tick updates skip
  // React entirely. The old per-render effect was removed: it re-created the
  // price line on EVERY React render (once per tick), a heavy canvas churn.
  useEffect(() => {
    if (!isChartLiveRef.current) return;
    const series = seriesRef.current;
    if (!series) return;
    // Force-recreate the line once so a symbol/pair change re-attaches it to
    // the current series (createPriceLine applies pair precision at creation).
    if (livePriceLineRef.current) {
      try {
        series.removePriceLine(livePriceLineRef.current);
      } catch {}
      livePriceLineRef.current = null;
    }
    lastPriceLineValueRef.current = -1;
    updatePriceLineRef.current(
      Number(currentPrice) > 0 ? Number(currentPrice) : undefined,
    );
    // Re-runs per symbol AND per chart recreation (epoch bump) so the tracking
    // line always re-attaches to the current series instance — a theme/height
    // recreation otherwise loses the line until the next 100ms beat.
    // `up`, `liveCandleRef` etc. are refs read imperatively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, chartEpoch]);

  // ── AI PRICE-TARGET BAND RE-ATTACH ──
  // Re-creates the dashed High/Low target boundaries once per chart instance so
  // a theme/height recreation (epoch bump) or symbol switch re-attaches them to
  // the current series (createPriceLine is per-series). Values are re-derived
  // from the store's live prediction, so this needs no prop deps.
  useEffect(() => {
    if (!isChartLiveRef.current) return;
    updateTargetLinesRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, chartEpoch]);

  // ── PROGRESSIVE FORECAST TRIGGER ──
  // The real-time forecast engine lives in renderProjectionRef and is driven by
  // the zero-hop live tick subscription plus the 100ms leading beat. Any change
  // to the prediction RECIPE (target price, anchor, ATR, expiry horizon, signal
  // direction or chart timeframe) re-runs it immediately so the forming path
  // re-anchors on the latest backend forecast — no waiting for the next beat.
  useEffect(() => {
    renderProjectionRef.current?.();
  }, [
    predictedTargetPrice,
    predictionAnchorPrice,
    atr,
    projectionMinutes,
    signal,
    currentPrice,
    timeframe,
  ]);

  // ── AGGREGATOR HISTORY SEED ──
  // Seed the realtime aggregator with the backend's real historical bars once
  // per (symbol, timeframe) so live ticks append to genuine depth instead of an
  // empty series. Re-seeding on every /predict response would needlessly reset
  // accumulated live ticks, so a ref guard limits seeding to real transitions.
  const seededKeyRef = useRef<string>("");
  useEffect(() => {
    const normSymbol = symbol.toUpperCase();
    const key = `${normSymbol}:${timeframe}`;
    if (seededKeyRef.current !== key) {
      lastQuantDispatchSigRef.current = "";
    }
    if (!Array.isArray(data) || data.length === 0) return;
    if (seededKeyRef.current === key) return;
    seedAggregatorHistory(normSymbol, data);
    seededKeyRef.current = key;
  }, [data, symbol, timeframe, seedAggregatorHistory]);

  // ════════════════════════════════════════════════════════════════════
  // CLIENT-ONLY MOUNT GUARD (SVG / canvas hydration safety)
  // lightweight-charts mounts a <canvas> and imperative <svg> overlays that
  // can never match server-rendered markup — the two would diverge and React
  // would throw a Hydration Mismatch. Strictly render ONLY a static pulse
  // skeleton until hydration completes; the real canvas mounts exclusively
  // in the browser (the page additionally wraps <FinancialChart/> in
  // next/dynamic + ssr:false for a second layer of protection).
  // ════════════════════════════════════════════════════════════════════
  if (!isMounted) {
    return (
      <div className="w-full h-full min-h-[400px] bg-obsidian-900/60 animate-pulse rounded-xl" />
    );
  }

  return (
    <div
      className="relative w-full h-[320px] sm:h-[360px] md:h-[400px] lg:h-[450px] rounded-xl overflow-hidden border transition-colors duration-200"
      style={{
        backgroundColor: palette.containerBg,
        borderColor: palette.containerBorder,
      }}
    >
      <div ref={chartContainerRef} className="absolute inset-0" />

      {/* LIVE FORMING BADGE — signals that the rightmost bar is the active
          candle accumulating ticks in real-time, not a static history bar.
          When the stream has stalled OR is actively rejecting out-of-sync
          candles (desynced), the badge flips to an amber "AWAITING LIVE
          FEED..." indicator — never fabricated bars, never a static baseline. */}
      {hasRealData && !streamStalled && !streamDesynced && !stalePrice && (
        <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5">
          <AssetClassBadge symbol={symbol} />
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[9px] font-mono text-emerald-400 uppercase tracking-widest font-black">
            LIVE · {timeframe}
          </span>
          {requestedLookaheadHorizon != null && (
            <span className="text-[9px] font-mono text-sky-400 uppercase tracking-widest font-bold bg-sky-500/10 border border-sky-500/20 rounded px-1.5 py-0.5">
              LOOKAHEAD {requestedLookaheadHorizon}m
            </span>
          )}
        </div>
      )}

      {/* STALE PRICE BADGE — the last price packet is >2s old. Show a warning
          instead of pretending the frozen price is live. */}
      {hasRealData && !streamStalled && !streamDesynced && stalePrice && (
        <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5">
          <AssetClassBadge symbol={symbol} />
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-[9px] font-mono text-amber-400 uppercase tracking-widest font-black">
            STALE PRICE · {timeframe}
          </span>
        </div>
      )}

      {hasRealData && (streamStalled || streamDesynced) && (
        <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5">
          <AssetClassBadge symbol={symbol} />
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-[9px] font-mono text-amber-400 uppercase tracking-widest font-black">
            {streamDesynced
              ? "AWAITING LIVE FEED / CONNECTING..."
              : "WAITING FOR LIVE STREAM..."}
          </span>
        </div>
      )}

      {hasRealData && (streamStalled || streamDesynced) && (
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-2">
          <p className="text-[9px] font-mono text-amber-400/80 uppercase tracking-widest bg-black/40 px-2 py-1 rounded backdrop-blur-sm">
            {streamDesynced
              ? "Live feed synchronising — awaiting a valid tick (no fake prices)"
              : "Live feed paused — resuming on next tick"}
          </p>
        </div>
      )}

      {!hasRealData && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <div className="w-8 h-8 rounded-full border-2 border-slate-600/60 border-t-blue-400 animate-spin" />
          <p className="text-xs font-mono text-slate-400 uppercase tracking-widest">
            {t("awaitingLiveMarketData")}
          </p>
          <p className="text-[10px] font-mono text-slate-500">
            {getPairLabel(symbol)} · {t("candlesRenderRealtime")}
          </p>
        </div>
      )}

      {/* PREDICTIVE LEAD-TIME OFFSET SELECTOR — configures how the forming
          candle is projected relative to the platform timeline: AUTO (default)
          = exact PO parity — the live candle sits on the exact backend floor
          grid (lead 0, byte-identical to `floor(ts / interval) * interval`).
          An explicit 20s / 1m lead projects the grid that far ahead instead.
          Persists via the store and re-buckets the live grid immediately. */}
      {hasRealData && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10">
          <span className="text-[9px] font-mono text-sky-400 uppercase tracking-widest font-bold bg-sky-500/10 border border-sky-500/20 rounded px-1.5 py-0.5">
            LEAD
          </span>
          {LEAD_OFFSET_OPTIONS.map((opt) => {
            const active = (selectedLeadOffsetMs ?? null) === (opt.value ?? null);
            return (
              <button
                key={opt.label}
                onClick={() => setLeadOffset(opt.value)}
                className={`text-[9px] font-mono uppercase tracking-widest font-bold rounded px-1.5 py-0.5 transition-colors ${
                  active
                    ? "bg-sky-500/25 border border-sky-400/50 text-sky-300"
                    : "bg-white/5 border border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20"
                }`}
                title={
                  opt.value == null
                    ? "Auto (default): exact PO floor grid — candles line up 1:1 with the backend"
                    : `Project candles ${opt.value / 1000}s ahead of the feed`
                }
              >
                {opt.label}
              </button>
            );
          })}
          <span className="w-px h-3 bg-white/10" />
          <button
            onClick={() => hardResetLiveData()}
            className="text-[9px] font-mono uppercase tracking-widest font-bold rounded px-1.5 py-0.5 transition-colors bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:text-rose-200 hover:border-rose-400/50"
            title="Clear all caches and re-initialize the live feed from the broker's tick ring"
          >
            RESET FEED
          </button>
        </div>
      )}
    </div>
  );
};

export default FinancialChart;
