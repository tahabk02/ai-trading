"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type BusinessDay,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTradingStore, realtimeAggregator } from "@/store/useTradingStore";
import { useLangContext } from "@/hooks/useLangContext";
import { useTheme } from "@/hooks/useTheme";
import {
  normalizeTimeframe,
  timeframeToMs,
  bucketStart,
  historyBarCheck,
  formatAxisTime,
  targetColorFor,
  targetIntervalsFor,
  targetDurationMinutes,
  expiryMarkerBucketSec,
  expiryMarkerClockLabel,
  targetViewportNeedsReanchor,
  buildSignalView,
  targetViewportRange,
  timeframeToSeconds,
  TARGET_RIGHT_GUTTER,
  INITIAL_BAR_SPACING_PX,
  MIN_BAR_SPACING_PX,
  SIGNAL_CONFIDENCE_THRESHOLD,
  TargetProjectionEngine,
  SignalHoldBuffer,
  rawAnchorClose,
  syncRawDisplay,
  type AggregatorDebug,
  type Candle,
  type RawDisplaySeries,
  type SignalHoldView,
  type TargetCandleData,
} from "@/lib/realtimeCandleAggregator";
import {
  barTintForBufferedSignal,
  formatTargetCandlesLabel,
  targetCandlesLabelFor,
} from "@/lib/signalRender";
import { targetCandlesEnabled } from "@/lib/signalTiers";
import { expiryCountdownRemainingSeconds } from "@/lib/expirySelection";
import { getPairLabel, getPriceDigits } from "@/constants/symbols";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";
import {
  chartDebugQualityFields,
  type QualityPredictDebug,
} from "@/lib/chartDebug";
import { useSignalViewStore } from "@/lib/signalViewStore";
import { normalizeProjectionAtr, clampTargetToAnchor } from "@/lib/projectionAtr";
import { ExpiryTimeMarker, type ExpiryMarkerTheme } from "@/lib/verticalTimeMarker";

/**
 * ── COHERENCE PUBLISHER ──────────────────────────────────────────────────
 * Renders nothing. Republishes the chart's ONE `SignalHoldView` so the
 * CoherenceStrip renders the same signal the HUD is painting, instead of
 * re-deriving it from the raw store field (which flickers to `null` between
 * the REST and WS writers — the "SIGNAL: WAITING" gap).
 *
 * Deliberately a standalone child rather than an inline `useEffect` in the
 * chart body: it keeps this hook out of a 1700-line component's hook order
 * entirely, so no conditional-early-return above `hudView` can ever make this
 * call site conditional.
 *
 * INVARIANT 1: this runs on the chart's HUD render cadence (~1 Hz), never
 * inside the per-tick paint loop, and the store write is change-gated on all
 * four view fields — so it cannot reintroduce a per-tick re-render.
 */
function SignalViewPublisher({ view }: { view: SignalHoldView }) {
  const publishSignalView = useSignalViewStore((s) => s.publishSignalView);
  const lastPublishedRef = useRef<SignalHoldView | null>(null);

  useEffect(() => {
    const previous = lastPublishedRef.current;
    if (
      previous &&
      previous.gatedSignal === view.gatedSignal &&
      previous.tier === view.tier &&
      previous.bucketSec === view.bucketSec &&
      previous.suppressedReason === view.suppressedReason
    ) {
      return;
    }
    lastPublishedRef.current = view;
    publishSignalView(view);
  }, [view, publishSignalView]);

  return null;
}

declare global {
  interface Window {
    __chartDebug?: AggregatorDebug;
  }
}

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
  predictedTargetPrice?: number;
  predictionAnchorPrice?: number;
  atr?: number;
  /** PO expiration in SECONDS (selectedExpirationSeconds). Target-candle count
   *  = max(1, round(expirationSeconds / timeframeSeconds)). */
  expirationSeconds?: number;
  signal?: "BUY" | "SELL" | null;
  confidence?: number;
  /**
   * PART 19.2 [118] — book agreement internals; the 0-100 HUD number is a
   * confluence score (n/n strategy books aligned), never a probability.
   */
  book_agreement_detail?: {
    convergence_index?: number;
    alignment?: number;
    magnitude?: number;
    aligned_count?: number;
    active_count?: number;
    label?: string;
  } | null;
  lookaheadHorizon?: number;
  streamStalled?: boolean;
  stalePrice?: boolean;
  candleParityBreach?: {
    symbol: string;
    timeframe: string;
    tickCount: number;
    bucketWrites: number;
  } | null;
}

const OBSIDIAN = "#070910";
const BULLISH = "#26a69a";
const BEARISH = "#ef5350";
const NEUTRAL = "rgba(100,116,139,0.6)";
const GAP_CANDLE = "rgba(100,116,139,0.16)";
const VOL_UP = "rgba(34,171,148,0.45)";
const VOL_DOWN = "rgba(242,54,69,0.45)";
const AXIS_TEXT = "#94a3b8";
const GRID_LINE = "rgba(148,163,184,0.14)";
const BORDER = "#2a3448";
const CROSSHAIR = "rgba(148,163,184,0.35)";
const PRICE_LINE = "rgba(148,163,184,0.85)";
const TGT_LINE = "#26a69a";
const ANC_LINE = "#94a3b8";
const STOP_LINE = "#ef5350";

/**
 * Read a design-system token from the live document root. The chart is drawn
 * on a <canvas>, so it cannot consume Tailwind classes directly — it resolves
 * the SAME `--tp-*` variables defined in globals.css instead. Falls back to the
 * institutional dark value when the variable is unavailable (SSR/headless).
 */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/**
 * PART 37 — resolve the expiry-marker theme from the same `--tp-*` tokens the
 * rest of the canvas reads, so the marker flips with the dark/light toggle
 * instead of hard-coding the institutional dark values.
 */
function expiryMarkerTheme(): ExpiryMarkerTheme {
  return {
    line: cssVar("--tp-expiry-line", "#94a3b8"),
    labelBg: cssVar("--tp-elevated", "#171c28"),
    labelInk: cssVar("--tp-text", "#f8fafc"),
    labelMuted: cssVar("--tp-text-2", "#94a3b8"),
  };
}

type GridCandle = Candle & {
  isGap?: boolean;
  isFinal?: boolean;
  symbol?: string;
};

const LEAD_OFFSET_OPTIONS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: "AUTO", value: null },
  { label: "20S", value: 20_000 },
  { label: "1M", value: 60_000 },
];

interface ChartLineBag {
  live?: IPriceLine;
  target?: IPriceLine;
  anchor?: IPriceLine;
  stop?: IPriceLine;
  hi?: IPriceLine;
  lo?: IPriceLine;
}

function candleRow(row: GridCandle): CandlestickData {
  return {
    time: Math.floor(row.timestamp / 1000) as UTCTimestamp,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  };
}

function volumeRow(row: GridCandle): HistogramData {
  return {
    time: Math.floor(row.timestamp / 1000) as UTCTimestamp,
    value: row.volume > 0 ? row.volume : 0,
    color: row.close >= row.open ? VOL_UP : VOL_DOWN,
  };
}

function candleData(rows: GridCandle[]): CandlestickData[] {
  const out: CandlestickData[] = [];
  for (const r of rows) {
    const base = candleRow(r);
    if (r.isGap === true) {
      out.push({
        ...base,
        color: GAP_CANDLE,
        borderColor: GAP_CANDLE,
        wickColor: GAP_CANDLE,
      });
    } else {
      out.push(base);
    }
  }
  return out;
}

function volumeData(rows: GridCandle[]): HistogramData[] {
  return rows.map(volumeRow);
}

function applyCandleData(
  candleSeries: ISeriesApi<"Candlestick"> | null,
  volume: ISeriesApi<"Histogram"> | null,
  rows: GridCandle[],
): void {
  try {
    candleSeries?.setData(candleData(rows));
  } catch {}
  try {
    volume?.setData(volumeData(rows));
  } catch {}
}

