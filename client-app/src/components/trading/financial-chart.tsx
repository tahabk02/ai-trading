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
  buildSignalView,
  targetViewportRange,
  timeframeToSeconds,
  TARGET_RIGHT_GUTTER,
  INITIAL_BAR_SPACING_PX,
  MIN_BAR_SPACING_PX,
  SIGNAL_CONFIDENCE_THRESHOLD,
  TargetProjectionEngine,
  SignalHoldBuffer,
  type AggregatorDebug,
  type Candle,
  type TargetCandleData,
} from "@/lib/realtimeCandleAggregator";
import { barTintForBufferedSignal } from "@/lib/signalRender";
import { getPairLabel, getPriceDigits } from "@/constants/symbols";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";
import {
  chartDebugQualityFields,
  type QualityPredictDebug,
} from "@/lib/chartDebug";

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
): { rows: GridCandle[]; rejected: number } {
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
    byTs.set(slot, r);
  }
// Intra-frame builder output: the client aggregator paints ONLY the current
  // forming bar here. Its locally-closed rows are used as a fallback ONLY when
  // the server has no candle for that bucket (non-server timeframes, or before
  // the first server close).
  const aggregated = realtimeAggregator.getSeries(symbol) as GridCandle[];
  for (const r of aggregated) {
    if (r.isGap === true) continue;
    const slot = Number(r.timestamp);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    if (r.isFinal === true && byTs.has(slot)) continue;
    byTs.set(slot, r as GridCandle);
  }
  const out: GridCandle[] = [];
  for (const r of [...byTs.values()].sort(
    (a, b) => a.timestamp - b.timestamp,
  )) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev && r.timestamp <= prev.timestamp) continue;
    out.push(r);
  }
  return { rows: out, rejected };
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
  const dataRef = useRef<GridCandle[]>([]);
  const linesRef = useRef<ChartLineBag>({});
  const targetSlotKeyRef = useRef("");
  const targetStructuralKeyRef = useRef("");
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
  const [hasCandles, setHasCandles] = useState(false);
  const [targetLayerActive, setTargetLayerActive] = useState(false);
  const [currentDividerX, setCurrentDividerX] = useState<number | null>(null);
  const [lookaheadHorizon, setLookaheadHorizon] = useState<number>(
    Math.max(1, Math.round(expSeconds / tfSeconds)),
  );
  const [hudNowMs, setHudNowMs] = useState<number>(() => Date.now());

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
  atrRef.current = atr;
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
    (dataRef.current.length > 0
      ? dataRef.current[dataRef.current.length - 1].close
      : 0) ||
    Number(currentPrice) ||
    0;
  const feedOffline =
    feedStatus === "awaiting_ssid" || feedStatus === "auth_failed";
  const feedWaiting = feedStatus === "stalled" || feedStatus === "degraded";

  const swapKey = `${activeSymbol}|${tf}|${dataEpoch}|${
    selectedLeadOffsetMs ?? "auto"
  }|${data.length}|${serverCandleVersion}`;

  const effectiveSignal = useCallback((): "BUY" | "SELL" | null => {
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
    return signalHoldRef.current.evaluate(
      rawGated,
      wallSec,
      tfSec,
      engineSuppress,
      // PART 11 — REAL elapsed clock for the neutral-clears hysteresis.
      // wallSec is the broker-grid bucket floor (constant between prints), so
      // without this the "sustained neutral" was measured in consecutive
      // render frames — milliseconds apart — and a 2-frame null at the
      // freeze-release instant blanked the label on every bucket rollover.
      Date.now(),
    );
  }, []);

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
    ): void => {
      const series = candleSeriesRef.current;
      if (!series) return;
      const bag = linesRef.current;
      const live = Number(currentPriceRef.current);
      // ── PROJECTION PRICE LINES on the MAIN series ──
      // TGT dashed teal, ANC dotted gray, STOP dashed coral (if provided);
      // last projected target candle renders T-HI / T-LO. All instances are
      // reused in `bag` (removed via setPriceLine when price <= 0), so the
      // overlay never leaks duplicate line objects across re-renders.
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
        projectionSlot0OffsetMs: bw,
        expirationSeconds: expSecondsRef.current,
        timeframeSeconds: tfSecondsRef.current,
        intervals,
        liveTipBucketSec: tipSec,
        firstTargetBucketSec: intervals > 0 && tipSec > 0 ? tipSec + bws : 0,
        firstTargetOffsetSec: bws,
        lastTargetBucketSec:
          intervals > 0 && tipSec > 0 ? tipSec + intervals * bws : 0,
        lastTargetOffsetSec: intervals * bws,
        targetDirection: signalValue,
        targetFirstClose: frame.length > 0 ? frame[0].close : 0,
        targetLastClose: frame.length > 0 ? frame[frame.length - 1].close : 0,
        targetHigh,
        targetLow,
        lookaheadHorizon: Math.max(
          1,
          Math.round(expSecondsRef.current / tfSecondsRef.current),
        ),
        // PART 8 — explicit verification surface (exact window.__chartDebug keys)
        mergedCandles: rows.length,
        targetIntervals: intervals,
        targetFirstSlot: intervals > 0 && tipSec > 0 ? tipSec + bws : 0,
        targetLastSlot:
          intervals > 0 && tipSec > 0 ? tipSec + intervals * bws : 0,
        targetCount: frame.length,
        barSpacing: chartRef.current?.timeScale().options().barSpacing ?? 0,
        chartWidth: containerRef.current?.clientWidth ?? 0,
        feedStatus: feedStatusRef.current,
        gatedSignal: signalValue,
        // [4] — debug keys per quick-fix spec
        timeframeSec: tfSecondsRef.current,
        expirationSec: expSecondsRef.current,
        targetFirstSlotSec: intervals > 0 && tipSec > 0 ? tipSec + bws : 0,
        targetLastSlotSec:
          intervals > 0 && tipSec > 0 ? tipSec + intervals * bws : 0,
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
        projectionKey: projectionRef.current.currentKey,
        projectionAnchorClose: projectionRef.current.currentAnchor,
      });
    },
    [],
  );

  const updateTargetLayer = useCallback(
    (signalValue: "BUY" | "SELL" | null, liveClose: number): void => {
      const series = targetSeriesRef.current;
      const bw = timeframeToMs(timeframeRef.current);
      const rows = dataRef.current;
      const tfSec = tfSecondsRef.current;
      const expSec = expSecondsRef.current;
      const targetPrice =
        Number(targetRef.current) ||
        Number(predictionDataRef.current?.target_price) ||
        0;
      const anchorPrice =
        Number(anchorRef.current) ||
        Number(predictionDataRef.current?.current_price) ||
        0;
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

      // ── SUPPRESSION: candles ALWAYS render when live tip + target exist ──
      // The 96.5% confidence gate ONLY affects the BUY/SELL label, never the
      // candle rendering. Suppress only when required data is genuinely
      // absent. Never anchor Date.now(); never gate on feedStatus/confidence.
      if (tipGridMs <= 0 || targetPrice <= 0) {
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
        syncMarkers(dirColor, null, 0, 0, 0);
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
        liveClose,
        targetPrice,
        atr: Number(atrRef.current) || 0,
        signal: signalValue,
        // PART 6 — engine tier gate: target candles render T1–T3 only.
        tier: predictionDataRef.current?.tier ?? undefined,
      });

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
        if (snap.candles.length > 0) reanchor(rows.length, snap.intervals);
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
        syncMarkers(dirColor, last, targetPrice, anchorPrice, stopPrice);
        syncChartDebug(rows, bw, tipSec, intervals, snap.candles, signalValue);
      }
    },
    [reanchor, syncMarkers, syncChartDebug],
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
      dataRef.current = [];
      rejectedCountRef.current = 0;
      linesRef.current = {};
      targetSlotKeyRef.current = "";
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
    const built = buildSeries(
      activeSymbolRef.current,
      bw,
      dataPropRef.current,
      serverClosed,
    );
    const rows = built.rows;
    rejectedCountRef.current = built.rejected;
    dataRef.current = rows;
    applyCandleData(candleSeries, volume, rows);
    targetSlotKeyRef.current = "";
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
    if (targetStructuralKeyRef.current !== structuralKey) {
      targetStructuralKeyRef.current = structuralKey;
      projectionRef.current.reset();
      signalHoldRef.current.reset();
      try {
        targetSeriesRef.current?.setData([]);
      } catch {}
    }
    if (rows.length > 0) {
      updateTargetLayer(effectiveSignal(), rows[rows.length - 1].close);
    } else {
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
    reanchor(
      rows.length,
      targetIntervalsFor(expSecondsRef.current, tfSecondsRef.current),
    );
  }, [swapKey, updateTargetLayer, reanchor, effectiveSignal, feedStatus, tf, dataEpoch, selectedLeadOffsetMs]);

  useEffect(() => {
    if (dataRef.current.length > 0) {
      updateTargetLayer(
        effectiveSignal(),
        dataRef.current[dataRef.current.length - 1].close,
      );
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
    lookaheadHorizon,
    activeSymbol,
    swapKey,
    updateTargetLayer,
    effectiveSignal,
    feedStatus,
  ]);

  useEffect(() => {
    setLookaheadHorizon(Math.max(1, Math.round(expSeconds / tfSeconds)));
  }, [expSeconds, tfSeconds, setLookaheadHorizon]);

  useEffect(() => {
    const unsub = realtimeAggregator.subscribeLive((candle) => {
      const want = activeSymbolRef.current;
      const c = candle as GridCandle;
      const emitSymbol =
        typeof c.symbol === "string" ? c.symbol.trim().toUpperCase() : want;
      if (!want || emitSymbol !== want) return;
      const candleSeries = candleSeriesRef.current;
      if (!candleSeries) return;
      const arr = dataRef.current;
      const result = mergeLiveTick(arr, c);
      if (result === "stale") return;
      // MASTER MISSION part 3 — a live tick only FLAGS a pending paint; the
      // unified rAF loop drains it once per frame, so a burst of N ticks in a
      // frame becomes ONE chart paint (no per-tick series rebuild, no per-tick
      // buildTargetCandles, no forced reflow inside a tick handler).
      pendingPaintRef.current = true;
      setHasCandles(arr.length > 0);
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
                updateTargetLayer(effectiveSignal(), arr[count - 1].close);
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
  // The 96.5% confidence gate IMMUTABLY controls this label (stabilized, so
  // confidence jitter can never shimmer it) — completely isolated from the
  // target-candle rendering which runs off the projection matrix.
  const hudSignal = effectiveSignal();
  const hudDigits = getPriceDigits(activeSymbol);
  const hudLive = Number(currentPriceRef.current) || 0;
  const hudDeltaPct =
    hudTarget > 0 && hudLive > 0 ? ((hudTarget - hudLive) / hudLive) * 100 : 0;
  const hudFrame =
    Array.isArray(hudPred?.future_candles) &&
    hudPred.future_candles.length > 0
      ? (hudPred.future_candles as Array<{ timestamp?: number }>)
      : [];
  const hudExpiryTs =
    hudFrame.length > 0
      ? Number(hudFrame[hudFrame.length - 1].timestamp) || 0
      : 0;
  const hudRemainingMs = hudExpiryTs > 0 ? hudExpiryTs - hudNowMs : 0;
  const hudCountdown =
    hudExpiryTs > 0
      ? `${String(Math.max(0, Math.floor(hudRemainingMs / 60000))).padStart(
          2,
          "0",
        )}:${String(
          Math.max(0, Math.floor((hudRemainingMs % 60000) / 1000)),
        ).padStart(2, "0")}`
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
      className="relative w-full h-[calc(100vh-320px)] min-h-[500px] rounded-xl overflow-hidden border bg-[var(--tp-chart-bg)] border-[var(--tp-border)] transition-colors duration-150"
    >
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
          {lookaheadHorizon != null && lookaheadHorizon > 1 ? (
            <span className="text-[9px] font-mono text-sky-400 uppercase tracking-widest font-bold bg-sky-500/10 border border-sky-500/20 rounded px-1.5 py-0.5">
              LOOKAHEAD {lookaheadHorizon}m
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
          Zone: AI confidence %, exact target price with live delta, the exact
          target-candle count & chart timeframe (always shown once candles
          exist), and the countdown to target expiry aligned to PO candle
          closures. */}
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
          {hudTarget > 0 ? (
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
          <div className="flex items-center gap-2 rounded-md border border-sky-500/25 bg-obsidian/85 backdrop-blur-sm px-2 py-1 font-mono text-[10px]">
            <span className="uppercase tracking-widest text-slate-400">
              TARGET CANDLES
            </span>
            <span className="font-black tabular-nums text-sky-300">
              {targetCandleCount} candles
            </span>
          </div>
          {hudCountdown ? (
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