function buildSeries(
  symbol: string,
  bucketMs: number,
  dataProp: APICandle[],
  serverClosed: GridCandle[] = [],
): { raw: GridCandle[]; rows: GridCandle[]; rejected: number } {
  const byTs = new Map<number, GridCandle>();
  let rejected = 0;
  const now = Date.now();
  for (const c of dataProp ?? []) {
    let ts = Number(c.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (ts < 1e12) ts *= 1000;
    if (!historyBarCheck(ts, bucketMs, now)) {
      rejected += 1;
      continue;
    }
    byTs.set(ts, {
      timestamp: ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: Number.isFinite(c.volume) ? (c.volume as number) : 0,
    });
  }
  // SERVER-AUTHORITATIVE CLOSED CANDLES — overwrite /predict history at the
  // same bucket. The backend is the single source of truth for closed bars
  // on the aggregated timeframes (1s/5s/20s/1m).
  for (const r of serverClosed ?? []) {
    const slot = Number(r.timestamp);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    byTs.set(slot, { ...r, isFinal: true });
  }
  // Intra-frame builder output: the client aggregator paints ONLY the current
  // forming bar here. Its locally-closed rows are a fallback ONLY when the
  // server has no candle for that bucket (non-server timeframes, or before the
  // first server close).
  //
  // PRECEDENCE: a sealed server bar (isFinal) is IMMUTABLE — a client row for
  // the same slot is never allowed to overwrite it. The previous guard tested
  // the *client* row's flag, which no producer ever set, so client rows
  // silently repainted settled bars (flicker/duplicate/"broken" candles).
  const aggregated = realtimeAggregator.getRawSeries(symbol) as GridCandle[];
  for (const r of aggregated) {
    if (r.isGap === true) continue;
    const slot = Number(r.timestamp);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    const existing = byTs.get(slot);
    if (existing && existing.isFinal === true) continue;
    byTs.set(slot, r);
  }
  const merged: GridCandle[] = [];
  for (const r of [...byTs.values()].sort(
    (a, b) => a.timestamp - b.timestamp,
  )) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (prev && r.timestamp <= prev.timestamp) continue;
    merged.push(r);
  }
  // ONE display fold over the FULLY MERGED series. Folding only the client
  // rows (and splicing raw server rows in beside them) rendered two different
  // candle geometries on one price axis and restarted the recursive HA_Open
  // chain at the server/client seam.
  //
  // `raw` is the merged REAL domain and `rows` its pure HA fold. Both are
  // returned so the live-tick path can mutate `raw` ONLY and re-derive `rows` —
  // a raw tick must never be written into the folded array.
  //
  // PART 32[236] — RAW DOMAIN IS NOW THE DISPLAY DOMAIN. Previously `rows` was
  // the Heikin-Ashi fold, which put two DIFFERENT price domains on one chart:
  // the candle BODIES/WICKS were smoothed HA geometry, while the TGT / ANC /
  // LIVE price lines, the TGT badge and the delta % were all anchored on the
  // RAW broker close (rawAnchorClose). A reader comparing the TGT badge against
  // the candle it sits next to could never reconcile them, because an HA body's
  // high/low is not any real traded price (HA high = max(high, close, open_prev)).
  // Every predictive label on this chart is RAW, so the tape is RAW too.
  // HA is still available as an analysis overlay via `display`.
  const { raw } = syncRawDisplay(merged) as RawDisplaySeries<GridCandle>;
  return { raw, rows: raw, rejected };
}

function mergeLiveTick(
  rows: GridCandle[],
  c: GridCandle,
): "updated" | "appended" | "stale" {
  const ts = Number(c.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return "stale";
  if (rows.length === 0) {
    rows.push(c);
    return "appended";
  }
  const lastTs = rows[rows.length - 1].timestamp;
  if (ts > lastTs) {
    rows.push(c);
    return "appended";
  }
  if (ts === lastTs) {
    rows[rows.length - 1] = c;
    return "updated";
  }
  for (let i = rows.length - 2; i >= 0; i--) {
    if (rows[i].timestamp === ts) {
      rows[i] = c;
      return "updated";
    }
    if (rows[i].timestamp < ts) break;
  }
  return "stale";
}

function targetData(frame: TargetCandleData[]): CandlestickData[] {
  const out: CandlestickData[] = [];
  for (const f of frame) {
    out.push({
      time: f.time as UTCTimestamp,
      open: f.open,
      high: f.high,
      low: f.low,
      close: f.close,
      color: f.color,
      borderColor: f.borderColor,
      wickColor: f.wickColor,
    });
  }
  return out;
}

function applyTargetStyle(
  series: ISeriesApi<"Candlestick"> | null,
  signalValue: string | null | undefined,
): void {
  const color = targetColorFor(signalValue);
  try {
    series?.applyOptions({
      upColor: color,
      downColor: color,
      borderUpColor: color,
      borderDownColor: color,
      wickUpColor: color,
      wickDownColor: color,
    });
  } catch {}
}

function setPriceLine(
  bag: ChartLineBag,
  key: keyof ChartLineBag,
  series: ISeriesApi<"Candlestick">,
  price: number,
  color: string,
  style: LineStyle,
  title: string,
): void {
  if (!Number.isFinite(price) || price <= 0) {
    const existing = bag[key];
    if (existing) {
      try {
        series.removePriceLine(existing);
      } catch {}
      bag[key] = undefined;
    }
    return;
  }
  const existing = bag[key];
  if (existing) {
    try {
      existing.applyOptions({
        price,
        color,
        lineWidth: 1,
        lineStyle: style,
        title,
        axisLabelVisible: true,
      });
    } catch {}
    return;
  }
  try {
    bag[key] = series.createPriceLine({
      price,
      color,
      lineWidth: 1,
      lineStyle: style,
      title,
      axisLabelVisible: true,
    });
  } catch {}
}

function writeChartDebug(fields: Partial<AggregatorDebug>): void {
  if (typeof window === "undefined") return;
  const prev = window.__chartDebug ?? {};
  window.__chartDebug = { ...prev, ...fields } as AggregatorDebug;
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
  expirationSeconds = 300,
  signal,
  confidence,
  streamStalled = false,
  stalePrice = false,
  candleParityBreach = null,
}) => {
  const activeSymbol = symbol.trim().toUpperCase();
  const tf = normalizeTimeframe(timeframe) ?? "M1";
  const bucketMs = timeframeToMs(tf);
  const expSeconds = Math.max(1, Math.round(Number(expirationSeconds) || 60));
  const tfSeconds = timeframeToSeconds(tf);
  const dataEpoch = useTradingStore((s) => s.dataEpoch);
  const serverCandleVersion = useTradingStore((s) => s.serverCandleVersion);
  const feedStatus = useTradingStore((s) => s.feedStatus);
  const selectedLeadOffsetMs = useTradingStore((s) => s.selectedLeadOffsetMs);
  const hardResetLiveData = useTradingStore((s) => s.hardResetLiveData);
  const setAggregatorTimeframe = useTradingStore(
    (s) => s.setAggregatorTimeframe,
  );
  const setLeadOffset = useTradingStore((s) => s.setLeadOffset);
  const predictionData = useTradingStore((s) => s.predictionData);
  const { t } = useLangContext();
  const { resolvedTheme } = useTheme();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const targetSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  /**
   * RAW domain — real broker OHLC, the single source of truth.
   * `dataRef` holds its Heikin-Ashi fold and is DISPLAY ONLY. Live ticks mutate
   * this array and never the folded one.
   */
  const rawRef = useRef<GridCandle[]>([]);
  const dataRef = useRef<GridCandle[]>([]);
  const linesRef = useRef<ChartLineBag>({});
  const targetStructuralKeyRef = useRef("");
  const lastTargetIntervalsRef = useRef(0);
  const targetCountdownAnchorRef = useRef(0);
  const projectionRef = useRef<TargetProjectionEngine>(new TargetProjectionEngine());
  const signalHoldRef = useRef<SignalHoldBuffer>(
    new SignalHoldBuffer({ holdNeutralEvals: 2 }),
  );
  const rejectedCountRef = useRef(0);
  const firstTickRef = useRef(true);
  // MASTER MISSION part 3 — rAF-coalesced painter state: ticks only flag a
  // pending paint; ONE requestAnimationFrame flush drains them per frame.
  const pendingPaintRef = useRef(false);
  const lastPaintedCountRef = useRef(0);
  // FRAME CACHE (quick-fix part 2) — fingerprint of the forming candle from
  // the last frame we actually painted. When a coalesced burst of ticks
  // resolves to the SAME count + forming-candle values, the repaint is skipped
  // entirely (no series updates, no target-layer projection/markers).
  const lastPaintedTipKeyRef = useRef("");
  /**
   * PART 37 [313]-[316] — the vertical EXPIRY boundary, as a native
   * lightweight-charts series primitive on the CANDLE series. Created lazily on
   * first paint so it never exists without an attached series to hold it.
   */
  const expiryMarkerRef = useRef<ExpiryTimeMarker | null>(null);
  /**
   * Theme for the marker, resolved ONCE per chart build (the effect re-runs on
   * `resolvedTheme`). Reading `getComputedStyle` inside the paint loop would
   * force a style recalculation on every animation frame of the live tape.
   */
  const expiryMarkerThemeRef = useRef<ExpiryMarkerTheme | null>(null);
  const [hasCandles, setHasCandles] = useState(false);
  const [targetLayerActive, setTargetLayerActive] = useState(false);
  const [currentDividerX, setCurrentDividerX] = useState<number | null>(null);
  const [hudNowMs, setHudNowMs] = useState<number>(() => Date.now());
  const targetDurationMin = targetDurationMinutes(expSeconds);

  const activeSymbolRef = useRef(activeSymbol);
  activeSymbolRef.current = activeSymbol;
  const timeframeRef = useRef(tf);
  timeframeRef.current = tf;
  const dataPropRef = useRef(data);
  dataPropRef.current = data;
  const targetRef = useRef(predictedTargetPrice);
  targetRef.current = predictedTargetPrice;
  const anchorRef = useRef(predictionAnchorPrice);
  anchorRef.current = predictionAnchorPrice;
  const signalRef = useRef(signal);
  signalRef.current = signal;
  const confPropRef = useRef(confidence);
  confPropRef.current = confidence;
  const predictionDataRef = useRef(predictionData);
  predictionDataRef.current = predictionData;
  const atrRef = useRef(atr);
  /*
   * NORMALISE ATR BEFORE IT CAN REACH THE PROJECTOR.
   *
   * `buildTargetFrame` clamps the wick to `safetyCap = 50% of the price level`.
   * That clamp does not suppress an out-of-scale ATR — it is the only thing
   * shaping the geometry once ATR is wrong, and at 50% of price it draws a wick
   * that reaches the top of the chart on the shared right scale. That is the
   * reported "vertical spikes shooting up to the ceiling".
   *
   * Validating here, at the boundary where the wire value enters the chart, means
   * `safetyCap` becomes unreachable for any plausible input and the arc renders
   * with either a sane envelope or none at all — never a ceiling spike. It also
   * keeps this OUT of `realtimeCandleAggregator.ts`, so the projection engine and
   * the zero-hop tick path are untouched.
   */
  // Validated against the ANCHOR — the baseline the arc actually grows from, and
  // the level whose units the incoming ATR must match. Falls back to the target,
  // then to 0, which renders a flat line rather than an unvalidated envelope.
  atrRef.current = normalizeProjectionAtr(
    atr,
    anchorRef.current || targetRef.current,
  );
  const expSecondsRef = useRef(expSeconds);
  expSecondsRef.current = expSeconds;
  const tfSecondsRef = useRef(tfSeconds);
  tfSecondsRef.current = tfSeconds;
  const currentPriceRef = useRef(currentPrice);
  currentPriceRef.current = currentPrice;
  // Refs mirror store/prop values so the unified rAF loop reads LATEST state
  // without re-arming its effect on every flip.
  const feedStatusRef = useRef(feedStatus);
  feedStatusRef.current = feedStatus;
  const hasCandlesRef = useRef(hasCandles);
  hasCandlesRef.current = hasCandles;

  const predictionLike: {
    signal?: string | null;
    confidence?: number;
  } | null = predictionData
    ? { signal: predictionData.signal, confidence: predictionData.confidence }
    : signal || confidence !== undefined
      ? { signal: signal ?? null, confidence: confidence ?? 0 }
      : null;
  const signalView = buildSignalView(
    predictionLike,
    SIGNAL_CONFIDENCE_THRESHOLD,
  );
  const effSignal = signalView.gatedSignal;
  const liveCloseView =
    // RAW domain: the live tape close, NOT the Heikin-Ashi display close. The HA
    // close is a smoothed midpoint, so anchoring predictive geometry on it made
    // the TGT trail the real feed.
    rawAnchorClose(rawRef.current) ||
    Number(currentPrice) ||
    0;
  const feedOffline =
    feedStatus === "awaiting_ssid" || feedStatus === "auth_failed";
  const feedWaiting = feedStatus === "stalled" || feedStatus === "degraded";

  const swapKey = `${activeSymbol}|${tf}|${dataEpoch}|${
    selectedLeadOffsetMs ?? "auto"
  }|${data.length}|${serverCandleVersion}`;

  // PART 21 — the ONE current-view object produced per tick. `evaluate` commits
  // direction + tier ATOMICALLY: while a direction is frozen the tier rides
  // beside it, so the HUD label and the target-candle gate can never display
  // two different dispatches (the PART 20 drift class).
  const currentSignalView = useCallback((): SignalHoldView => {
    const propLike =
      signalRef.current || confPropRef.current !== undefined
        ? {
            signal: signalRef.current ?? null,
            confidence: confPropRef.current ?? 0,
          }
        : null;
    const rawGated = buildSignalView(
      predictionDataRef.current ?? propLike,
      SIGNAL_CONFIDENCE_THRESHOLD,
    ).gatedSignal;
    // Signal stability: the 96.5% gate yields a raw gated value every tick,
    // but the label must NOT mutate mid-bucket. Freeze the committed signal
    // for the active timeout bucket and require sustained neutral before it
    // clears — confidence jitter alone can never shimmer the label.
    const rows = dataRef.current;
    const bw = timeframeToMs(timeframeRef.current);
    const tip = rows.length > 0 ? rows[rows.length - 1] : null;
    const tipGridMs =
      tip && tip.timestamp > 0 ? bucketStart(tip.timestamp, bw) : 0;
    const wallSec = tipGridMs > 0 ? Math.floor(tipGridMs / 1000) : 0;
    const tfSec = timeframeToSeconds(timeframeRef.current);
    // PART 9 — engine-decided time-gate: when the backend demoted this very
    // emission to "too_late" (not enough real time left in the bucket to act),
    // the buffer blanks the label and surfaces the reason. Never client-derived.
    // PART 14 — the regime gate rides the SAME suppressed_reason channel:
    // a random_walk symbol arrives as "regime_scored_only" (scored, never
    // tradable) and is blanked + reasoned the same way.
    const engineSuppress =
      (
        predictionDataRef.current as {
          suppressed_reason?: string | null;
        } | null
      )?.suppressed_reason?.trim().toLowerCase() === "too_late"
        ? ("too_late" as const)
        : (
            predictionDataRef.current as {
              suppressed_reason?: string | null;
            } | null
          )?.suppressed_reason?.trim().toLowerCase() === "regime_scored_only"
          ? ("regime_scored_only" as const)
          : null;
    // PART 11 [25] + PART 21 [136] — realMs is a CONSTANT-OFFSET alias of the
    // aggregator's timingNow(): clockOffsetMs only refreshes on a genuine
    // upstream print, so between prints Date.now() advances 1:1 with
    // timingNow(). Only the elapsed INTERVAL matters for neutral-hysteresis,
    // so the two clocks are provably interchangeable here — the freeze decision
    // itself runs on `wallSec` (the broker-grid bucket floor), identical to the
    // `liveTipBucketSec` the projection engine consumes.
    signalHoldRef.current.evaluate(
      rawGated,
      wallSec,
      tfSec,
      engineSuppress,
      Date.now(),
      // PART 21 — raw /predict tier, committed with the direction. While a
      // direction is held the buffer FREEZES this tier; when neutral it is the
      // fallback for the target-candle gate (PART 8: a T3 candle legitimately
      // renders with a gated-out label).
      (
        predictionDataRef.current as { tier?: string | null } | null
      )?.tier ?? null,
    );
    // The evaluate() return is the stabilized gated direction — consumers that
    // need tier MUST read view(), never a second predictionDataRef fetch.
    return signalHoldRef.current.view();
  }, []);

  const effectiveSignal = useCallback((): "BUY" | "SELL" | null => {
    return currentSignalView().gatedSignal;
  }, [currentSignalView]);

  const reanchor = useCallback((mainCount: number, intervals: number): void => {
    const chart = chartRef.current;
    if (!chart || mainCount <= 0) return;
    try {
      chart
        .timeScale()
        .setVisibleLogicalRange(
          targetViewportRange(mainCount, intervals, TARGET_RIGHT_GUTTER),
        );
    } catch {}
  }, []);

  const syncMarkers = useCallback(
    (
      _dirColor: string,
      last: TargetCandleData | null,
      targetPrice: number,
      anchorPrice: number,
      stopPrice: number,
      /* PART 24 [159] — projection price lines (TGT/ANC/STOP/T-HI/T-LO) draw
         ONLY inside the target zone (T1–T3). At T4/T5 the main tape must not
         show a dashed TGT line next to an empty projection — the same honesty
         gate as the candle shape. The LIVE price line stays in both cases. */
      zoneActive: boolean,
    ): void => {
      const series = candleSeriesRef.current;
      if (!series) return;
      const bag = linesRef.current;
      const live = Number(currentPriceRef.current);
      if (zoneActive) {
        setPriceLine(
          bag,
          "target",
          series,
          targetPrice,
          TGT_LINE,
          LineStyle.Dashed,
          "TGT",
        );
        setPriceLine(
          bag,
          "anchor",
          series,
          anchorPrice,
          ANC_LINE,
          LineStyle.Dotted,
          "ANC",
        );
        setPriceLine(
          bag,
          "stop",
          series,
          stopPrice,
          STOP_LINE,
          LineStyle.Dashed,
          "STOP",
        );
        if (last) {
          setPriceLine(
            bag,
            "hi",
            series,
            last.high,
            TGT_LINE,
            LineStyle.Dotted,
            "T-HI",
          );
          setPriceLine(
            bag,
            "lo",
            series,
            last.low,
            TGT_LINE,
            LineStyle.Dotted,
            "T-LO",
          );
        } else {
          setPriceLine(bag, "hi", series, 0, TGT_LINE, LineStyle.Dotted, "T-HI");
          setPriceLine(bag, "lo", series, 0, TGT_LINE, LineStyle.Dotted, "T-LO");
        }
      } else {
        setPriceLine(bag, "target", series, 0, TGT_LINE, LineStyle.Dashed, "TGT");
        setPriceLine(bag, "anchor", series, 0, ANC_LINE, LineStyle.Dotted, "ANC");
        setPriceLine(bag, "stop", series, 0, STOP_LINE, LineStyle.Dashed, "STOP");
        setPriceLine(bag, "hi", series, 0, TGT_LINE, LineStyle.Dotted, "T-HI");
        setPriceLine(bag, "lo", series, 0, TGT_LINE, LineStyle.Dotted, "T-LO");
      }
      // ── LIVE price line ──
      setPriceLine(
        bag,
        "live",
        series,
        live,
        PRICE_LINE,
        LineStyle.Solid,
        "LIVE",
      );
    },
    [],
  );

  /**
   * PART 37 [316]-[318] — position the vertical EXPIRY boundary.
   *
   * The marker NEVER derives a time of its own. `expiryMarkerBucketSec` resolves
   * the projection's own last slot (`targetSlots`/`targetIntervalsFor`), which is
   * exactly `liveTipBucketSec + expirationSeconds` for every expiry on the
   * 60/120/300/600 ladder across the 5s..60s grids, and stays glued to the last
   * projected candle on coarser grids instead of drifting inside the zone.
   *
   * SHOWN FOR ANY SIGNAL AND TIER: this is time information, not a projection
   * verdict, so it is deliberately NOT gated on `targetCandlesEnabled(tier)` or
   * on BUY/SELL — a HOLD at T5 still has an expiry horizon, and hiding it there
   * would make the horizon the one surface that disappears exactly when the
   * operator is least oriented.
   *
   * NOT gated on PART 24 either: that module made expiry selection permanently
   * un-gatable by design (its `suppressed` field is deleted, and `actionReady`/
   * `regimeBlocked` are render-only). So there is no PART 24 state in which an
   * expiry "is disabled" — the set to suppress on is empty, and inventing one
   * would re-create the circular deadlock `expirySelection.ts` documents.
   *
   * `0` hides the marker: the honest rendering of "there is no expiry boundary
   * yet", i.e. no live tip bucket to anchor to.
   */
  const syncExpiryMarker = useCallback(
    (tipSec: number, tfSec: number, expSec: number): void => {
      const marker = expiryMarkerRef.current;
      if (!marker) return;
      const bucket = expiryMarkerBucketSec(tipSec, expSec, tfSec);
      marker.set(
        bucket,
        bucket > 0 ? expiryMarkerClockLabel(bucket) : "",
        expiryMarkerThemeRef.current ?? undefined,
      );
    },
    [],
  );

  const syncChartDebug = useCallback(
    (
      rows: GridCandle[],
      bw: number,
      tipSec: number,
      intervals: number,
      frame: TargetCandleData[],
      signalValue: "BUY" | "SELL" | null,
    ): void => {
      const tip = rows.length > 0 ? rows[rows.length - 1] : null;
      const bws = bw / 1000;
      const firstTargetOffsetSec =
        intervals > 0
          ? Math.min(bws, expSecondsRef.current)
          : 0;
      const lastTargetOffsetSec =
        intervals > 0 ? expSecondsRef.current : 0;
      let targetHigh = 0;
      let targetLow = 0;
      if (frame.length > 0) {
        targetHigh = frame[0].high;
        targetLow = frame[0].low;
        for (const f of frame) {
          if (f.high > targetHigh) targetHigh = f.high;
          if (f.low < targetLow) targetLow = f.low;
        }
      }
      writeChartDebug({
        symbol: activeSymbolRef.current,
        timeframe: timeframeRef.current,
        bucketMs: bw,
        candleCount: rows.length,
        historyRejectedCount: rejectedCountRef.current,
        tipBucketMs: tip ? tip.timestamp : 0,
        projectionSlot0OffsetMs: firstTargetOffsetSec * 1000,
        expirationSeconds: expSecondsRef.current,
        timeframeSeconds: tfSecondsRef.current,
        intervals,
        liveTipBucketSec: tipSec,
        firstTargetBucketSec:
          intervals > 0 && tipSec > 0 ? tipSec + firstTargetOffsetSec : 0,
        firstTargetOffsetSec,
        lastTargetBucketSec:
          intervals > 0 && tipSec > 0 ? tipSec + lastTargetOffsetSec : 0,
        lastTargetOffsetSec,
        targetDirection: signalValue,
        targetFirstClose: frame.length > 0 ? frame[0].close : 0,
        targetLastClose: frame.length > 0 ? frame[frame.length - 1].close : 0,
        targetHigh,
        targetLow,
        lookaheadHorizon: targetDurationMinutes(expSecondsRef.current),
        // PART 8 — explicit verification surface (exact window.__chartDebug keys)
        mergedCandles: rows.length,
        targetIntervals: intervals,
        targetFirstSlot:
          intervals > 0 && tipSec > 0 ? tipSec + firstTargetOffsetSec : 0,
        targetLastSlot:
          intervals > 0 && tipSec > 0 ? tipSec + lastTargetOffsetSec : 0,
        targetCount: frame.length,
        barSpacing: chartRef.current?.timeScale().options().barSpacing ?? 0,
        chartWidth: containerRef.current?.clientWidth ?? 0,
        feedStatus: feedStatusRef.current,
        gatedSignal: signalValue,
        // [4] — debug keys per quick-fix spec
        timeframeSec: tfSecondsRef.current,
        expirationSec: expSecondsRef.current,
        targetFirstSlotSec:
          intervals > 0 && tipSec > 0 ? tipSec + firstTargetOffsetSec : 0,
        targetLastSlotSec:
          intervals > 0 && tipSec > 0 ? tipSec + lastTargetOffsetSec : 0,
        targetPrice:
          Number(targetRef.current) ||
          Number(predictionDataRef.current?.target_price) ||
          0,
        liveClose:
          rows.length > 0 ? rows[rows.length - 1].close : 0,
        signal: signalRef.current ?? predictionDataRef.current?.signal ?? null,
        confidence: Number(confPropRef.current ?? predictionDataRef.current?.confidence ?? 0),
        // PART 3 — 0.98 quality lock mirrors on the chart debug surface
        ...chartDebugQualityFields(
          predictionDataRef.current as QualityPredictDebug | null | undefined,
          rows.length,
        ),
        targetAlphaStart: 0.95,
        targetAlphaMin: 0.35,
        // PART 37 — the expiry marker is CANVAS-drawn, so the DOM cannot assert
        // it. Exposed on the same verification surface as everything else: the
        // bucket it resolved to, the media x it is painting at, and its label.
        // `expiryMarkerX` is the value a reader can compare against
        // `tipBucketSec + expirationSec` — the [318] assertion, live.
        expiryMarkerBucketSec: expiryMarkerRef.current?.markerBucketSec ?? 0,
        expiryMarkerX: expiryMarkerRef.current?.markerX() ?? null,
        expiryMarkerLabel: expiryMarkerRef.current?.markerLabel ?? "",
        projectionKey: projectionRef.current.currentKey,
        projectionAnchorClose: projectionRef.current.currentAnchor,
      });
    },
    [],
  );

  const updateTargetLayer = useCallback(
    (liveClose: number): void => {
      const series = targetSeriesRef.current;
      const bw = timeframeToMs(timeframeRef.current);
      const rows = dataRef.current;
      const tfSec = tfSecondsRef.current;
      const expSec = expSecondsRef.current;
      // PART 21 [135] — the target-candle gate reads the SAME currentSignalView
      // the HUD label renders: buffered direction AND tier from ONE buffer, so
      // candles can never render a different dispatch than the label shows
      // (pre-PART 21 both read separate copies of predictionDataRef).
      const view = currentSignalView();
      const signalValue = view.gatedSignal;
      const tierForGate = view.tier;
      const targetPriceRaw =
        Number(targetRef.current) ||
        Number(predictionDataRef.current?.target_price) ||
        0;
      const anchorPrice =
        Number(anchorRef.current) ||
        Number(predictionDataRef.current?.current_price) ||
        0;
      /*
       * BOUND THE TARGET AGAINST THE ANCHOR.
       *
       * The target series shares the candles' "right" price scale but opts out
       * of autoscale (`autoscaleInfoProvider: () => null`), so a target value
       * outside the tape's visible range is drawn off-axis and CLIPPED at the
       * top of the container — the reported "massive vertical spikes shooting up
       * to the top of the chart". The candles' own scale is never stretched,
       * which is exactly why the corruption was invisible to any autoscale check.
       *
       * A real intraday target does not sit many multiples of the price away
       * from the anchor, so a target beyond this band is a stale value from a
       * previous symbol, a unit error, or a malformed payload. Dropping it
       * renders no projection, which is honest; drawing it corrupts the chart.
       */
      const targetPrice = clampTargetToAnchor(targetPriceRaw, anchorPrice);
      const stopPrice =
        Number(
          (predictionDataRef.current as { stop_loss?: number } | null)
            ?.stop_loss,
        ) || 0;
      const dirColor =
        signalValue === "SELL"
          ? BEARISH
          : signalValue === "BUY"
            ? BULLISH
            : AXIS_TEXT;

      const tip = rows.length > 0 ? rows[rows.length - 1] : null;
      const tipGridMs =
        tip && tip.timestamp > 0 ? bucketStart(tip.timestamp, bw) : 0;
      const tipSec = tipGridMs > 0 ? Math.floor(tipGridMs / 1000) : 0;
      const intervals = targetIntervalsFor(expSec, tfSec);
      // PART 37 — positioned BEFORE the projection-suppression branch below, so
      // the boundary is anchored to the live tip even when the target series is
      // blanked. A time marker must not disappear because a price is missing.
      syncExpiryMarker(tipSec, tfSec, expSec);

      // ── SUPPRESSION: candles ALWAYS render when live tip + target exist ──
      // The 96.5% confidence gate ONLY affects the BUY/SELL label, never the
      // candle rendering. Suppress only when required data is genuinely
      // absent. Never anchor Date.now(); never gate on feedStatus/confidence.
      if (tipGridMs <= 0 || targetPrice <= 0) {
        lastTargetIntervalsRef.current = 0;
        if (projectionRef.current.currentKey !== "") {
          projectionRef.current.reset();
          if (series) {
            try { series.setData([]); } catch {}
          }
        }
        if (series) {
          try { series.setMarkers([]); } catch {}
        }
        setTargetLayerActive(false);
        syncMarkers(dirColor, null, 0, 0, 0, targetCandlesEnabled(tierForGate));
        syncChartDebug(rows, bw, tipSec, intervals, [], signalValue);
        return;
      }

      // Deterministic projection matrix: a structural key shift is the ONLY
      // trigger for a rebuild + repaint. Micro tick fluctuations within the
      // active bucket resolve to the same key → the exact same flame array
      // reference → no series mutation, no reflow, zero jank.
      const snap = projectionRef.current.present({
        liveTipBucketSec: tipSec,
        timeframeSec: tfSec,
        expirationSec: expSec,
        // REAL tape close — the truthful anchor. Never the HA display close.
        liveClose,
        // DISPLAYED close — where the overlay physically attaches to the last
        // rendered candle. The arc still terminates on the real target price,
        // so the TGT reads as continuous with the tape instead of jumping off
        // the smoothed HA body by the HA-vs-raw offset.
        visualAnchor: tip ? tip.close : 0,
        targetPrice,
        atr: Number(atrRef.current) || 0,
        signal: signalValue,
        // PART 21 [135] — engine tier gate: candles render T1–T3 ONLY off the
        // buffered view's tier (frozen with the direction, never a second raw
        // fetch of predictionDataRef). Closing the PART 20 drift.
        tier: tierForGate,
      });
      const shouldReanchor = targetViewportNeedsReanchor(
        lastTargetIntervalsRef.current,
        snap.intervals,
      );
      lastTargetIntervalsRef.current = snap.intervals;

      if (snap.changed) {
        if (series) {
          applyTargetStyle(series, signalValue);
          try { series.setData(targetData(snap.candles)); } catch {}
        }
        // PART 8 — "?" honesty marker above the wick for T3-only projected
        // candles. Rendered on the TARGET series so it cannot collide with the
        // main tape; cleared whenever the track (re)builds.
        if (series) {
          const markers = snap.candles
            .filter((c) => c.marker === "?")
            .map((c) => ({
              time: c.time as UTCTimestamp,
              position: "aboveBar" as const,
              shape: "circle" as const,
              color: dirColor,
              text: "?" as const,
              size: 1,
            }));
          try { series.setMarkers(markers); } catch {}
        }
        setTargetLayerActive(snap.candles.length > 0);
        if (snap.candles.length > 0 && shouldReanchor) {
          reanchor(rows.length, snap.intervals);
        }
        console.debug("[target]", {
          intervals: snap.intervals,
          firstSlot: snap.firstSlotSec,
          lastSlot: snap.lastSlotSec,
          targetPrice,
          anchorLiveClose: snap.anchorLiveClose,
          expirationSec: expSec,
          timeframeSec: tfSec,
          count: snap.candles.length,
          signal: signalValue,
          key: snap.key,
        });
        const last =
          snap.candles.length > 0
            ? snap.candles[snap.candles.length - 1]
            : null;
        syncMarkers(
          dirColor,
          last,
          targetPrice,
          anchorPrice,
          stopPrice,
          targetCandlesEnabled(tierForGate),
        );
        syncChartDebug(rows, bw, tipSec, intervals, snap.candles, signalValue);
      }
    },
    [reanchor, syncMarkers, syncChartDebug, syncExpiryMarker, currentSignalView],
    );

  useEffect(() => {
    const normTf = normalizeTimeframe(timeframe);
    if (normTf) {
      setAggregatorTimeframe(normTf);
    }
  }, [timeframe, setAggregatorTimeframe]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const digits = getPriceDigits(activeSymbol);
    const bw = timeframeToMs(tf);
    const priceFormat = {
      type: "price" as const,
      precision: digits,
      minMove: Math.pow(10, -digits),
    };
    // ── THEME-AWARE CANVAS COLORS ──
    // Resolved from the design-system tokens so the canvas flips with the
    // dark/light toggle. Candle bodies stay teal/coral in BOTH themes (brand
    // constant), only the surfaces/axes/grid adapt.
    const chartBg = cssVar("--tp-chart-bg", OBSIDIAN);
    const axisText = cssVar("--tp-axis-text", AXIS_TEXT);
    const gridLine = cssVar("--tp-grid", GRID_LINE);
    const chartBorder = cssVar("--tp-chart-border", BORDER);
    const crosshair = cssVar("--tp-crosshair", CROSSHAIR);
    const crosshairLabelBg = cssVar("--tp-elevated", "#171c28");
    const chart = createChart(el, {
      width: Math.max(el.clientWidth || 600, 100),
      height: Math.max(el.clientHeight || height, 120),
      autoSize: false,
      layout: {
        background: { type: ColorType.Solid, color: chartBg },
        textColor: axisText,
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: gridLine },
        horzLines: { color: gridLine },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: crosshairLabelBg,
        },
        horzLine: {
          color: crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: crosshairLabelBg,
        },
      },
      timeScale: {
        borderColor: chartBorder,
        timeVisible: true,
        secondsVisible: bw < 60_000,
        rightOffset: TARGET_RIGHT_GUTTER,
        barSpacing: INITIAL_BAR_SPACING_PX,
        minBarSpacing: MIN_BAR_SPACING_PX,
        fixLeftEdge: true,
        fixRightEdge: false,
        shiftVisibleRangeOnNewBar: true,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
      },
      rightPriceScale: {
        borderColor: chartBorder,
        borderVisible: true,
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      localization: {
        locale: "en-US",
        priceFormatter: (p: number) => p.toFixed(digits),
        timeFormatter: (time: BusinessDay | UTCTimestamp) => {
          if (typeof time === "number") {
            return formatAxisTime(time, bw);
          }
          const sec = Date.UTC(time.year, time.month - 1, time.day) / 1000;
          return formatAxisTime(sec, bw);
        },
      },
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: BULLISH,
      downColor: BEARISH,
      borderUpColor: BULLISH,
      borderDownColor: BEARISH,
      wickUpColor: BULLISH,
      wickDownColor: BEARISH,
      // MASTER MISSION part 5 — PO-style candles ALWAYS render body+wick
      wickVisible: true,
      borderVisible: true,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat,
    });
    const volume = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
    });
    volume
      .priceScale()
      // MASTER MISSION part 5.6 — volume strip owns the bottom 18% of the pane
      .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    // MASTER MISSION part 5.2 — re-assert the PO canvas contract explicitly
    // AFTER createChart so spacing/gutter can never silently drift to defaults.
    try {
      chart.timeScale().applyOptions({
        barSpacing: INITIAL_BAR_SPACING_PX,
        minBarSpacing: MIN_BAR_SPACING_PX,
        rightOffset: TARGET_RIGHT_GUTTER,
        fixLeftEdge: true,
        fixRightEdge: false,
        shiftVisibleRangeOnNewBar: true,
      });
    } catch {}
    const targetSeries = chart.addCandlestickSeries({
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
      priceFormat,
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeRef.current = volume;
    targetSeriesRef.current = targetSeries;
    // ── PART 37: attach the EXPIRY boundary to the CANDLE series ──
    // Created here (not at ref-init) because a primitive only gets its
    // `attached()` — and therefore its chart/timeScale handles — once a series
    // holds it. Attached to the CANDLES, which are added before the target
    // overlay, so the marker paints under the projection it annotates.
    const expiryMarker = new ExpiryTimeMarker(expiryMarkerTheme());
    expiryMarkerRef.current = expiryMarker;
    expiryMarkerThemeRef.current = expiryMarkerTheme();
    try {
      candleSeries.attachPrimitive(expiryMarker);
    } catch {
      expiryMarkerRef.current = null;
    }
    // ── DEBUG SURFACE BASELINE (zero-data parity) ──
    // `writeChartDebug` is otherwise only reachable through `updateTargetLayer`,
    // which requires at least one rendered candle. On a cold/offline start (no
    // seed bars yet) that never fires, so `window.__chartDebug` stayed
    // `undefined` and the verification surface produced no JSON. Always stamp a
    // baseline here so the object exists from mount onward; live data paths
    // merge the full snapshot over it.
    writeChartDebug({
      symbol: activeSymbol,
      timeframe: tf,
      bucketMs,
      candleCount: 0,
      barSpacing: INITIAL_BAR_SPACING_PX,
      chartWidth: el.clientWidth ?? 0,
      phase: "MOUNTED",
    });
    const projection = projectionRef.current;
    const signalHold = signalHoldRef.current;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            const w = el.clientWidth;
            const h = el.clientHeight || height;
            if (w > 0 && h > 0) {
              try {
                chart.applyOptions({ width: w, height: h });
              } catch {}
            }
          })
        : null;
    if (ro) ro.observe(el);
    return () => {
      if (ro) ro.disconnect();
      try {
        chart.remove();
      } catch {}
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeRef.current = null;
      targetSeriesRef.current = null;
      expiryMarkerRef.current = null;
      expiryMarkerThemeRef.current = null;
      rawRef.current = [];
      dataRef.current = [];
      rejectedCountRef.current = 0;
      linesRef.current = {};
      lastTargetIntervalsRef.current = 0;
      projection.reset();
      signalHold.reset();
    };
  }, [activeSymbol, height, tf, bucketMs, resolvedTheme]);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volume = volumeRef.current;
    if (!candleSeries) return;
    const bw = timeframeToMs(timeframeRef.current);
    const serverClosed =
      useTradingStore.getState().serverCandles[activeSymbolRef.current]?.[
        timeframeRef.current
      ] ?? ([] as GridCandle[]);

    /*
     * TIMEFRAME CORRECTNESS — never bucket-check foreign-resolution data.
     *
     * The selected timeframe changes immediately on click, but `data` is only
     * replaced when the new /predict resolves. In that window the props still
     * hold the PREVIOUS timeframe's bars, and `historyBarCheck` rejects any
     * timestamp that is not aligned to the NEW bucket (5m requires
     * `ts % 300000 === 0`, which no 1m bar satisfies). Every bar was therefore
     * dropped, `rows` came back empty, and the chart blanked until the fetch
     * landed — a resolution switch looked like a feed outage.
     *
     * So: if the data is not on the selected grid, PAINT NOTHING and wait. The
     * candles then render strictly per the selected timeframe, and never a
     * blend of two resolutions. The target layer is cleared for the same reason
     * — a projection anchored to the old grid is meaningless on the new one.
     */
    const dataAlignedToSelectedTf =
      serverClosed.length > 0 ||
      (dataPropRef.current ?? []).every((c) => {
        let ts = Number(c.timestamp);
        if (!Number.isFinite(ts) || ts <= 0) return false;
        if (ts < 1e12) ts *= 1000;
        return ts % bw === 0;
      });

    if (!dataAlignedToSelectedTf) {
      // Foreign-resolution payload in hand. Clear rather than mis-render, and
      // let the effect re-run when the correctly-resolved data arrives.
      rawRef.current = [];
      dataRef.current = [];
      rejectedCountRef.current = 0;
      applyCandleData(candleSeries, volume, []);
      targetStructuralKeyRef.current = "";
      lastTargetIntervalsRef.current = 0;
      try {
        targetSeriesRef.current?.setData([]);
      } catch {}
      firstTickRef.current = true;
      pendingPaintRef.current = false;
      setHasCandles(false);
      return;
    }

    const built = buildSeries(
      activeSymbolRef.current,
      bw,
      dataPropRef.current,
      serverClosed,
    );
    const rows = built.rows;
    rejectedCountRef.current = built.rejected;
    // RAW truth first, then its pure HA fold for painting.
    rawRef.current = built.raw;
    dataRef.current = rows;
    applyCandleData(candleSeries, volume, rows);
    // ── TARGET-LAYER ANCHOR (fix: no vanish on server candle close) ──
    // `swapKey` changes whenever serverCandleVersion / data.length / dataEpoch /
    // lead offset changes. Only the STRUCTURAL part (symbol/timeframe/data
    // epoch/lead) means the old target layer is meaningless for a different
    // grid — reset the projection engine + free the layer that time. A mere
    // server candle close must NOT call setData([]) here: updateTargetLayer
    // only repaints when `present()` returns changed, so an unconditional
    // clear on every version bump made the target overlay blink out at every
    // close (the anchor-vanish bug).
    const structuralKey = `SYM|${activeSymbolRef.current}|${tf}|${dataEpoch}|${
      selectedLeadOffsetMs ?? "auto"
    }`;
    const structuralChanged = targetStructuralKeyRef.current !== structuralKey;
    if (structuralChanged) {
      targetStructuralKeyRef.current = structuralKey;
      lastTargetIntervalsRef.current = targetIntervalsFor(
        expSecondsRef.current,
        tfSecondsRef.current,
      );
      projectionRef.current.reset();
      signalHoldRef.current.reset();
      try {
        targetSeriesRef.current?.setData([]);
      } catch {}
    }
    if (rows.length > 0) {
      // Anchor on the RAW close — never the HA display close.
      updateTargetLayer(rawAnchorClose(rawRef.current));
    } else {
      lastTargetIntervalsRef.current = 0;
      try {
        targetSeriesRef.current?.setData([]);
      } catch {}
    }
    firstTickRef.current = rows.length === 0;
    lastPaintedCountRef.current = rows.length;
    lastPaintedTipKeyRef.current = "";
    pendingPaintRef.current = false;
    const chart = chartRef.current;
    if (chart) {
      try {
        chart.applyOptions({
          grid: {
            vertLines: { color: rows.length > 0 ? GRID_LINE : "rgba(0,0,0,0)" },
            horzLines: { color: rows.length > 0 ? GRID_LINE : "rgba(0,0,0,0)" },
          },
        });
      } catch {}
    }
    setHasCandles(rows.length > 0);
    if (structuralChanged && rows.length > 0) {
      reanchor(
        rows.length,
        targetIntervalsFor(expSecondsRef.current, tfSecondsRef.current),
      );
    }
  }, [swapKey, updateTargetLayer, reanchor, effectiveSignal, feedStatus, tf, dataEpoch, selectedLeadOffsetMs]);

  useEffect(() => {
    if (dataRef.current.length > 0) {
      // Re-run the projection when the forecast inputs change, still anchored on
      // the RAW tape close so the TGT tracks the live feed.
      updateTargetLayer(rawAnchorClose(rawRef.current));
    }
  }, [
    expirationSeconds,
    tf,
    bucketMs,
    predictedTargetPrice,
    predictionAnchorPrice,
    atr,
    effSignal,
    currentPrice,
    liveCloseView,
    activeSymbol,
    swapKey,
    updateTargetLayer,
    effectiveSignal,
    feedStatus,
  ]);

  useEffect(() => {
    const anchorMs = Date.now();
    targetCountdownAnchorRef.current = anchorMs;
    setHudNowMs(anchorMs);
  }, [expSeconds]);

  useEffect(() => {
    const unsub = realtimeAggregator.subscribeLive((candle) => {
      const want = activeSymbolRef.current;
      const c = candle as GridCandle;
      const emitSymbol =
        typeof c.symbol === "string" ? c.symbol.trim().toUpperCase() : want;
      if (!want || emitSymbol !== want) return;
      const candleSeries = candleSeriesRef.current;
      if (!candleSeries) return;
      // ── RAW-ONLY MUTATION (the "giant spike" / mixed-axis fix) ──
      // The tick is a REAL broker candle. It is merged into `rawRef` and NEVER
      // into `dataRef`, which holds the Heikin-Ashi fold. Previously the raw
      // tick was spliced straight into the folded array, so the forming bar
      // rendered raw geometry beside HA bars — two encodings on one price axis —
      // and the target anchor flipped between raw and HA on every rebuild.
      const rawArr = rawRef.current;
      const result = mergeLiveTick(rawArr, c);
      if (result === "stale") return;
      // The display fold is re-derived by the rAF painter (once per frame), not
      // here — raw is the only array this handler is allowed to touch.
      // MASTER MISSION part 3 — a live tick only FLAGS a pending paint; the
      // unified rAF loop drains it once per frame, so a burst of N ticks in a
      // frame becomes ONE chart paint (no per-tick series rebuild, no per-tick
      // buildTargetCandles, no forced reflow inside a tick handler).
      pendingPaintRef.current = true;
      setHasCandles(rawArr.length > 0);
    });
    return unsub;
  }, [activeSymbol, swapKey]);

  // ── UNIFIED rAF PAINTER (MASTER MISSION part 3) ──
  // ONE requestAnimationFrame loop owns: (1) the coalesced candle/volume/target
  // paint (drained at most once per frame, so N ticks/frame == 1 paint), (2)
  // the now-divider coordinate (throttled to once per second), and (3) the HUD
  // clock (once per second). No setInterval, no per-tick series.update, no
  // forced reflow inside a tick handler — `timeToCoordinate` runs at most 1/s
  // here, never in the tick path.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let raf = 0;
    let lastDividerSecond = -1;
    let lastHudSecond = -1;
    const frame = () => {
      try {
        // ── (1) COALESCED CHART PAINT — drain pending ticks once per frame ──
        if (pendingPaintRef.current) {
          pendingPaintRef.current = false;
          const candleSeries = candleSeriesRef.current;
          // Re-derive the DISPLAY domain from RAW here, at most once per frame, so
          // a coalesced burst of N ticks costs ONE fold instead of N. `dataRef`
          // is rebuilt wholesale rather than patched, which is what keeps the
          // recursive HA chain continuous.
          //
          // PART 32[236] — `.raw`, not `.display`: the rendered tape shares ONE
          // price domain with the TGT/ANC/LIVE lines and the TGT badge. See the
          // RAW/DISPLAY contract in realtimeCandleAggregator.ts.
          dataRef.current = syncRawDisplay(rawRef.current).raw as GridCandle[];
          const arr = dataRef.current;
          const count = arr.length;
          if (candleSeries && count > 0) {
            // ── FRAME CACHE (quick-fix part 2) — a coalesced burst of ticks
            // that resolves to the SAME row set MUST NOT re-paint. Compare the
            // forming-candle fingerprint + row count against the last frame we
            // drew and skip the whole repaint (series update calls + the
            // target-layer projection + markers + grid applyOptions) when
            // nothing actually moved. setData is reserved for the one-time full
            // rebuild after a swap; steady-state paints touch only the live
            // forming candle and the target tip.
            const tip = arr[count - 1];
            const tipKey = `${tip.timestamp}|${tip.open}|${tip.high}|${tip.low}|${tip.close}|${tip.volume}`;
            const unchangedFrame =
              count === lastPaintedCountRef.current &&
              tipKey === lastPaintedTipKeyRef.current;
            if (!unchangedFrame) {
              const volume = volumeRef.current;
              // PART 11 — bar tint MUST follow the BUFFERED signal — the same
              // `effectiveSignal()` the HUD label renders — never a second RAW
              // read of predictionDataRef. Two store writers (REST /predict +
              // WS applyLiveSignal, different cadences) flip the raw field at
              // will; the unbuffered paint read made bars shimmer color while
              // the label was frozen (the production "HUD flicker").
              const bufferedSignal = effectiveSignal();
              const colorBar = (base: CandlestickData, row: GridCandle) =>
                barTintForBufferedSignal(
                  base,
                  row.isGap === true,
                  bufferedSignal,
                  GAP_CANDLE,
                  BULLISH,
                  BEARISH,
                );
              if (firstTickRef.current) {
                candleSeries.setData(candleData(arr));
                volume?.setData(volumeData(arr));
                firstTickRef.current = false;
              } else {
                // Append/refresh every row that changed since the last paint
                // (newly closed bars + the forming bar), then refresh the live
                // forming candle — coalesces any number of ticks into ONE paint
                // of the NEW rows only. The frame cache above guarantees we get
                // here only when at least one row actually moved.
                const from = Math.max(0, lastPaintedCountRef.current);
                for (let i = from; i < count; i++) {
                  candleSeries.update(colorBar(candleRow(arr[i]), arr[i]));
                  volume?.update(volumeRow(arr[i]));
                }
                candleSeries.update(
                  colorBar(candleRow(arr[count - 1]), arr[count - 1]),
                );
                volume?.update(volumeRow(arr[count - 1]));
              }
              lastPaintedCountRef.current = count;
              lastPaintedTipKeyRef.current = tipKey;
              const chart = chartRef.current;
              if (chart && arr.length > 0) {
                chart.applyOptions({
                  grid: {
                    vertLines: { color: GRID_LINE },
                    horzLines: { color: GRID_LINE },
                  },
                });
              }
              if (count > 0) {
                // Anchor the projection on the RAW tape close.
                updateTargetLayer(rawAnchorClose(rawRef.current));
              }
            }
          } else {
            firstTickRef.current = true;
          }
        }
        // ── (2) + (3) DIVIDER + HUD CLOCK — at most once per second ──
        const now = Date.now();
        const sec = Math.floor(now / 1000);
        if (sec !== lastDividerSecond) {
          lastDividerSecond = sec;
          const chart = chartRef.current;
          if (chart && feedStatusRef.current === "live" && hasCandlesRef.current) {
            const coordinate = chart
              .timeScale()
              .timeToCoordinate(sec as UTCTimestamp);
            setCurrentDividerX(typeof coordinate === "number" ? coordinate : null);
          } else {
            setCurrentDividerX(null);
          }
        }
        if (sec !== lastHudSecond) {
          lastHudSecond = sec;
          setHudNowMs(now);
        }
      } catch {}
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [updateTargetLayer, effectiveSignal]);

  const targetCandleCount = targetIntervalsFor(expSeconds, tfSeconds);

  const hudPred = predictionDataRef.current;
  const hudTarget =
    Number(hudPred?.target_price) > 0
      ? Number(hudPred.target_price)
      : Number(targetRef.current) || 0;
  const hudConf = Number(hudPred?.confidence);
  const hudBooks = hudPred?.book_agreement_detail ?? null;
  // The 96.5% confidence gate IMMUTABLY controls this label (stabilized, so
  // confidence jitter can never shimmer it) — completely isolated from the
  // target-candle rendering which runs off the projection matrix.
  // PART 24 [158] — the HUD consumes ONE SignalHoldView per render (identical
  // call count to the pre-PART 24 effectiveSignal()); direction is hudView.
  // gatedSignal and every target-adjacent card reads hudView.tier through
  // hudZone, so the TGT / TARGET CANDLES / EXPIRY cards can never disagree
  // with the candle shape's own tier gate.
  const hudView = currentSignalView();
  const hudSignal = hudView.gatedSignal;
  const hudTargetCandles = targetCandlesLabelFor(hudView, targetCandleCount);
  const hudZone = hudTargetCandles.enabled;
  const hudDigits = getPriceDigits(activeSymbol);
  const hudLive = Number(currentPriceRef.current) || 0;
  const hudDeltaPct =
    hudTarget > 0 && hudLive > 0 ? ((hudTarget - hudLive) / hudLive) * 100 : 0;
  const hudCountdownSeconds = expiryCountdownRemainingSeconds(
    hudNowMs,
    targetCountdownAnchorRef.current,
    expSeconds,
  );
  const hudCountdown =
    expSeconds > 0
      ? `${String(Math.floor(hudCountdownSeconds / 60)).padStart(
          2,
          "0",
        )}:${String(hudCountdownSeconds % 60).padStart(2, "0")}`
      : null;
  const hudSignalColor =
    hudSignal === "BUY" ? BULLISH : hudSignal === "SELL" ? BEARISH : AXIS_TEXT;
  // PART 9/14 — why the signal display is held/suppressed: "too_late" (engine
  // demoted the emission — not enough real time to act), "regime_scored_only"
  // (PART 14 random_walk symbol — never tradable) or "frozen" (a fresh
  // contradictory candidate withheld by the stability freeze window).
  // The UI shows the reason instead of silently going blank.
  const hudSuppressReason = signalHoldRef.current.reason;

  return (
    <div
      className="relative w-full h-[320px] xl:h-full min-h-0 rounded-xl overflow-hidden border bg-[var(--tp-chart-bg)] border-[var(--tp-border)] transition-colors duration-150"
    >
      {/* Publishes the SAME view the HUD above rendered — one evaluate, one
          truth, so the CoherenceStrip cannot show a different signal. */}
      <SignalViewPublisher view={hudView} />
      <div ref={containerRef} className="absolute inset-0" />

      {/* ── CURRENT TIME (LIVE) DIVIDER ── the neon boundary between the real
          historical tape (left) and the Future Prediction Zone (right). Pinned
          to the wall clock; only valid once the live stream is flowing. */}
      {currentDividerX !== null ? (
        <div
          className="pointer-events-none absolute inset-y-0 z-10 border-l border-emerald-300/80 shadow-[0_0_12px_rgba(0,245,160,0.7)]"
          style={{ left: currentDividerX }}
        >
          <span className="absolute left-1 top-2 whitespace-nowrap rounded border border-emerald-300/40 bg-obsidian/90 px-1.5 py-1 font-mono text-[9px] font-black uppercase tracking-widest text-emerald-200">
            CURRENT TIME (LIVE)
          </span>
        </div>
      ) : null}

      {/* LIVE FORMING BADGE — signals that the rightmost bar is the active
          candle accumulating ticks in real-time, not a static history bar.
          When the stream stalls / the feed is desynced the badge flips to an
          amber AWAITING indicator — never fabricated bars. */}
      {hasCandles && !feedOffline && !feedWaiting && !streamStalled && !stalePrice && (
        <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5">
          <AssetClassBadge symbol={activeSymbol} />
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[9px] font-mono text-emerald-400 uppercase tracking-widest font-black">
            LIVE - {tf}
          </span>
          {targetDurationMin > 1 ? (
            <span className="text-[9px] font-mono text-sky-400 uppercase tracking-widest font-bold bg-sky-500/10 border border-sky-500/20 rounded px-1.5 py-0.5">
              LOOKAHEAD {targetDurationMin}m
            </span>
          ) : null}
        </div>
      )}

      {/* STALE PRICE BADGE — the last price packet is >2s old. Warn instead of
          pretending the frozen price is live. */}
      {hasCandles && !feedOffline && !feedWaiting && !streamStalled && stalePrice && (
        <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5">
          <AssetClassBadge symbol={activeSymbol} />
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-[9px] font-mono text-amber-400 uppercase tracking-widest font-black">
            STALE PRICE - {tf}
          </span>
        </div>
      )}

      {/* AWAITING / STALLED BADGE — real data present but the forming bar is
          frozen awaiting a valid tick. */}
      {!feedOffline && hasCandles && (feedWaiting || streamStalled) && (
        <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5">
          <AssetClassBadge symbol={activeSymbol} />
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-[9px] font-mono text-amber-400 uppercase tracking-widest font-black">
            {feedWaiting
              ? "AWAITING LIVE FEED / CONNECTING..."
              : "WAITING FOR LIVE STREAM..."}
          </span>
        </div>
      )}

      {!feedOffline && hasCandles && (feedWaiting || streamStalled) && (
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-2">
          <p className="text-[9px] font-mono text-amber-400/80 uppercase tracking-widest bg-black/40 px-2 py-1 rounded backdrop-blur-sm">
            {feedWaiting
              ? "Live feed synchronising — awaiting a valid tick (no fake prices)"
              : "Live feed paused — resuming on next tick"}
          </p>
        </div>
      )}

      {/* FEED-OFFLINE OVERLAY */}
      {feedOffline ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-rose-300">
            {feedStatus === "auth_failed"
              ? "FEED OFFLINE — auth failed"
              : "FEED OFFLINE — awaiting SSID"}
          </span>
        </div>
      ) : !hasCandles ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <div className="w-8 h-8 rounded-full border-2 border-slate-600/60 border-t-blue-400 animate-spin" />
          <p className="text-xs font-mono text-slate-400 uppercase tracking-widest">
            {t("awaitingLiveMarketData")}
          </p>
          <p className="text-[10px] font-mono text-slate-500">
            {getPairLabel(activeSymbol)} - {t("candlesRenderRealtime")}
          </p>
        </div>
      ) : null}

      {/* PARITY-BREACH DIAGNOSTIC — falling raw ticks without bucket writes. */}
      {hasCandles && candleParityBreach ? (
        <div
          className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1.5"
          title={`Falling raw ticks without bucket writes (${candleParityBreach.tickCount} ticks / ${candleParityBreach.bucketWrites} writes). Validating the aggregation pipeline — the local bar may lag while this is active.`}
        >
          <span className="text-[9px] font-mono text-rose-300 uppercase tracking-widest font-black bg-rose-500/10 border border-rose-500/40 rounded px-1.5 py-0.5">
            PARITY BREACH
          </span>
        </div>
      ) : null}

      {/* PART 8 — PERSISTENT TARGET-CANDLE LEGEND. Always visible while ANY
          target candle is drawn; deliberately NOT a settings toggle so the
          projection can never be mistaken for confirmed price action. */}
      {targetLayerActive ? (
        <div className="pointer-events-none absolute bottom-2 left-2 z-10">
          <span className="text-[9px] font-mono text-slate-300 uppercase tracking-widest font-bold bg-obsidian/85 border border-slate-500/40 rounded px-1.5 py-0.5">
            Target = projection, not a confirmed price
          </span>
        </div>
      ) : null}

      {/* PREDICTION HUD — floating micro-cards above the Future Prediction
          Zone: book-agreement % with exact n/n books aligned, exact target
          price with live delta, the exact target-candle count & chart
          timeframe (always shown once candles exist), and the countdown to
          target expiry aligned to PO candle closures. */}
      {hasCandles && !feedOffline ? (
        <div className="pointer-events-none absolute top-10 right-2 z-10 flex flex-col items-end gap-1">
          {hudSignal != null || (Number.isFinite(hudConf) && hudConf > 0) ? (
            <div
              className="flex items-center gap-2 rounded-md border border-white/10 bg-obsidian/85 backdrop-blur-sm px-2 py-1"
              style={{ boxShadow: `0 0 14px ${hudSignalColor}33` }}
            >
              <span
                className="text-[10px] font-mono font-black uppercase tracking-widest"
                style={{ color: hudSignalColor }}
              >
                {hudSignal ?? "MARKET WAIT"}
              </span>
              {Number.isFinite(hudConf) && hudConf > 0 ? (
                <span className="font-mono text-[10px] font-bold tabular-nums text-slate-200">
                  {hudConf.toFixed(1)}%
                  {hudBooks && hudBooks.active_count
                    ? ` (${hudBooks.aligned_count}/${hudBooks.active_count})`
                    : ""}
                </span>
              ) : null}
            </div>
          ) : null}
          {/* PART 9 — SUPPRESSION HUD. Shown only when the stability/engine
              gate actually suppressed the display, so the user sees WHY the
              label didn't flip instead of a silent blank. */}
          {hudSuppressReason ? (
            <div className="flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-500/10 backdrop-blur-sm px-2 py-1 font-mono text-[9px] uppercase tracking-widest">
              {hudSuppressReason === "too_late" ? (
                <span className="font-black text-amber-300">
                  TOO LATE TO ACT
                </span>
              ) : hudSuppressReason === "regime_scored_only" ? (
                <span className="font-black text-violet-300">
                  SCORED-ONLY — RANDOM WALK
                </span>
              ) : (
                <span className="font-bold text-slate-300">
                  FROZEN — STABILITY HOLD
                </span>
              )}
            </div>
          ) : null}
          {hudZone && hudTarget > 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-white/10 bg-obsidian/85 backdrop-blur-sm px-2 py-1 font-mono text-[10px]">
              <span className="uppercase tracking-widest text-slate-400">TGT</span>
              <span className="font-bold tabular-nums text-slate-200">
                {hudTarget.toFixed(hudDigits)}
              </span>
              {hudLive > 0 ? (
                <span
                  className={`font-bold tabular-nums ${
                    hudDeltaPct >= 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {hudDeltaPct >= 0 ? "+" : ""}
                  {hudDeltaPct.toFixed(3)}%
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center gap-2 rounded-md border border-sky-500/25 bg-obsidian/85 backdrop-blur-sm px-2 py-1 font-mono text-[10px]">
            <span className="uppercase tracking-widest text-slate-400">TIME</span>
            <span className="font-bold tabular-nums text-slate-200">{tf}</span>
          </div>
          {formatTargetCandlesLabel(hudTargetCandles) !== null ? (
            <div className="flex items-center gap-2 rounded-md border border-sky-500/25 bg-obsidian/85 backdrop-blur-sm px-2 py-1 font-mono text-[10px]">
              <span className="uppercase tracking-widest text-slate-400">
                TARGET CANDLES
              </span>
              <span className="font-black tabular-nums text-sky-300">
                {formatTargetCandlesLabel(hudTargetCandles)}
              </span>
            </div>
          ) : null}
          {hudZone && hudCountdown ? (
            <div className="flex items-center gap-2 rounded-md border border-white/10 bg-obsidian/85 backdrop-blur-sm px-2 py-1 font-mono text-[10px]">
              <span className="uppercase tracking-widest text-slate-400">EXPIRY</span>
              <span className="font-black tabular-nums text-sky-300">{hudCountdown}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* PREDICTIVE LEAD-TIME OFFSET SELECTOR — AUTO (default) = exact PO
          parity on the backend floor grid; explicit 20s / 1m lead projects the
          grid that far ahead instead. Persists via the store. */}
      {hasCandles ? (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10">
          <span className="text-[9px] font-mono text-sky-400 uppercase tracking-widest font-bold bg-sky-500/10 border border-sky-500/20 rounded px-1.5 py-0.5">
            LEAD
          </span>
          {LEAD_OFFSET_OPTIONS.map((opt) => {
            const active =
              (selectedLeadOffsetMs ?? null) === (opt.value ?? null);
            return (
              <button
                key={opt.label}
                type="button"
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
            type="button"
            onClick={() => hardResetLiveData()}
            className="text-[9px] font-mono uppercase tracking-widest font-bold rounded px-1.5 py-0.5 transition-colors bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:text-rose-200 hover:border-rose-400/50"
            title="Clear all caches and re-initialize the live feed from the broker's tick ring"
          >
            RESET FEED
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default FinancialChart;
