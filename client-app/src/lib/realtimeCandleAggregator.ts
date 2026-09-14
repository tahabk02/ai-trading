/**
 * realtimeCandleAggregator.ts — REAL-TIME OHLCV AGGREGATION (Wall-Clock Synchronized)
 *
 * 100% REAL DATA. ZERO TIME DRIFT. WALL-CLOCK ANCHORED. PREDICTIVE LEAD.
 *
 * Built for TradingView Lightweight Charts v4 live-update semantics:
 *
 *   • MICRO→MACRO TIMEFRAME GRID: the same interval matrix as the POCKET-
 *     BRIDGE aggregation engine (20ms micro-ticks, 100ms, 1s, 20s, then
 *     1m/2m/3m/5m and every coarser standard timeframe). A chart observing a
 *     bridge that emits at `candles 20ms` stays exactly aligned with the
 *     candle boundary (`floor(ts/bucketMs)*bucketMs`), however the bridge is
 *     configured — no interval skew between the client grid and the backend
 *     aggregation.
 *   • AUTONOMOUS PAIR INDEX: every registered currency pair is bucketed by the
 *     local wall-clock engine from the first frame (registerSymbols) — the
 *     live bar opens on the exact timeframe boundary the moment a real price
 *     exists, with zero dependency on external-feed confirmation.
 *   • EXPLICIT LIFECYCLE STATE MACHINE per pair:
 *       IDLE → SYNTHETIC (wall-clock open) → LIVE (real ticks) → CLOSED.
 *   • Every tick and time bucket folds into the bucket whose aligned open time
 *     equals `floor(timeMs / bucketMs) * bucketMs` — the EXACT SAME floor grid
 *     the pocket-bridge backend computes from its PO-aligned epoch. 100% rollover
 *     parity: the live candle occupies the identical bucket slot as the backend's.
 *   • PREDICTIVE LEAD (default 0 = exact PO floor grid): `leadMs = leadTimeOffsetOverride
 *     ?? 0`. When an explicit lead (20s / 1m) is configured, the wall-clock is
 *     instead advanced by exactly that offset so candle boundaries close that
 *     much before the external platform's boundary. Exact expiry geometry
 *     (bucket open/close, countdown, progress) is exposed via
 *     boundaryGeometry()/getBoundary() on the same clock as the buckets.
 *   • SELF-DRIVING PROJECTOR: the aggregator recomputes + broadcasts the active
 *     pair's leading projection on its own cadence (PROJECTION_DRIFT_MS) as a
 *     forward-looking target buffer — the chart drifts toward expiry even when
 *     the tape is silent, cached per frame (PROJECTION_CACHE_MS) for zero bloat.
 *   • When time rolls from bucket T to T+1 (e.g. crossing second 00 of the minute),
 *     the aggregator automatically finalises bucket T, fires `onCandleClose`, and opens
 *     a new live candle at T+1 using the last known market price (flat-line continuity)
 *     even if a new tick has not arrived yet.
 *   • When the next real tick arrives, it morphs the live candle in place.
 *   • Strictly monotonic, synchronized to system wall-clock time with predictive lead.
 */

// ── PO-Canonical Timeframe Contract ──
// Pocket Option uses a specific set of chart intervals. We use uppercase
// canonical keys (M1, H1, D1) matching PO's internal naming convention.

export type Timeframe =
  | "S5" | "S10" | "S15" | "S30"
  | "M1" | "M2" | "M3" | "M5" | "M10" | "M15" | "M30"
  | "H1" | "H4" | "D1";

/** Bucket width in milliseconds — PO canonical intervals. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "S5": 5_000,
  "S10": 10_000,
  "S15": 15_000,
  "S30": 30_000,
  "M1": 60_000,
  "M2": 120_000,
  "M3": 180_000,
  "M5": 300_000,
  "M10": 600_000,
  "M15": 900_000,
  "M30": 1_800_000,
  "H1": 3_600_000,
  "H4": 14_400_000,
  "D1": 86_400_000,
};

export const SUPPORTED_TIMEFRAMES = Object.keys(TIMEFRAME_MS) as Timeframe[];

/** Alias map: reverse-numeric ("1H"→"H1", "5m"→"M5", etc.) resolved at init. */
const ALIAS_MAP: Record<string, Timeframe> = {};
for (const key of SUPPORTED_TIMEFRAMES) {
  const num = key.match(/^([A-Z])(\d+)$/);  // H1 → ["H1","H","1"]
  if (num) ALIAS_MAP[`${num[2]}${num[1].toLowerCase()}`] = key as Timeframe;
  ALIAS_MAP[key.toLowerCase()] = key as Timeframe;          // h1 → H1
}

/** Case-insensitive check: "m1", "M1", "1h", "1H", "H1" all resolve. */
export function isTimeframe(value: string): value is Timeframe {
  const raw = (value || "").trim();
  if (raw in ALIAS_MAP) return true;
  const lower = raw.toLowerCase();
  if (lower in ALIAS_MAP) return true;
  return Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, raw.toUpperCase());
}

/** Case-insensitive resolution to canonical PO timeframe. */
export function normalizeTimeframe(value: string): Timeframe | null {
  const raw = (value || "").trim();
  if (raw in ALIAS_MAP) return ALIAS_MAP[raw];
  const lower = raw.toLowerCase();
  if (lower in ALIAS_MAP) return ALIAS_MAP[lower];
  const upper = raw.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, upper)) return upper as Timeframe;
  return null;
}

/** Resolve a timeframe string to canonical PO form, falling back to M1. */
export function resolveTimeframe(value: string): Timeframe {
  return normalizeTimeframe(value) ?? "M1";
}

/** Bucket width in milliseconds from any timeframe string (case-insensitive). */
export function timeframeToMs(timeframe: string): number {
  const canonical = normalizeTimeframe(timeframe);
  return canonical ? TIMEFRAME_MS[canonical] : TIMEFRAME_MS["M1"];
}

/** Bucket width in seconds from any timeframe string. */
export function timeframeToSeconds(timeframe: string): number {
  return Math.round(timeframeToMs(timeframe) / 1000);
}

// ── History Bar Gate (PO-parity retention table) ──

/** Per-bucket-width lookback retention in ms (PO-parity). */
export const MAX_HISTORY_LOOKBACK: Record<string, number> = {
  [TIMEFRAME_MS["S5"]]: 3_600_000,        // 1h
  [TIMEFRAME_MS["M1"]]: 86_400_000,       // 24h
  [TIMEFRAME_MS["M5"]]: 604_800_000,      // 7d
  [TIMEFRAME_MS["M15"]]: 2_592_000_000,   // 30d
  [TIMEFRAME_MS["H1"]]: 7_776_000_000,    // 90d
  [TIMEFRAME_MS["D1"]]: 31_536_000_000,   // 365d
};

/** Lookback retention in ms for a given bucket width. */
export function historyLookbackMs(bucketWidthMs: number): number {
  const key = String(bucketWidthMs);
  if (Object.prototype.hasOwnProperty.call(MAX_HISTORY_LOOKBACK, key)) {
    return MAX_HISTORY_LOOKBACK[key];
  }
  return 86_400_000;
}

/** True when a seeded bar passes the grid-alignment + lookback gate. */
export function historyBarCheck(
  barTimestampMs: number,
  bucketWidthMs: number,
  nowMs: number,
): boolean {
  if (!Number.isFinite(barTimestampMs) || barTimestampMs <= 0) return false;
  if (!Number.isFinite(bucketWidthMs) || bucketWidthMs <= 0) return false;
  if (!Number.isFinite(nowMs) || nowMs <= 0) return false;
  if (barTimestampMs % bucketWidthMs !== 0) return false;
  const lookback = historyLookbackMs(bucketWidthMs);
  if (nowMs - barTimestampMs > lookback) return false;
  if (barTimestampMs > nowMs) return false;
  return true;
}

// ── Signal Gate (AI-confidence parity) ──

/** Hard confidence threshold for directional signals (PO AI parity). */
export const SIGNAL_CONFIDENCE_THRESHOLD = 0.965;

/** Normalize a confidence value (0..1 or 0..100) into 0..1. */
export function normalizeConfidence(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return raw > 1 ? Math.min(raw / 100, 1) : raw;
}

/** True when a signal meets the hard confidence gate. */
export function signalGate(
  signal: "BUY" | "SELL" | null | undefined,
  confidence: number,
  threshold: number = SIGNAL_CONFIDENCE_THRESHOLD,
): boolean {
  if (signal !== "BUY" && signal !== "SELL") return false;
  const conf = normalizeConfidence(confidence);
  const thresh = Number.isFinite(threshold) && threshold > 0
    ? threshold
    : SIGNAL_CONFIDENCE_THRESHOLD;
  return conf >= thresh;
}

export interface SignalView {
  gatedSignal: "BUY" | "SELL" | null;
  directionText: string;
  badgeText: string | null;
  gated: boolean;
  confPct: number;
  gatePct: number;
}

export function buildSignalView(
  prediction: { signal?: string; confidence?: number } | null | undefined,
  threshold: number = SIGNAL_CONFIDENCE_THRESHOLD,
): SignalView {
  const rawSignal =
    prediction && (prediction.signal === "BUY" || prediction.signal === "SELL")
      ? prediction.signal
      : null;
  const conf01 = normalizeConfidence(Number(prediction?.confidence));
  const gated = signalGate(rawSignal, conf01, threshold);
  const gatedSignal: "BUY" | "SELL" | null = gated ? rawSignal : null;
  const gatePct =
    Math.round(
      Math.min(
        Number.isFinite(threshold) && threshold > 0
          ? threshold
          : SIGNAL_CONFIDENCE_THRESHOLD,
        1,
      ) * 1000,
    ) / 10;
  const confPct = Math.round(conf01 * 100);
  return {
    gatedSignal,
    confPct,
    gatePct,
    badgeText: !rawSignal
      ? null
      : gated
        ? `SIGNAL: ${rawSignal}`
        : `NO SIGNAL — confidence ${confPct}% < ${gatePct}%`,
    directionText: gatedSignal !== null ? gatedSignal : "NO SIGNAL",
    gated,
  };
}

// ── Chart Layout Constants (PO-parity) ──

export const INITIAL_BAR_SPACING_PX = 12;
export const MIN_BAR_SPACING_PX = 6;
export const DENSE_VISIBLE_BARS = 30;
export const BARS_PER_FRAME = 30;
export const TARGET_RIGHT_GUTTER = 4;

// ── Projection Slots ──

export interface ProjectionSlot {
  index: number;
  timeSec: number;
}

export function projectionSlots(
  tipTimestampMs: number,
  bucketWidthMs: number,
  leadMinutes: number,
): ProjectionSlot[] {
  if (!Number.isFinite(tipTimestampMs) || tipTimestampMs <= 0) return [];
  if (!Number.isFinite(bucketWidthMs) || bucketWidthMs <= 0) return [];
  const bwMin = Math.max(bucketWidthMs / 60_000, 1);
  const n = Math.max(1, Math.round((Number(leadMinutes) || 1) / bwMin));
  const tipSec = Math.floor(tipTimestampMs / 1000);
  const bwSec = Math.round(bucketWidthMs / 1000);
  if (bwSec <= 0) return [];
  const slots: ProjectionSlot[] = [];
  for (let i = 1; i <= n; i++) {
    slots.push({ index: i, timeSec: tipSec + i * bwSec });
  }
  return slots;
}

export function targetIntervals(leadMinutes: number, timeframeMinutes: number): number {
  const lead = Number(leadMinutes);
  const tf = Number(timeframeMinutes);
  if (!Number.isFinite(lead) || !Number.isFinite(tf) || tf <= 0) return 1;
  return Math.max(1, Math.min(30, Math.round(lead / tf)));
}

export function targetIntervalsFor(expirationSeconds: number, timeframeSeconds: number): number {
  const exp = Number(expirationSeconds);
  const tf = Number(timeframeSeconds);
  if (!Number.isFinite(exp) || !Number.isFinite(tf) || tf <= 0) return 1;
  return Math.max(1, Math.min(30, Math.round(exp / tf)));
}

export interface TargetSlot {
  index: number;
  timeSec: number;
  offsetSec: number;
}

export function targetSlots(
  tipTimestampSec: number,
  bucketSec: number,
  count: number,
): TargetSlot[] {
  if (!Number.isFinite(tipTimestampSec) || tipTimestampSec <= 0) return [];
  if (!Number.isFinite(bucketSec) || bucketSec <= 0) return [];
  const n = Math.max(1, Math.round(Number(count) || 1));
  const floor = Math.floor(tipTimestampSec / bucketSec) * bucketSec;
  const slots: TargetSlot[] = [];
  for (let i = 1; i <= n; i++) {
    slots.push({
      index: i,
      timeSec: floor + i * bucketSec,
      offsetSec: i * bucketSec,
    });
  }
  return slots;
}

// ── Axis Time Formatter ──

export function formatAxisTime(timestampSec: number, bucketWidthMs: number): string {
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return "";
  const bw = Number(bucketWidthMs) || 60_000;
  const d = new Date(timestampSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const day = d.getUTCDate();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = months[d.getUTCMonth()];
  if (bw < 60_000) return `${hh}:${mm}:${ss}`;
  if (bw < 86_400_000) return `${hh}:${mm}`;
  return `${day} ${mon}`;
}

// ── Target Candle Engine ──

export const TARGET_RGB: Record<string, [number, number, number]> = {
  BUY: [38, 166, 154],
  SELL: [239, 83, 80],
  NEUTRAL: [148, 163, 184],
};

export function targetColorFor(signal: string | null | undefined): string {
  if (signal === "BUY") return "#26a69a";
  if (signal === "SELL") return "#ef5350";
  return "#94a3b8";
}

export function targetAlpha(index: number, intervals?: number): number {
  const n =
    Number.isFinite(intervals) && (intervals as number) > 0
      ? (intervals as number)
      : 10;
  const decay = 0.3 / n;
  const floor = 0.65;
  return Math.max(floor, 0.95 - index * decay);
}

/** Per-bar rgba string from the signal colour + the alpha decay (chart-ready). */
export function targetRgba(
  signal: string | null | undefined,
  index: number,
  intervals?: number,
): string {
  const rgb =
    signal === "BUY"
      ? TARGET_RGB.BUY
      : signal === "SELL"
        ? TARGET_RGB.SELL
        : TARGET_RGB.NEUTRAL;
  const a = targetAlpha(index, intervals);
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
}

export interface TargetFrameCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  color: string;
  borderColor: string;
  wickColor: string;
  alpha: number;
  offsetSec: number;
  index: number;
}

export interface TargetCandleData extends TargetFrameCandle {}

export function buildTargetFrame(opts: {
  liveTipBucketSec: number;
  timeframeSec: number;
  intervals: number;
  liveClose: number;
  target: number;
  atr: number;
  signal: string | null | undefined;
}): TargetFrameCandle[] {
  const { liveTipBucketSec, timeframeSec, intervals, liveClose, target, atr, signal } = opts;
  if (!Number.isFinite(liveTipBucketSec) || liveTipBucketSec <= 0) return [];
  if (!Number.isFinite(intervals) || intervals < 1) return [];
  if (!Number.isFinite(timeframeSec) || timeframeSec <= 0) return [];
  if (!Number.isFinite(liveClose) || liveClose <= 0) return [];
  if (!Number.isFinite(target) || target <= 0) return [];
  const n = Math.max(1, Math.round(intervals));
  const delta = target - liveClose;
  const borderColor = targetColorFor(signal);
  const wickColor = borderColor;
  // VOLATILITY CUSHION — ATR × 0.35 per bar, tapering LINEARLY to zero as
  // progress → 1 (taper = (n − k) / n). The final projected candle therefore
  // lands exactly on targetPrice with no overshoot. A NaN/≤0 ATR falls back
  // to a flat-line projection (wick = 0, never thrown, never garbage). An
  // absolute safety cap (50% of the anchor level) kills pathological ATR
  // values, and the low is clamped at 0 so geometry is always finite.
  const atrValid = Number.isFinite(atr) && atr > 0;
  const basePrice = Math.max(Math.abs(liveClose), Math.abs(target));
  const safetyCap = Math.max(basePrice * 0.5, 1e-9);
  const frame: TargetFrameCandle[] = [];
  let prevClose = liveClose;
  for (let i = 1; i <= n; i++) {
    const k = i;
    const close = liveClose + delta * (k / n);
    const open = i === 1 ? liveClose : prevClose;
    const taper = (n - k) / n;
    const wick = Math.min(atrValid ? atr * 0.35 * taper : 0, safetyCap);
    const high = Math.max(open, close) + wick;
    const low = Math.max(0, Math.min(open, close) - wick);
    const alpha = targetAlpha(k, n);
    frame.push({
      time: liveTipBucketSec + k * timeframeSec,
      open,
      high,
      low,
      close,
      color: targetRgba(signal, k, n),
      borderColor,
      wickColor,
      alpha,
      offsetSec: k * timeframeSec,
      index: k,
    });
    prevClose = close;
  }
  return frame;
}

export function resolveLookaheadHorizon(leadMinutes: number): number {
  const v = Number(leadMinutes);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.max(1, Math.round(v));
}

export interface TargetViewportRange {
  from: number;
  to: number;
}

export function targetViewportRange(
  mainCount: number,
  intervals: number,
  rightGutter: number,
): TargetViewportRange {
  const from = Math.max(0, mainCount - DENSE_VISIBLE_BARS);
  const to = mainCount + Math.max(0, intervals) + Math.max(0, rightGutter);
  return { from, to };
}

/** Build predictive target candles for the chart projection layer.
 *  Candles ALWAYS render when the four data preconditions hold — the 96.5%
 *  confidence gate ONLY affects the BUY/SELL label, NOT the candle geometry.
 */
export function buildTargetCandles(opts: {
  liveTipBucketMs: number;
  liveClose: number;
  targetPrice: number;
  atr: number;
  signal: string | null | undefined;
  expirationSeconds: number;
  timeframeSeconds: number;
}): TargetCandleData[] {
  const { liveTipBucketMs, liveClose, targetPrice, atr, signal, expirationSeconds, timeframeSeconds } = opts;
  if (!Number.isFinite(liveTipBucketMs) || liveTipBucketMs <= 0) return [];
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return [];
  if (!Number.isFinite(timeframeSeconds) || timeframeSeconds <= 0) return [];
  if (!Number.isFinite(expirationSeconds) || expirationSeconds <= 0) return [];
  const tipSec = Math.floor(liveTipBucketMs / 1000);
  const intervals = Math.max(1, Math.min(30, Math.round(expirationSeconds / timeframeSeconds)));
  return buildTargetFrame({
    liveTipBucketSec: tipSec,
    timeframeSec: timeframeSeconds,
    intervals,
    liveClose,
    target: targetPrice,
    atr,
    signal,
  });
}

// ── ARCHITECTURAL OVERHAUL: DETERMINISTIC PROJECTION ENGINE ──
// Separates the high-frequency WebSocket tick stream from the target-candle
// projection matrix. Micro price fluctuations NEVER rebuild geometry — only a
// structural change (tip bucket advance, targetPrice, timeframe, expiration,
// gated signal, or anchor ATR) shifts the key and triggers a rebuild. The
// array reference is stable across identical keys, so renderers can skip
// repaints entirely by reference equality. Zero Date.now() anchoring.

/** Round a value to `places` decimals so float noise can never bust the key. */
function quantizeH(v: number, places: number): number {
  if (!Number.isFinite(v)) return 0;
  const p = Math.pow(10, places);
  return Math.round(v * p) / p;
}

export interface TargetProjectionInputs {
  /** Exact grid floor-bucket seconds of the live tip (never a raw wall clock). */
  liveTipBucketSec: number;
  timeframeSec: number;
  expirationSec: number;
  /** Instantaneous live close — only read on a structural rebuild. */
  liveClose: number;
  targetPrice: number;
  atr: number;
  signal: "BUY" | "SELL" | null;
}

export interface TargetProjectionSnapshot {
  /** Structural key of the projection currently rendered. "" = no projection. */
  key: string;
  intervals: number;
  candles: TargetCandleData[];
  /** Live close the projection was geometrically anchored to when locked. */
  anchorLiveClose: number;
  targetPrice: number;
  firstSlotSec: number;
  lastSlotSec: number;
  /** True when the snapshot is NOT identical to the previous present() call. */
  changed: boolean;
}

/**
 * Structural hash of a projection. Excludes the exact live close and wall time
 * by design — only bucket-aligned, expiry-bound shifters can invalidate it.
 */
export function targetProjectionKey(inputs: TargetProjectionInputs): string {
  const intervals = targetIntervalsFor(inputs.expirationSec, inputs.timeframeSec);
  return [
    "tip",
    Math.floor(inputs.liveTipBucketSec),
    "tf",
    Number(inputs.timeframeSec) || 0,
    "exp",
    Number(inputs.expirationSec) || 0,
    "n",
    intervals,
    "tgt",
    quantizeH(inputs.targetPrice, 7),
    "atr",
    quantizeH(inputs.atr, 7),
    "sig",
    inputs.signal ?? "N",
  ].join("|");
}

/**
 * Deterministic, memoized projection matrix. Calling present() with an
 * unchanged structural key returns the EXACT SAME candle array reference, so
 * the chart can skip series repaints by reference equality. The projection
 * re-anchors its `liveClose` baseline ONLY when the key shifts (new bucket or
 * a structural target/timeframe/expiration change) — never on micro ticks.
 */
export class TargetProjectionEngine {
  private key = "";
  private candles: TargetCandleData[] = [];
  private anchorLiveClose = 0;

  /** 1:1-deterministic snapshot. Returns identical array ref on unchanged key. */
  present(inputs: TargetProjectionInputs): TargetProjectionSnapshot {
    const tipSec = Math.floor(Number(inputs.liveTipBucketSec) || 0);
    const tfSec = Number(inputs.timeframeSec) || 0;
    const expSec = Number(inputs.expirationSec) || 0;
    const intervals = targetIntervalsFor(expSec, tfSec);
    const valid =
      tipSec > 0 &&
      tfSec > 0 &&
      expSec > 0 &&
      Number.isFinite(inputs.targetPrice) &&
      inputs.targetPrice > 0;
    if (!valid) {
      const changed = this.key !== "";
      this.key = "";
      this.candles = [];
      this.anchorLiveClose = 0;
      return {
        key: "",
        intervals,
        candles: this.candles,
        anchorLiveClose: 0,
        targetPrice: inputs.targetPrice,
        firstSlotSec: 0,
        lastSlotSec: 0,
        changed,
      };
    }
    const key = targetProjectionKey({
      liveTipBucketSec: tipSec,
      timeframeSec: tfSec,
      expirationSec: expSec,
      liveClose: inputs.liveClose,
      targetPrice: inputs.targetPrice,
      atr: inputs.atr,
      signal: inputs.signal,
    });
    if (key === this.key) {
      return {
        key,
        intervals,
        candles: this.candles,
        anchorLiveClose: this.anchorLiveClose,
        targetPrice: inputs.targetPrice,
        firstSlotSec: tipSec + tfSec,
        lastSlotSec: tipSec + intervals * tfSec,
        changed: false,
      };
    }
    const anchor =
      Number.isFinite(inputs.liveClose) && inputs.liveClose > 0
        ? inputs.liveClose
        : this.anchorLiveClose > 0
          ? this.anchorLiveClose
          : 0;
    this.candles = buildTargetCandles({
      liveTipBucketMs: tipSec * 1000,
      liveClose: anchor,
      targetPrice: inputs.targetPrice,
      atr: inputs.atr,
      signal: inputs.signal,
      expirationSeconds: expSec,
      timeframeSeconds: tfSec,
    });
    this.key = key;
    this.anchorLiveClose = anchor;
    return {
      key,
      intervals,
      candles: this.candles,
      anchorLiveClose: anchor,
      targetPrice: inputs.targetPrice,
      firstSlotSec: tipSec + tfSec,
      lastSlotSec: tipSec + intervals * tfSec,
      changed: true,
    };
  }

  /** Drop the memo so the next present() with ANY key is treated as new. */
  reset(): void {
    this.key = "";
    this.candles = [];
    this.anchorLiveClose = 0;
  }

  get currentKey(): string {
    return this.key;
  }

  get currentAnchor(): number {
    return this.anchorLiveClose;
  }
}

// ── SIGNAL STABILITY & STATE FREEZING ──
// A directional signal commits at a bucket boundary and is IMMUTABLE for the
// active bucket duration (freeze window). Confidence jitter around the 96.5%
// gate can only flip the UI label after the bucket elapses, and a return to
// neutral must persist for `holdNeutralEvals` consecutive reads — so the
// BUY/SELL label never shimmers on every second tick.

export interface SignalHoldBufferOptions {
  /** Consecutive neutral reads before a held directional signal clears. */
  holdNeutralEvals?: number;
  /** Freeze window in wall seconds (default M1 = 60s). */
  commitBucketSec?: number;
}

export class SignalHoldBuffer {
  private held: "BUY" | "SELL" | null = null;
  private committedSec = Number.MIN_SAFE_INTEGER;
  private nullStreak = 0;
  private readonly holdNeutralEvals: number;
  private readonly commitBucketSec: number;

  constructor(opts?: SignalHoldBufferOptions) {
    this.holdNeutralEvals = Math.max(1, opts?.holdNeutralEvals ?? 2);
    this.commitBucketSec = Math.max(1, opts?.commitBucketSec ?? 60);
  }

  /** Feed the raw gated signal. Returns the STABILIZED signal. */
  evaluate(
    raw: "BUY" | "SELL" | null,
    wallSec: number,
    bucketSec?: number,
  ): "BUY" | "SELL" | null {
    const freeze = Math.max(1, bucketSec ?? this.commitBucketSec);
    // Currently held directional signal — frozen for its active bucket
    if (this.held !== null) {
      const frozen = wallSec - this.committedSec < freeze;
      if (frozen) return this.held; // immutable within the freeze window
      // Bucket elapsed — evaluate for change
      if (raw === null) {
        this.nullStreak += 1;
        if (this.nullStreak >= this.holdNeutralEvals) {
          this.held = null;
          this.nullStreak = 0;
          this.committedSec = wallSec;
        }
        // committedSec is NOT updated on a non-committing read; the bucket
        // window stays open so successive neutral reads can count toward the
        // holdNeutralEvals threshold without a second full-bucket freeze.
        return this.held;
      }
      // Structural directional candidate arrives after the freeze → commit now
      this.held = raw;
      this.nullStreak = 0;
      this.committedSec = wallSec;
      return this.held;
    }
    // Currently neutral — directional commits immediately; neutral accumulates
    if (raw !== null) {
      this.held = raw;
      this.nullStreak = 0;
      this.committedSec = wallSec;
    } else {
      this.nullStreak += 1;
    }
    return this.held;
  }

  /** Reset to neutral. */
  reset(): void {
    this.held = null;
    this.committedSec = Number.MIN_SAFE_INTEGER;
    this.nullStreak = 0;
  }

  get current(): "BUY" | "SELL" | null {
    return this.held;
  }
}

// ── Data contracts ──

/** A single real tick as broadcast over the WebSocket `live_tick` channel. */
export interface LiveTick {
  symbol: string;
  price: number;
  /** Strict upstream epoch milliseconds. Missing or invalid timestamps reject the tick. */
  timestamp: number;
  volume?: number;
  /** Original upstream timestamp, retained for diagnostics. */
  serverTimestamp?: number;
  /** Strict classification from the bridge feed ("forex"|"otc"|"crypto"). */
  assetType?: string;
}

/** An OHLCV candle. `timestamp` is the bucket OPEN time (epoch ms). */
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── NATIVE HEIKIN ASHI TRANSFORMATION ENGINE ──
// The authentic Heikin-Ashi candle math shared by every renderer. Standard
// candlesticks are converted with the canonical formulas:
//
//     HA_Close = (Open + High + Low + Close) / 4
//     HA_Open  = (prev HA_Open + prev HA_Close) / 2   (first bar: (O+C)/2)
//     HA_High  = Max(High, HA_Open, HA_Close)
//     HA_Low   = Min(Low,  HA_Open, HA_Close)
//
// Because HA_Open is RECURSIVE across adjacent bars, the transform is a fold
// over the FULL merged sequence (history + live) — never a per-bar lookback
// without state. The recursive carrier is also
// BOUNDED to the running RAW-tick domain (min low / max high observed so far):
// HA_Open can never compound past the actual prices the pair traded, so the HA
// band stays glued to real price levels across deep history → live transitions
// instead of drifting off the visible scale. Bar timestamps/volume are
// preserved untouched; HA bodies colour green/red by HA_Close vs HA_Open.
//
// NOTE: the MAIN chart series is NATIVE Heikin-Ashi — every candle (historical
// seed + live morph) is folded through this transform inside the aggregator
// before the chart injects it, so the pane renders one continuous HA encoding.
export interface HeikinAshiBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * HA_Open / HA_Close of the PREVIOUS bar — the recursion carrier for HA_Open —
 * plus the running RAW-tick domain folded so far. The domain bounds the closed
 * chain and the live morph IDENTICALLY (it rides inside `next`), so the full
 * re-fold and the per-tick carry can never diverge across history → live.
 */
export interface HeikinAshiState {
  open: number;
  close: number;
  /** Running minimum RAW low folded so far — the lower bound for HA_Open. */
  minLow: number;
  /** Running maximum RAW high folded so far — the upper bound for HA_Open. */
  maxHigh: number;
}

/** Debug surface for the aggregator — returned by getDebug(). */
export interface AggregatorDebug {
  symbol?: string;
  timeframe: string;
  bucketMs: number;
  tickCount: number;
  bucketWrites: number;
  bucketsCreated: number;
  bucketsUpdated: number;
  gapCount: number;
  historyRejectedCount: number;
  historyLiveRejected: number;
  projectionSlot0OffsetMs: number;
  [key: string]: unknown;
}

/** HA_Close = (Open + High + Low + Close) / 4. */
export function heikinAshiClose(c: HeikinAshiBar): number {
  return (c.open + c.high + c.low + c.close) / 4;
}

/**
 * HA_Open for one bar. The first bar of a series has no predecessor, so it is
 * seeded with the conventional midpoint (Open + Close) / 2; every subsequent
 * bar inherits the midpoint of the previous bar's HA_Open / HA_Close.
 */
export function heikinAshiOpen(
  prev: HeikinAshiState | null,
  c: HeikinAshiBar,
): number {
  return prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
}

/**
 * Authentic Heikin-Ashi transformation of ONE bar against its predecessor's
 * HA state. Returns the HA bar (open/high/low/close) plus the HA state to
 * carry into the NEXT bar — the building block for both the full-series fold
 * and the per-tick live morph.
 */
export function toHeikinAshiBar(
  c: HeikinAshiBar,
  prev: HeikinAshiState | null,
): { bar: HeikinAshiBar; next: HeikinAshiState | null } {
  // FINITE-VALUE GUARD (zero-NaN policy): a malformed tick (NaN/Infinity in
  // raw OHLC) must NEVER seed the recursion carrier. The bar is passed
  // through verbatim and the HA state is carried unchanged, so the chart
  // pipeline stays numerically clean — HA never fabricates or poisons.
  const finite =
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close);
  if (!finite) {
    return { bar: c, next: prev };
  }
  const close = heikinAshiClose(c);
  // ── RAW-TICK DOMAIN BOUND (NO COMPOUNDING DRIFT) ──
  // The recursion carrier for HA_Open is clamped into the domain of REAL
  // traded prices folded so far (min raw low → max raw high). The first bar's
  // midpoint (O+C)/2 is already inside [low, high] on a valid OHLC row, so the
  // clamp is a no-op there; for every later bar it guarantees HA_Open can never
  // compound outside the tape's observed price band — the HA series tracks the
  // real axis instead of walking off it during long drifts. The bound rides in
  // `next`, so the full fold and the per-tick live morph share it exactly.
  const rawLow = c.low;
  const rawHigh = c.high;
  const minLow = prev ? Math.min(prev.minLow, rawLow) : rawLow;
  const maxHigh = prev ? Math.max(prev.maxHigh, rawHigh) : rawHigh;
  const open = Math.min(Math.max(heikinAshiOpen(prev, c), minLow), maxHigh);
  return {
    bar: {
      open,
      high: Math.max(rawHigh, open, close),
      low: Math.min(rawLow, open, close),
      close,
    },
    next: { open, close, minLow, maxHigh },
  };
}

/**
 * Full-series Heikin-Ashi transform — folds `toHeikinAshiBar` across every
 * bar so HA_Open chains correctly from the first bar to the live tip. Input
 * rows keep their extra fields (`time`, `volume`, …); only open/high/low/
 * close are replaced. Returns the input unchanged for empty/non-array input.
 */
export function toHeikinAshiSeries<T extends HeikinAshiBar>(candles: T[]): T[] {
  if (!Array.isArray(candles) || candles.length === 0) return candles;
  let prev: HeikinAshiState | null = null;
  return candles.map((c) => {
    const { bar, next } = toHeikinAshiBar(c, prev);
    prev = next;
    return { ...c, ...bar };
  });
}

/**
 * Per-symbol candle lifecycle phase — the explicit forward-looking state
 * machine behind the autonomous aggregation engine.
 *
 *   • IDLE      — pair tracked but no price reference yet; the bucket grid is
 *                 known, but no (even synthetic) bar is open until a REAL price
 *                 exists (a synthetic bar from scratch has no open/close).
 *   • SYNTHETIC — a live bucket is open on the exact wall-clock boundary
 *                 carrying the last known traded price; it is waiting for (and
 *                 will be overwritten by) the first real tick of the bucket.
 *   • LIVE      — real ticks are folding into the open bucket (open/high/low/
 *                 close/volume are 100% market data).
 *   • CLOSED    — the bucket finalised on the predictive boundary and can no
 *                 longer mutate; output only at rollover / on close dispatch.
 */
export type CandlePhase = "IDLE" | "SYNTHETIC" | "LIVE" | "CLOSED";

export interface AggregatorCallbacks {
  /**
   * Fires on EVERY tick that mutates the in-progress candle — including the
   * tick that OPENS a new bucket or a wall-clock automatic rollover.
   * The chart repaints via `series.update()`:
   * same timestamp = last bar morphs in place, newer timestamp = LC appends a
   * new bar while the previous one is fixed automatically.
   * `phase` is the emitting bucket's lifecycle state (SYNTHETIC when the bar
   * was opened by the wall-clock engine and is still awaiting its first real
   * tick, LIVE once market ticks are folding in, CLOSED at rollover).
   */
  onCandleUpdate?: (
    candle: Candle,
    symbol: string,
    timeframe: Timeframe,
    phase?: CandlePhase,
  ) => void;
  /**
   * Fires exactly once when a bucket rolls over. The authoritative trigger for
   * the async AI `/predict` dispatch.
   */
  onCandleClose?: (
    candle: Candle,
    symbol: string,
    timeframe: Timeframe,
  ) => void;
  onRawBar?: (
    candle: Candle,
    symbol: string,
    timeframe: Timeframe,
  ) => void;
  /**
   * Fires on the SELF-DRIVING projector loop (PROJECTION_DRIFT_MS) for the
   * active symbol whenever a live bucket exists — even between ticks. The
   * chart subscribes to keep its leading target drifting; the store can use it
   * for diagnostics. Computation is throttled by the projection cache (the
   * weighted fit is at most PROJECTION_CACHE_MS fresh per tick-clean pass).
   */
  onProjection?: (event: ProjectionEvent) => void;
}

/** One live candle update delivered to a `subscribeLive` listener. */
export interface LiveCandleEvent {
  /** The mutated in-progress (or freshly re-bucketed) OHLCV candle. */
  candle: Candle;
  symbol: string;
  /** The aggregator's active timeframe at the moment the event fired. */
  timeframe: Timeframe;
}

/**
 * Leading (predictive) projection of the ACTIVE bucket — a real-data-driven
 * extrapolation of where the forming candle's close will land.
 *
 * Computed on every ingested tick from the retained real tick stream (least-
 * squares momentum drift extended to the bucket close), clamped into a sane
 * band around recent realised prices. It NEVER mutates the real OHLC series —
 * it is delivered as a forecast so the chart can paint a distinct leading
 * marker that draws ahead of the confirmed candle.
 */
export interface LeadingProjection {
  /** Projected pending close of the active bucket (price units). */
  close: number;
  /** Projected bucket high (superset of the real high and the projection). */
  high: number;
  /** Projected bucket low (subset of the real low and the projection). */
  low: number;
  /** Momentum drift in price units per millisecond (signed). */
  slopePerMs: number;
  /**
   * Epoch ms the projection was computed for. Uses the PREDICTIVE LEAD clock
   * (system time + leadMs), so the close target sits exactly one timeframe
   * ahead of standard sync — the projection always aims at the EXPIRATION
   * boundary, not "now".
   */
  computedAt: number;
  /** Leading-clock bucket OPEN (epoch ms) the projection belongs to. */
  bucketOpen: number;
  /** Leading-clock bucket CLOSE / expiry instant the projection targets. */
  bucketClose: number;
  /** Milliseconds remaining until the projected bucket close (=== boundaryIn). */
  remainingMs: number;
  /** 0..1 fraction of the leading bucket already elapsed. */
  progress: number;
}

/**
 * One self-driven LEADING event emitted by the aggregator's projector loop.
 * The aggregator is the computational heart: it recomputes the active pair's
 * projection on its OWN drone cadence (independently of the tick stream) and
 * broadcasts this event so any host — chart, signal engine, diagnostics —
 * stays locked to the same forward-looking target without polling or waiting
 * for the next tick.
 */
export interface ProjectionEvent {
  symbol: string;
  timeframe: Timeframe;
  /**
   * Lifecycle phase of the emitting bucket. IDLE pairs (registered, still
   * awaiting their first real price) ALSO emit geometry-only events so any
   * host — chart, countdown, diagnostics — stays locked to the exact
   * boundary grid from the very first frame, never a dead space. Progression:
   * IDLE → SYNTHETIC → LIVE → CLOSED.
   */
  phase: CandlePhase;
  /** Exact expiry geometry at the moment of emission (leading clock). */
  geometry: BoundaryGeometry;
  /** The freshly computed leading projection (null only if no price exists). */
  projection: LeadingProjection | null;
}

/** Exact mathematical mapping of real time onto the building candle's grid. */
export interface BoundaryGeometry {
  /** Bucket OPEN on the timeframe grid (epoch ms) — strict grid alignment. */
  bucketOpen: number;
  /** Bucket CLOSE / expiry instant (epoch ms) — the LOCKED target. */
  bucketClose: number;
  /** Milliseconds until the leading boundary fires (countdown). */
  boundaryIn: number;
  /** Milliseconds already absorbed inside the leading bucket. */
  elapsed: number;
  /** 0..1 fraction of the bucket already elapsed (strict = elapsed/bucketMs). */
  progress: number;
  /** Active bucket width in ms. */
  bucketMs: number;
  /** Predictive lead in ms (0 when the clock is not ahead of system time). */
  leadMs: number;
}

// ── Predictive timing lead ──
/**
 * DEPRECATED — machine lead constant superseded by exact one-timeframe lead.
 * The byte-true lead is `leadMs = leadTimeOffsetOverride ?? bucketMs` (see the
 * aggregator constructor): candle boundaries close and /predict signals fire
 * exactly ONE full user-selected timeframe BEFORE the external platform's
 * confirmed candle boundary — no 170ms guess, no sub-frame drift. Retained as
 * a named export only for existing callers; it is never used to compute a
 * single boundary. Candle creation/boundary firing is driven 100% by leadMs.
 */
export const PREDICTIVE_LEAD_MS = 170;

/**
 * Self-driving projector cadence. The aggregator recomputes + broadcasts the
 * active pair's projection every this many ms, independent of tick arrival —
 * the leading target keeps drifting toward expiry even on a silent tape.
 */
export const PROJECTION_DRIFT_MS = 150;

/**
 * Maximum age (ms) of a cached leading projection before `getCachedProjection`
 * recomputes the weighted least-squares fit. Frame-rate reads for the chart
 * become near-zero-cost cache hits; the cache is invalidated on every tick and
 * rollover so burst reactivity stays exact.
 */
export const PROJECTION_CACHE_MS = 100;

// ── Predictive Lookahead Timeframe (forward-projecting target candles) ──
// The lookahead engine PRE-RENDERS the upcoming OHLCV target candles ahead of
// the external platform's timeline (Pocket Option lag beaten by 1m to 5m+):
// it extrapolates the LIVE bucket's momentum drift forward across a sequence
// of future wall-clock bucket boundaries and occupies those exact grid slots
// with mathematically derived projected candles — every one anchored to the
// real tape, zero demo. The drift is tapered toward mean reversion (a distant
// projection must not explode), and each projected candle carries a
// `projectionStrength` that decays with distance so the UI can fade
// confidence honestly.
export type LookaheadHorizonMinutes = 1 | 2 | 3 | 5;
export const LOOKAHEAD_HORIZON_OPTIONS: LookaheadHorizonMinutes[] = [
  1, 2, 3, 5,
];
export const DEFAULT_LOOKAHEAD_HORIZON: LookaheadHorizonMinutes = 5;

/** Drift taper per lookahead bucket: close_k = prev + slope*bucketMs*τ^k. */
export const LOOKAHEAD_TAPER_TAU = 0.85;
/** Wick half-range as a fraction of the realized recent range (bucket k). */
export const LOOKAHEAD_WICK_MULT = 0.55;
/** Absolute wick half-range cap in multiples of the recent-range σ — the
 *  forward-projected envelope can never wing out beyond a realistic volatility
 *  bound, no matter how far ahead the lookahead horizon reaches. */
export const LOOKAHEAD_WICK_MAX_SIGMA = 6;
/** Projection-strength decay per lookahead bucket (confidence fade factor). */
export const LOOKAHEAD_STRENGTH_DECAY = 0.82;

export interface LookaheadCandle extends Candle {
  /** 0-based index ahead of the live forming bar (1 = next target bucket). */
  ahead: number;
  /** Decaying confidence [0,1] of this projected candle. */
  projectionStrength: number;
}

/**
 * One forward-lookahead emission: the target candle series pre-rendered ahead
 * of the live timeline for a configurable 1m/2m/3m/5m horizon. `candles` are
 * strictly anchored to wall-clock bucket boundaries BEYOND the live bar, so a
 * chart host can draw a distinct "lookahead" series that visually outruns the
 * external feed by the full horizon — not just the current bucket close.
 */
export interface LookaheadEvent {
  symbol: string;
  timeframe: Timeframe;
  /** Configured horizon in minutes (1 | 2 | 3 | 5). */
  horizonMinutes: number;
  /** Predictive wall-clock instant the series was computed for. */
  computedAt: number;
  /** The live (real) candle the projections anchor from. */
  anchorCandle: Candle | null;
  /** Projected forward candles, sorted ascending by bucket open time. */
  candles: LookaheadCandle[];
}

export interface AggregatorOptions extends AggregatorCallbacks {
  /** Max closed candles retained in memory per symbol. */
  maxCandles?: number;
  /** Max raw ticks retained for lossless re-bucketing on timeframe switch. */
  maxTickHistory?: number;
  /**
   * Forward candle lead in ms. Defaults to exactly ONE active timeframe
   * (`bucketMs`), so the whole candle grid leads the external platform by one
   * full slot. Override only to pin a different exact lead.
   */
  leadTimeOffsetMs?: number;
  /**
   * Predictive lookahead horizon in minutes (default 5, options 1|2|3|5).
   * How far AHEAD of the live timeline the aggregator pre-renders projected
   * target candles — the amount of external-platform latency beaten.
   */
  lookaheadHorizonMinutes?: LookaheadHorizonMinutes;
  /**
   * ZERO-FABRICATION mode (default true).
   * When true the aggregator:
   *  • Buckets every tick using its UPSTREAM timestamp (the pocket-bridge's
   *    PO-aligned epoch) — never re-anchors to the local arrival clock.
   *  • NEVER opens a synthetic flat-line candle on wall-clock rollover or
   *    prime — the live candle only opens from a REAL tick.
   *  • NEVER inserts flat-line gap-fill bars when multiple buckets pass
   *    without a tick (honest silence vs fabricated continuity).
   * Setting false restores the legacy behaviour (arrival-clock anchoring +
   * synthetic placeholder candles).
   */
  zeroFabrication?: boolean;
}

// ── Internal per-symbol state ──

interface SymbolState {
  /** Raw real ticks, ascending by timestamp. Enables re-bucketing on switch. */
  ticks: LiveTick[];
  /** Finalised candles for the ACTIVE timeframe, ascending by open time. */
  closed: Candle[];
  /** Real historical bars seeded from the backend (re-aggregatable coarser). */
  history: Candle[];
  /** The bucket currently accumulating ticks (null until first tick/rollover). */
  live: Candle | null;
  /** Last known traded price for flat-line continuity on missing ticks. */
  lastPrice: number;
  /** True when current live candle was opened automatically on wall-clock rollover without a real tick yet. */
  isLiveSynthetic: boolean;
  /**
   * Last wall-clock bucket this symbol was synchronised at (`bucketStart(nowMs,
   * bucketMs)`). Lets syncWallClock short-circuit a symbol whose bucket has NOT
   * advanced — turning the O(symbols) tick-path walk into O(1) comparisons so a
   * high-frequency tick burst never re-scans/never re-emits for unchanged bars.
   * Rebuilt tick streams MUST reset it to 0 so the next sync reprocesses.
   */
  lastSyncBucket: number;
  /** Explicit lifecycle phase (IDLE → SYNTHETIC → LIVE → CLOSED). */
  phase: CandlePhase;
  /** Last computed leading projection { computedAt, value } (throttled cache). */
  projectionCache: { at: number; value: LeadingProjection | null } | null;
  /** Lookahead series cache { computedAt, value } (throttled per horizon). */
  lookaheadCache: { at: number; value: LookaheadEvent | null } | null;
  /**
   * Carried HA_Open/HA_Close of the LAST CLOSED bar — the recursion carrier
   * for native Heikin-Ashi emissions (forming-live HA_Open chains off it).
   * Re-anchored from the folded closed chain on every seed / re-bucket; the
   * fold and the per-bar carry are the same sequence, so they always agree.
   */
  prevHa: HeikinAshiState | null;
  recentPrices: number[];
  volMedian: number;
  volScale: number;
  volStreak: number;
  volSide: number;
  tickCount: number;
  bucketWrites: number;
  bucketsCreated: number;
  bucketsUpdated: number;
  gapCount: number;
  historyRejectedCount: number;
  historyLiveRejected: number;
}

const DEFAULT_MAX_CANDLES = 500;
const DEFAULT_MAX_TICKS = 5_000;
const LIVE_VOL_WINDOW = 64;
const MAD_TO_SIGMA = 1.4826;
const LIVE_TICK_CLAMP_SIGMA = 6;
const PROJECTION_CLAMP_SIGMA = 8;
const LOOKAHEAD_CLAMP_SIGMA = 12;

function clampSpot(
  v: number,
  median: number,
  scale: number,
  sigma: number,
): number {
  const band = scale * sigma;
  return Math.min(Math.max(v, median - band), median + band);
}

export const MAX_TICK_DELTA_RATIO = 0.015;

export function clampPriceToReality(
  price: number,
  baseline: number,
): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  if (!Number.isFinite(baseline) || baseline <= 0) return price;
  const half = Math.abs(baseline) * MAX_TICK_DELTA_RATIO;
  if (half <= 0) return price;
  const lo = baseline - half;
  const hi = baseline + half;
  if (price < lo) return lo;
  if (price > hi) return hi;
  return price;
}

// ── Seed / replay anomaly guards (median-robust, L1-pure) ──
// These thresholds bound only the SEEDING paths (initial history injection +
// batch replay) where a single wild print used to inflate a whole candle or
// trace a false drop/spike through the opening series. Live `ingest` remains
// untouched: a live tick is real tape and folds 1:1 into the forming bar.
/** Systematic-skew re-anchor: a seeded series is re-anchored when at least this
 *  share of its bars sit ahead of the live session-tip grid and agree on the
 *  exact whole-bucket multiple (see detectSystematicSeedSkew). */
const SEED_SKEW_AHEAD_SHARE = 0.5;
/** Minimum number of seeded bars required to conclude a systematic skew. */
const SEED_SKEW_MIN_BARS = 2;
/** A seeded candle whose high-low spread exceeds this multiple of the series'
 *  MEDIAN spread is an outlier wick — its high/low are clamped into a sane
 *  band around its own body instead of tracing a false drop/spike. */
const CANDLE_WICK_OUTLIER_MULT = 12;
/** When an outlier wick is clamped, its high/low stay within this multiple of
 *  the series' median spread beyond the candle's own open/close extremes. */
const CANDLE_WICK_CLAMP_MULT = 6;
/** Minimum number of seeded candles before the median-spread wick guard runs
 *  (a median over 3-5 bars is unreliable noise, not a baseline). */
const CANDLE_WICK_GUARD_MIN_N = 6;
/** A replayed tick whose price deviates from BOTH neighbours by more than this
 *  multiple of the batch's median consecutive step is an isolated spike (a
 *  spike returns to the tape; a genuine move stays) — it is excluded from the
 *  fold and the retained tick ring. */
const REPLAY_TICK_SPIKE_MULT = 12;

/**
 * SYSTEMATIC-SEED-GRID SKEW DETECTOR (pure, shared by the aggregator's
 * seedHistory and the chart's historical base so both re-anchor byte-for-byte
 * identically).
 *
 * A backend cushion of candles can arrive anchored to a shifted wall-clock grid
 * (e.g. systematic ~21h-up, lag≈75780s). Because live/replay buckets sit at the
 * ACTIVE lead-shifted session tip, a whole-histogram that far ahead renders as
 * a disconnected run of bars with no live overlap — the "historical drop".
 *
 * Detection is PHASE-ROBUST: candle timestamps and the reference tip are both
 * bucket-aligned, so the whole-bucket delta between them is never polluted by
 * the fractional millisecond of `Date.now()`. The series is judged against the
 * LIVE-GRID TIP (liveTipGridMs) and shifted only when it sits STRICTLY AHEAD of
 * the live edge AND is a uniformly displaced run: the per-bar deltas form a
 * contiguous dense range (spread ≤ length − 1, so a single corrupt far-future
 * tip bar or a legitimate sparse coarser history is rejected) and at least
 * SEED_SKEW_AHEAD_SHARE of the bars sit at or ahead of the live edge. The
 * whole series is then dragged back by the TIP's delta so the run reconnects
 * around the live grid.
 *
 * Returns the shift (bucketMs × whole buckets) to apply to EVERY bar, or 0.
 */
export function detectSystematicSeedSkew(
  candles: ReadonlyArray<{ timestamp: number }>,
  liveTipGridMs: number,
  bucketMs: number,
): number {
  if (!Array.isArray(candles) || candles.length < SEED_SKEW_MIN_BARS) return 0;
  const ts = candles
    .map((c) => c.timestamp)
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  if (ts.length < SEED_SKEW_MIN_BARS) return 0;
  const bw = bucketMs && bucketMs > 0 ? bucketMs : 60_000;
  if (!(Number.isFinite(liveTipGridMs) && liveTipGridMs > 0)) return 0;

  // Whole-bucket deltas from the live-tip grid (both sides bucket-aligned, so
  // the deltas are exact integers, never polluted by Date.now()'s residue).
  const deltas = ts.map((t) => Math.round((t - liveTipGridMs) / bw));
  const maxDelta = deltas[deltas.length - 1];
  if (maxDelta < 1) return 0;

  // A WHOLE-SERIES forward displacement is (a) dense — consecutive bars sit on
  // adjacent bucket slots, so the delta spread cannot exceed the bar-spacing
  // (length − 1) — and (b) uniformly AHEAD of the live edge: at least
  // SEED_SKEW_AHEAD_SHARE of the bars are not behind it. This simultaneously
  // rejects a series with ONE corrupt far-future tip bar (delta spread blows up
  // to 76000+) and a genuinely sparse coarser history, both of which must be
  // left alone for the chart's future filter / dense-prune.
  const minDelta = deltas[0];
  if (maxDelta - minDelta > ts.length - 1) return 0;
  const aheadCount = deltas.filter((d) => d >= 1).length;
  if (aheadCount < ts.length * SEED_SKEW_AHEAD_SHARE) return 0;

  return maxDelta * bw;
}

/**
 * Floor an epoch-ms instant onto its wall-clock aligned bucket open time.
 * Defensively handles seconds (<1e12) vs milliseconds, ensures positive finite value,
 * and aligns strictly to the timeframe grid without time drift (e.g. 1m starts at second 00).
 */
export function bucketStart(timestampMs: number, bucketMs: number): number {
  let ms = Number(timestampMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  if (ms < 1e12) ms *= 1000;
  const b = bucketMs && bucketMs > 0 ? bucketMs : 60_000;
  return Math.floor(ms / b) * b;
}

/**
 * LEAD-FORWARD BUCKET PLACEMENT — maps any raw instant onto the ACTIVE candle's
 * grid slot as a PURE function of its wall-clock bucket, with a guaranteed
 * minimum one-slot forward shift. This is the single bucket mapping used by
 * ingest, wall-clock rollover, seeding, replay re-bucketing and the chart's
 * historical lead-shift, so every layer lands on the SAME x-axis and the live
 * candle is ALWAYS visibly one full bucket ahead of the raw feed.
 *
 *   bucket      = floor(ts / bucketWidth) * bucketWidth     (the wall bucket)
 *   whole       = floor(lead / bucketWidth) * bucketWidth   (full-bucket lead)
 *   slot        = bucket + whole + (sub-bucket lead ? bucketWidth : 0)
 *
 * The output is a STRICT bucketMs multiple on the shifted grid. Because it is
 * a pure function of the wall bucket (never of the sub-bucket position), a
 * multi-bucket lead can NEVER scatter two instants of the same bucket across
 * two adjacent output slots — the mapping stays 1:1 continuous, so no
 * artificial gap can open between successive live candles. The sub-bucket
 * remainder of the lead contributes the guaranteed "+1 slot" push (the same
 * contract the legacy max() enforced for small leads), and a lead ≥ one
 * timeframe spans that many additional whole buckets.
 */
export function leadShiftBucket(
  timestamp: number,
  bucketMs: number,
  leadMs: number,
): number {
  const bw = bucketMs && bucketMs > 0 ? bucketMs : 60_000;
  const lead = Number.isFinite(leadMs) && leadMs >= 0 ? leadMs : 0;
  const whole = Math.floor(lead / bw) * bw;
  const sub = lead - whole;
  return bucketStart(timestamp, bw) + whole + (sub > 0 ? bw : 0);
}

/**
 * EXACT boundary geometry: strict mathematical mapping of real time onto the
 * active timeframe grid. Pure and synchronous — 0 demo data, 0 drift.
 *
 *   bucketOpen  = floor(time / bucketMs) * bucketMs   (grid-locked, always)
 *   bucketClose = bucketOpen + bucketMs               (the LOCKED expiry)
 *   boundaryIn  = bucketClose - time                  (leading countdown)
 *   progress    = (time - bucketOpen) / bucketMs      (strict 0..1 line share)
 */
export function boundaryGeometry(
  timeMs: number,
  bucketMs: number,
  leadMs: number,
): BoundaryGeometry {
  const ms = Number.isFinite(timeMs) && timeMs > 0 ? timeMs : 0;
  const bw = bucketMs && bucketMs > 0 ? bucketMs : 60_000;
  const open = Math.floor(ms / bw) * bw;
  const close = open + bw;
  const elapsed = Math.max(0, Math.min(bw, ms - open));
  return {
    bucketOpen: open,
    bucketClose: close,
    boundaryIn: Math.max(0, close - ms),
    elapsed,
    progress: elapsed / bw,
    bucketMs: bw,
    leadMs: Math.max(0, Number.isFinite(leadMs) ? leadMs : 0),
  };
}

/** Normalise a socket payload into a strict LiveTick, or null if unusable. */
export function normaliseTick(
  raw: unknown,
  baseline?: number,
): LiveTick | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const symbol =
    typeof r.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
  if (!symbol) return null;

  const rawPrice = Number(r.price ?? r.close);
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return null;
  const price = rawPrice;

  let timestamp: number;
  if (typeof r.timestamp === "number") {
    timestamp = r.timestamp;
  } else if (typeof r.timestamp === "string") {
    timestamp = Number(r.timestamp);
    if (!Number.isFinite(timestamp)) {
      const parsed = Date.parse(r.timestamp);
      if (Number.isFinite(parsed)) timestamp = parsed;
    }
  } else {
    return null;
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (timestamp < 1e12) timestamp *= 1000;
  if (!Number.isFinite(timestamp) || timestamp < 1e12) {
    return null;
  }

  const volumeRaw = Number(r.volume);
  const volume = Number.isFinite(volumeRaw) && volumeRaw > 0 ? volumeRaw : 0;

  const assetType =
    typeof r.asset_type === "string"
      ? r.asset_type.trim().toLowerCase()
      : typeof r.assetType === "string"
        ? r.assetType.trim().toLowerCase()
        : undefined;

  return {
    symbol,
    price,
    timestamp,
    serverTimestamp: timestamp,
    volume,
    ...(assetType ? { assetType } : {}),
  };
}

/**
 * RealtimeCandleAggregator
 *
 * Framework-agnostic (no React import) so it can be owned by the Zustand store,
 * unit-tested in isolation, and reused by any chart renderer.
 */
export class RealtimeCandleAggregator {
  private timeframe: Timeframe;
  private bucketMs: number;
  private readonly maxCandles: number;
  private readonly maxTickHistory: number;
  private leadMs: number;
  private leadTimeOffsetOverride?: number;
  private readonly symbols = new Map<string, SymbolState>();

  private onCandleUpdate?: AggregatorCallbacks["onCandleUpdate"];
  private onCandleClose?: AggregatorCallbacks["onCandleClose"];
  private onRawBar?: AggregatorCallbacks["onRawBar"];

  /**
   * Zero-latency live-candle listeners. Fired SYNCHRONOUSLY from the tick
   * ingestion / wall-clock sync stack so a chart host can push straight into
   * its series (`series.update`) with zero React round-trip — the whole
   * tick → canvas path lives in one call stack.
   */
  private readonly liveSubscribers = new Set<
    AggregatorCallbacks["onCandleUpdate"]
  >();

  /** Self-driving leading-projection listeners (see subscribeProjection). */
  private readonly projectionSubscribers = new Set<
    (event: ProjectionEvent) => void
  >();

  private onProjection?: AggregatorCallbacks["onProjection"];

  /** Predictive lookahead horizon in minutes (1|2|3|5). */
  private lookaheadHorizon: LookaheadHorizonMinutes;

  /** Self-driving lookahead-series listeners (see subscribeLookahead). */
  private readonly lookaheadSubscribers = new Set<
    (event: LookaheadEvent) => void
  >();

  /**
   * Subscribe to the forward-lookahead series stream. The projector loop
   * recomputes + broadcasts the ACTIVE pair's pre-rendered target candles on
   * the same PROJPROJECTION_DRIFT_MS cadence — the chart's lookahead series
   * keeps outrunning the external feed even on a silent tape. Returns an
   * unsubscribe.
   */
  public subscribeLookahead(fn: (event: LookaheadEvent) => void): () => void {
    this.lookaheadSubscribers.add(fn);
    return () => {
      this.lookaheadSubscribers.delete(fn);
    };
  }

  private emitLookahead(event: LookaheadEvent): void {
    for (const fn of this.lookaheadSubscribers) {
      try {
        fn(event);
      } catch {
        // A lookahead subscriber must never break the projector loop.
      }
    }
  }

  /**
   * Register a zero-latency live-candle listener. The callback is invoked
   * synchronously on every candle mutation (per tick + wall-clock rollover),
   * BEFORE the store's own React publish, so chart rendering never waits on a
   * React scheduler tick. Returns an unsubscribe.
   */
  public subscribeLive(fn: AggregatorCallbacks["onCandleUpdate"]): () => void {
    this.liveSubscribers.add(fn);
    return () => {
      this.liveSubscribers.delete(fn);
    };
  }

  private emitCandleUpdate(
    candle: Candle,
    symbol: string,
    timeframe: Timeframe,
  ): void {
    const phase = this.symbols.get(symbol)?.phase ?? "IDLE";
    for (const fn of this.liveSubscribers) {
      try {
        fn(candle, symbol, timeframe, phase);
      } catch {
        // A subscriber must never break the aggregation pipeline.
      }
    }
    try {
      this.onCandleUpdate?.(candle, symbol, timeframe, phase);
    } catch {
      // The store's React publish also must never break ingestion.
    }
  }

  /**
   * Re-anchor the carried `prevHa` from the ACTUAL closed chain after the
   * closed series is rebuilt wholesale (history seed, replay merge, timeframe
   * switch). Folding the chain is the single source of truth — the carry is
   * simply the last folded bar's HA state, so fold and carry can never drift.
   */
  private reanchorPrevHa(state: SymbolState): void {
    // Fold the closed chain carry-for-carry so the stored `prevHa` includes the
    // running raw-tick domain (minLow/maxHigh). Rebuilding from the LAST folded
    // bar alone would drop the domain and let the live morph clamp differently
    // than a full re-fold — the only place fold and carry could ever diverge.
    let prev: HeikinAshiState | null = null;
    for (const candle of state.closed) {
      const res = toHeikinAshiBar(candle, prev);
      prev = res.next;
    }
    state.prevHa = prev;
  }

  /**
   * True while a corner-case wall-clock sync is being run for a NON-live
   * operation (seeding history, re-bucketing on timeframe switch). Backfilled
   * gap "closes" are pure chart replay and must NOT fire onCandleClose —
   * otherwise seeding re-triggers the caller's async /predict, which re-seeds,
   * which fires onCandleClose again... an infinite request loop.
   */
  private suppressCloseCallbacks = false;

  private timer: ReturnType<typeof setInterval> | null = null;
  private boundaryTimeout: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler?: () => void;
  private projectorTimer: ReturnType<typeof setInterval> | null = null;
  /** Zero-fabrication mode: no synthetic candles, standard-clock stitch only.
   *  Default ON — buckets open strictly from the tick's own genuine print, so
   *  silent buckets stay silent and no flat last-valid-price filler can ever
   *  paint a synthetic jump between real live candles. Set to false to restore
   *  the legacy PO-parity flat-line continuity fill. */
  private zeroFabrication = true;
  private activeSymbol = "";
  private latestUpstreamTimestamp = 0;
  /** PO-aligned-epoch minus machine-clock skew, refreshed per genuine upstream
   *  timestamp so the wall-clock axis rolls on `Date.now()` without drift. */
  private clockOffsetMs = 0;

  constructor(timeframe: Timeframe = "M1", options: AggregatorOptions = {}) {
    this.timeframe = isTimeframe(timeframe) ? timeframe : "M1";
    this.bucketMs = TIMEFRAME_MS[this.timeframe];
    this.maxCandles = options.maxCandles ?? DEFAULT_MAX_CANDLES;
    this.maxTickHistory = options.maxTickHistory ?? DEFAULT_MAX_TICKS;
    this.leadTimeOffsetOverride =
      Number.isFinite(options.leadTimeOffsetMs) &&
      (options.leadTimeOffsetMs as number) >= 0
        ? options.leadTimeOffsetMs
        : undefined;
    // PARITY DEFAULT: leadMs 0 = the exact PO floor grid (floor(ts/bucketMs));
    // an explicit override re-engages the lead-shifted grid.
    this.leadMs = this.leadTimeOffsetOverride ?? 0;
    this.lookaheadHorizon =
      options.lookaheadHorizonMinutes ?? DEFAULT_LOOKAHEAD_HORIZON;
    this.onCandleUpdate = options.onCandleUpdate;
    this.onCandleClose = options.onCandleClose;
    this.onRawBar = options.onRawBar;
    this.onProjection = options.onProjection;
    this.zeroFabrication = options.zeroFabrication === true;

    // Real ticks always morph the live candle in place (high/low/close/volume).
    // Wall-clock rollover only closes finished buckets + opens flat continuity
    // at lastPrice — mirroring the bridge's m20_engine — never invents price.
  }

  /**
   * Predictive wall-clock: the machine's real clock panned onto the PO-aligned
   * epoch via a running offset (`latestUpstreamTimestamp − Date.now()`, refreshed
   * on every ingest/seedBatch). Because the offset is captured from genuine
   * upstream timestamps and `Date.now()` advances continuously, the axis rolls
   * buckets on the REGULAR WALL CLOCK even on a silent tape (no freeze at the
   * last upstream instant) while every boundary calculation stays anchored to
   * the exact PO grid the backend buckets on. The live candle's DATA WINDOW is
   * still formed only from genuine tick timestamps — this clock only says WHO
   * time it is for rollover, countdown, and projection.
   *
   * 1:1 PO PARITY: default lead 0 puts `bucketForTimestamp` on the exact
   * `floor(ts / bucketMs) * bucketMs` grid — identical to the bridge. A
   * configured lead (> 0) re-engages the lead-shifted axis instead.
   */
  private timingNow(): number {
    if (this.latestUpstreamTimestamp > 0) {
      return Date.now() + this.clockOffsetMs;
    }
    return Date.now();
  }

  /**
   * Forward lead used for every bucket calculation. 0 (default) = the exact PO
   * floor grid (`floor(ts / bucketMs) * bucketMs`, byte-identical to the
   * backend's m20_engine) — ticks belong to the slot the external platform
   * confirms. Non-zero = an explicit predictive lead projecting buckets that
   * far ahead of the feed.
   */
  public getLeadTimeOffset(): number {
    return this.leadMs;
  }

  public setLeadTimeOffset(offsetMs?: number): void {
    const override =
      offsetMs != null && Number.isFinite(offsetMs) && offsetMs >= 0
        ? offsetMs
        : undefined;
    // PARITY DEFAULT: `override ?? 0` returns to the exact PO floor grid.
    const nextLead = override ?? 0;
    if (nextLead === this.leadMs && override === this.leadTimeOffsetOverride) {
      return;
    }

    this.leadTimeOffsetOverride = override;
    this.leadMs = nextLead;

    // ── LEAD-EDGE RE-BUCKET ──
    // Changing the predictive lead moves the whole lead-shifted grid axis
    // (bucketForTimestamp → leadShiftBucket). Every retained history candle and
    // real tick is re-folded onto the NEW lead grid from the RAW sources, so
    // the series seamlessly re-projects ahead by the chosen offset with zero
    // seams, zero dropped bars and no stale bucket widths. Same lossless path
    // as setTimeframe (rebuild from history + ticks), then the boundary timer
    // is re-planned against the new geometry.
    for (const [symbol, state] of this.symbols.entries()) {
      const rebuilt = this.clampSeriesWicks(
        this.rebuild(state, this.bucketMs),
        state,
      );
      state.closed = rebuilt.slice(0, -1).slice(-this.maxCandles);
      this.reanchorPrevHa(state);
      state.live = rebuilt.length > 0 ? rebuilt[rebuilt.length - 1] : null;
      if (rebuilt.length > 0) {
        state.lastPrice = rebuilt[rebuilt.length - 1].close;
      }
      if (state.live) {
        state.phase = state.isLiveSynthetic ? "SYNTHETIC" : "LIVE";
      } else {
        state.phase = "IDLE";
      }
      // The new grid invalidates any projection/lookahead computed against the
      // old lead axis — force fresh caches and a fresh wall-clock sync pass.
      state.projectionCache = null;
      state.lookaheadCache = null;
      state.lastSyncBucket = 0;
      // Silent — re-bucketing is a chart replay, not a live rollover; never
      // fire onCandleClose here (no spurious /predict per lead-offset change).
      if (state.live) {
        this.emitCandleUpdate(
          this.haLive(state) ?? { ...state.live },
          symbol,
          this.timeframe,
        );
      }
    }
    this.scheduleBoundaryTimeout();
  }

  private bucketForTimestamp(timestamp: number): number {
    // 1:1 PO PARITY (leadMs === 0): the exact floor grid the backend computed
    // (`floor(ts / bucketMs) * bucketMs`). Live and history land on the SAME
    // slot the bridge's m20_engine aggregates — no forward shift, no seam.
    // A configured lead (> 0) re-engages the lead-shifted grid.
    if (this.leadMs <= 0) return bucketStart(timestamp, this.bucketMs);
    return leadShiftBucket(timestamp, this.bucketMs, this.leadMs);
  }

  /**
   * PREDICTIVE-LEAD BOUNDARY GEOMETRY.
   *
   * 1:1 PO PARITY (leadMs === 0): the active candle occupies the exact PO floor
   * grid, so the geometry IS the pure wall-clock boundary of that slot — open at
   * `floor(now / bucketMs) * bucketMs`, close exactly one interval later, and a
   * countdown/progress to the REAL rollover instant. This is precisely
   * `boundaryGeometry(now, bucketMs, 0)`.
   *
   * LEADED MODE (leadMs > 0): computed on the lead-shifted axis the live candle
   * actually OCCUPIES (see `leadShiftBucket`) so the countdown, progress,
   * boundary timeout and projection always target the REAL leading candle. The
   * DATA WINDOW of the candle at `bucketOpen` is the exact raw-clock span whose
   * ticks fold into that candle — derived generically from where
   * `leadShiftBucket` crosses the window's edges:
   *
   *   windowStart = min(bucketOpen - leadMs,  bucketOpen - bucketMs)
   *   windowEnd   = min(bucketOpen + bucketMs - leadMs, bucketOpen)
   */
  private leadGeometry(nowMs?: number): BoundaryGeometry {
    const now = nowMs != null && nowMs > 0 ? nowMs : this.timingNow();
    const bw = this.bucketMs;
    // ── PO-PARITY BRANCH (default): the pure floor grid — exact 1:1 with the
    // backend's `floor(ts / interval) * interval`.
    if (this.leadMs <= 0) return boundaryGeometry(now, bw, 0);
    // ── LEADED BRANCH (explicit offset configured) ──
    const open = leadShiftBucket(now, bw, this.leadMs);
    const close = open + bw;
    const windowStart = Math.min(open - this.leadMs, open - bw);
    const windowEnd = Math.min(open + bw - this.leadMs, open);
    const elapsed = Math.max(0, Math.min(bw, now - windowStart));
    return {
      bucketOpen: open,
      bucketClose: close,
      boundaryIn: Math.max(0, windowEnd - now),
      elapsed,
      progress: elapsed / bw,
      bucketMs: bw,
      leadMs: Math.max(0, this.leadMs),
    };
  }

  // ── Wall-Clock Synchronization Engine ──

  /**
   * Start high-precision wall-clock synchronization loops:
   * 1. 100ms interval for sub-second heartbeat and instant rollover detection.
   * 2. Precise boundary timeout targeted at exact :00.000 (bucket rollover instant).
   */
  public startHeartbeat(): void {
    if (typeof window === "undefined") return;
    this.stopHeartbeat();

    this.timer = setInterval(() => {
      this.syncWallClock();
    }, 100);

    this.scheduleBoundaryTimeout();

    if (typeof document !== "undefined" && !this.visibilityHandler) {
      const onVisible = () => {
        if (document.hidden) return;
        this.syncWallClock();
        this.emitProjection();
      };
      document.addEventListener("visibilitychange", onVisible);
      this.visibilityHandler = onVisible;
    }
  }

  public stopHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.boundaryTimeout) {
      clearTimeout(this.boundaryTimeout);
      this.boundaryTimeout = null;
    }
  }

  private scheduleBoundaryTimeout(): void {
    if (typeof window === "undefined") return;
    if (this.boundaryTimeout) {
      clearTimeout(this.boundaryTimeout);
      this.boundaryTimeout = null;
    }
    // Exact leading-boundary geometry — schedules against the ACTUAL rollover
    // instant of the live candle (its data window close on the lead-shifted
    // axis), so the boundary fires at the precise wall-clock instant the bars
    // roll, never "whenever ready".
    const geo = this.leadGeometry();
    // Fire 2ms past the boundary to guarantee the predictive clock has crossed
    // into the next bucket (no early-half-open, no missed rollover).
    this.boundaryTimeout = setTimeout(
      () => {
        this.syncWallClock();
        this.scheduleBoundaryTimeout();
      },
      Math.max(geo.boundaryIn + 2, 10),
    );
  }

  /**
   * Wall-clock Synchronization Engine.
   *
   * Compares all tracked symbols against the predictive wall-clock
   * (`Date.now() + poAlignedOffset`, default lead 0 = the exact PO floor grid
   * `floor(ts / bucketMs) * bucketMs`) so candle boundaries fire precisely when
   * the external platform's bucket rolls — not one timeframe early/late, and not
   * "whenever the next tick happens to arrive".
   * When the clock passes from bucket T to T+1 (or beyond):
   * 1. Closes the in-progress candle at T (emits onCandleClose).
   * 2. If intermediate buckets elapsed without ticks, produces flat-line
   *    continuity candles (open=high=low=close=lastPrice, volume=0) — the same
   *    last-valid-price hold the m20_engine prints — and emits onCandleClose.
   * 3. Opens the new live candle at currentBucket (emits onCandleUpdate).
   *
   * This guarantees that the timeline marches forward continuously with the
   * real wall clock without needing to wait for a WebSocket tick to arrive.
   */
  public syncWallClock(nowMs?: number): void {
    const effectiveNow = nowMs > 0 ? nowMs : this.timingNow();
    // The rollover comparator must live on the SAME clock as ingest() and
    // bucketForTimestamp() — parity mode fires on the exact PO floor grid, and
    // a nonzero leadTimeOffset fires on the lead-shifted grid it occupies.
    const currentBucket = this.bucketForTimestamp(effectiveNow);
    if (currentBucket <= 0) return;

    for (const [symbol, state] of this.symbols.entries()) {
      // ── O(1) SYNC SKIP ──
      // A symbol already synchronised for THIS exact bucket has nothing new to
      // do (its live candle already opened, synthetic gaps already filled). This
      // turns `syncWallClock` from an O(symbols) re-emit scan on every tick into
      // a handful of integer comparisons per symbol — the hot path for
      // high-frequency WebSocket bursts.
      if (currentBucket === state.lastSyncBucket) continue;

      // ── Case 1: Active live candle exists, but wall-clock moved to a newer bucket ──
      if (state.live && state.live.timestamp < currentBucket) {
        const finished = { ...state.live };
        const haFinished = toHeikinAshiBar(finished, state.prevHa);
        state.phase = "CLOSED";
        state.projectionCache = null;
        state.lookaheadCache = null;
        state.closed.push(finished);
        if (state.closed.length > this.maxCandles) {
          state.closed.splice(0, state.closed.length - this.maxCandles);
          this.reanchorPrevHa(state);
        } else {
          state.prevHa = haFinished.next;
        }
        state.lastPrice = finished.close;
        state.live = null;
        this.onRawBar?.(finished, symbol, this.timeframe);
        if (!this.suppressCloseCallbacks) {
          this.onCandleClose?.(
            { ...finished, ...haFinished.bar },
            symbol,
            this.timeframe,
          );
        }

        if (!this.zeroFabrication) {
          // ── LEAD-STABLE CONTINUITY (default) ──
          // Fill any gap buckets between finished.timestamp and currentBucket
          // and open a synthetic flat-line candle so the canvas never pauses.
          // Emitted as NATIVE Heikin-Ashi like every other candle, so gap bars
          // stay on the pane's single HA encoding.
          const step = this.bucketMs;
          let gapTime = finished.timestamp + step;
          while (gapTime < currentBucket) {
            const gapCandle: Candle = {
              timestamp: gapTime,
              open: state.lastPrice,
              high: state.lastPrice,
              low: state.lastPrice,
              close: state.lastPrice,
              volume: 0,
            };
            const haGap = toHeikinAshiBar(gapCandle, state.prevHa);
            state.closed.push(gapCandle);
            if (state.closed.length > this.maxCandles) {
              state.closed.splice(0, state.closed.length - this.maxCandles);
              this.reanchorPrevHa(state);
            } else {
              state.prevHa = haGap.next;
            }
            if (!this.suppressCloseCallbacks) {
              this.onCandleClose?.(gapCandle, symbol, this.timeframe);
            }
            // Zero-hop: the gap bar must reach chart subscribers too, otherwise
            // a multi-bucket gap (reconnect / tab sleep) renders as a jarring
            // jump while the React path is throttled.
            this.emitCandleUpdate(
              { ...gapCandle, ...haGap.bar },
              symbol,
              this.timeframe,
            );
            gapTime += step;
          }

          // Open new live candle at currentBucket with last known price
          state.live = {
            timestamp: currentBucket,
            open: state.lastPrice,
            high: state.lastPrice,
            low: state.lastPrice,
            close: state.lastPrice,
            volume: 0,
          };
          state.isLiveSynthetic = true;
          state.phase = "SYNTHETIC";
          state.projectionCache = null;
          state.lookaheadCache = null;
          this.emitCandleUpdate(
            this.haLive(state) ?? { ...state.live },
            symbol,
            this.timeframe,
          );
        }
        // ── ZERO-FABRICATION ──
        // Strict single-owner lifecycle: no multi-bucket filler is ever built.
        // The candle opened below is the ONLY sequential owner of the boundary
        // (open pinned to the interval start, flat at the last traded price),
        // and a real tick morphs it in place — the render series can never
        // void or drift.
      }

      // Continue the strict lifecycle: after that rollover (or from a fresh
      // registration with a known price) the exact next sequential candle
      // opens immediately on the boundary.
      if (this.zeroFabrication && !state.live) {
        this.openWallClockCandle(state, symbol, currentBucket);
      }
      // ── Case 2 (continuity): No live candle + price data → synthetic open.
      if (
        !this.zeroFabrication &&
        !state.live &&
        (state.closed.length > 0 || state.lastPrice > 0)
      ) {
        const lastClosed =
          state.closed.length > 0
            ? state.closed[state.closed.length - 1]
            : null;
        const lastTs = lastClosed ? lastClosed.timestamp : -1;
        const price =
          state.lastPrice > 0
            ? state.lastPrice
            : lastClosed
              ? lastClosed.close
              : 0;

        if (price > 0) {
          state.lastPrice = price;

          if (lastTs >= 0 && lastTs < currentBucket) {
            const step = this.bucketMs;
            let gapTime = lastTs + step;
            while (gapTime < currentBucket) {
              const gapCandle: Candle = {
                timestamp: gapTime,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: 0,
              };
              const haGap = toHeikinAshiBar(gapCandle, state.prevHa);
              state.closed.push(gapCandle);
              if (state.closed.length > this.maxCandles) {
                state.closed.splice(0, state.closed.length - this.maxCandles);
                this.reanchorPrevHa(state);
              } else {
                state.prevHa = haGap.next;
              }
              if (!this.suppressCloseCallbacks) {
                this.onCandleClose?.(gapCandle, symbol, this.timeframe);
              }
              this.emitCandleUpdate(
                { ...gapCandle, ...haGap.bar },
                symbol,
                this.timeframe,
              );
              gapTime += step;
            }
          }

          state.live = {
            timestamp: currentBucket,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: 0,
          };
          state.isLiveSynthetic = true;
          state.phase = "SYNTHETIC";
          state.projectionCache = null;
          state.lookaheadCache = null;
          this.emitCandleUpdate(
              this.haLive(state) ?? { ...state.live },
              symbol,
              this.timeframe,
            );
        }
      }

      // Mark this symbol as synchronised up to currentBucket (skips above are
      // therefore exact and idempotent for every future call in this bucket).
      state.lastSyncBucket = currentBucket;
    }
  }

  // ── Callback wiring ──

  public setCallbacks(callbacks: AggregatorCallbacks): void {
    if (callbacks.onCandleUpdate)
      this.onCandleUpdate = callbacks.onCandleUpdate;
    if (callbacks.onCandleClose) this.onCandleClose = callbacks.onCandleClose;
    if (callbacks.onRawBar) this.onRawBar = callbacks.onRawBar;
    if (callbacks.onProjection) this.onProjection = callbacks.onProjection;
  }

  /**
   * Wall-clock sync run from NON-live operations (history seeding, timeframe
   * re-bucket). Folds boundaries silently: the chart still gets its candles,
   * but onCandleClose is suppressed so backfilled buckets never re-trigger a
   * /predict (that would re-seed and self-loop).
   */
  private syncWallClockSilent(): void {
    this.suppressCloseCallbacks = true;
    try {
      this.syncWallClock();
    } finally {
      this.suppressCloseCallbacks = false;
    }
  }

  private openWallClockCandle(
    state: SymbolState,
    symbol: string,
    currentBucket: number,
  ): void {
    const lastClosed =
      state.closed.length > 0
        ? state.closed[state.closed.length - 1]
        : null;
    const price =
      state.lastPrice > 0
        ? state.lastPrice
        : lastClosed && lastClosed.close > 0
          ? lastClosed.close
          : 0;
    if (price <= 0) return;

    state.lastPrice = price;
    state.live = {
      timestamp: currentBucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    };
    state.isLiveSynthetic = true;
    state.phase = "SYNTHETIC";
    state.projectionCache = null;
    state.lookaheadCache = null;
    this.emitCandleUpdate(
      this.haLive(state) ?? { ...state.live },
      symbol,
      this.timeframe,
    );
  }

  public getTimeframe(): Timeframe {
    return this.timeframe;
  }

  public getBucketMs(): number {
    return this.bucketMs;
  }

  // ── Seeding with REAL historical bars from the backend ──

  /**
   * Seed a symbol with real historical candles (from /predict `candles` or the
   * OTC history endpoint) so the chart has depth before the first live tick.
   * Immediately syncs with wall-clock time so the active forming bucket is established.
   */
  public seedHistory(symbol: string, candles: Candle[]): void {
    const norm = symbol.trim().toUpperCase();
    const state = this.ensure(norm);

    // ── HISTORY BAR GATE (PO-parity retention) ──
    // Off-grid bars and bars older than the bucket's lookback window are never
    // seeded onto the chart (stray bars must never leak onto the axis). The
    // count is surfaced through getDebug().historyRejectedCount.
    const nowMs = this.timingNow() > 0 ? this.timingNow() : Date.now();
    let rejected = 0;
    const gated = (Array.isArray(candles) ? candles : []).filter((c) => {
      const ok = historyBarCheck(c.timestamp, this.bucketMs, nowMs);
      if (!ok) rejected += 1;
      return ok;
    });
    state.historyRejectedCount = rejected;

    // SYSTEMATIC-SKEW GRID NORMALIZATION — a backend replay can arrive anchored
    // to a shifted wall-clock grid (e.g. systematic ~21h-ahead, lag≈75780s).
    // Re-anchor the whole series onto the active session-tip grid in whole
    // bucket multiples so seeded chain + live bucket share one axis.
    const clean = this.normalizeSeedGrid(gated)
      .filter(
        (c) =>
          Number.isFinite(c.timestamp) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          c.close > 0,
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    // ── OUTLIER-WICK PURGE (prior to any folding) ──
    // A single corrupted historical bar (a dropped tape reprint, a spurious
    // blob print) would otherwise fold its far high/low into the opening chain
    // as a false drop/spike. Clamp outlier wicks against the series' robust
    // median spread BEFORE lead-alignment merges buckets.
    const seed = this.sanitizeSeedWicks(clean, norm);
    this.seedVolWindow(norm, seed.map((c) => c.close));

    state.history = clean;
    // ── STRICT LEAD-GRID ALIGNMENT (1:1 parity with live buckets) ──
    // Live/replay buckets are lead-shifted via bucketForTimestamp (one full
    // active timeframe ahead); the seeded closes must sit on that SAME axis or
    // the opening series renders one slot behind the live forming candle (the
    // off-by-one drop seam). Fold duplicate buckets after the wick purge.
    state.closed = this.leadAlignCandles(seed).slice(-this.maxCandles);
    this.reanchorPrevHa(state);
    state.live = null;
    if (state.closed.length > 0) {
      state.lastPrice = state.closed[state.closed.length - 1].close;
    }
    // Immediately sync with wall-clock time so current bucket is open. Runs
    // SILENTLY — the replayed/backfilled buckets here are historical filler,
    // not live rollovers, so they must not fire onCandleClose (which would
    // loop back into a /predict → re-seed → close cycle).
    this.syncWallClockSilent();
  }

  // ── Tick ingestion (Wall-Clock Anchored) ──

  /**
   * Fold one real tick into the ACTIVE bucket.
   *
   * Anchored to wall-clock arrival time:
   * 1. Wall-clock rollover is performed first if the boundary has elapsed.
   * 2. If the current live candle was a synthetic flat line (waiting for first tick),
   *    the first real tick sets open, high, low, close, and volume.
   * 3. Subsequent ticks in the same bucket expand high/low, update close, and add volume.
   *
   * SPLIT-TAIL REJECTION: a tick whose bucket is STRICTLY OLDER than the live
   * candle's (a late/desynced replay print) never regresses OHLC — lastPrice
   * still updates (we saw a real price), but the candle state is left untouched
   * so a burst of out-of-order ticks can never reopen or corrupt a closed bar.
   */
  public ingest(rawTick: unknown): Candle | null {
    const probe = (rawTick as { symbol?: unknown })?.symbol;
    const probeSymbol =
      typeof probe === "string" ? probe.trim().toUpperCase() : "";
    const tick = normaliseTick(rawTick, this.previousCloseOf(probeSymbol));
    if (!tick) return null;
    this.latestUpstreamTimestamp = Math.max(
      this.latestUpstreamTimestamp,
      tick.timestamp,
    );
    this.clockOffsetMs = this.latestUpstreamTimestamp - Date.now();

    const normSymbol = tick.symbol.trim().toUpperCase();
    const state = this.ensure(normSymbol);

    // Future-tick guard: a tick stamped >2s into the future is rejected.
    const nowWall = Date.now();
    if (tick.timestamp > nowWall + 2_000) return null;

    state.tickCount += 1;

    tick.price = clampPriceToReality(
      tick.price,
      this.previousCloseOf(normSymbol),
    );

    // Update last known traded price
    state.lastPrice = tick.price;

    this.trackVol(normSymbol, tick.price);
    const volSpot =
      state.volScale > 0 && state.volMedian > 0
        ? clampSpot(
            tick.price,
            state.volMedian,
            state.volScale,
            LIVE_TICK_CLAMP_SIGMA,
          )
        : tick.price;
    const spot = clampPriceToReality(
      volSpot,
      this.previousCloseOf(normSymbol),
    );

    // ── ZERO-FABRICATION TIMESTAMP POLICY ──
    // The upstream `timestamp` is the pocket-bridge's PO-aligned epoch (server
    // time, offset-corrected), NOT a local arrival clock. Bucket placement MUST
    // follow that genuine timestamp so the rendered candle aligns EXACTLY with
    // the bucket the bridge/backend computed — 100% data parity, zero drift.
    // Missing or invalid upstream timestamps were rejected by normaliseTick;
    // no browser arrival clock can move this candle onto another grid.
    tick.serverTimestamp = tick.timestamp;

    // Retain raw tick for lossless re-bucketing. Eviction is AMORTIZED: the
    // leading `splice(0, …)` only runs once every ~64 pushes past the cap, so
    // a saturated hot symbol's tick path stays O(1) instead of shifting a
    // 5000-element array on every single tick.
    state.ticks.push(tick);
    const overflow = state.ticks.length - this.maxTickHistory;
    if (overflow >= 64) {
      state.ticks.splice(0, overflow);
    }

    // Rollover fires from the next real upstream tick OR the wall-clock sync
    // beat — which itself only rolls on the exact bucket boundary and never
    // spins up extra candles.
    const currentBucket = this.bucketForTimestamp(tick.timestamp);
    const closedTip =
      state.closed.length > 0
        ? state.closed[state.closed.length - 1].timestamp
        : 0;

    if (!state.live) {
      if (closedTip > 0 && currentBucket <= closedTip) {
        return null;
      }
      state.live = {
        timestamp: currentBucket,
        open: spot,
        high: spot,
        low: spot,
        close: spot,
        volume: tick.volume ?? 0,
      };
      state.isLiveSynthetic = false;
      state.phase = "LIVE";
      state.bucketsCreated += 1;
      state.bucketWrites += 1;
    } else if (currentBucket > state.live.timestamp) {
      // ── STRICTLY-NEWER BUCKET → ROLLOVER ──
      // Finalise the forming bar and open the fresh leading bucket from the
      // genuine print. Only a tick mapped onto a LATER leading slot can
      // advance the timeline; `<` is a stale print (handled below).
      // Count skipped intermediate buckets as synthetic gaps.
      const skipped = Math.floor((currentBucket - state.live.timestamp) / this.bucketMs) - 1;
      if (skipped > 0) {
        state.gapCount += skipped;
        state.bucketWrites += skipped;
      }
      const finished = { ...state.live };
      const haFinished = toHeikinAshiBar(finished, state.prevHa);
      state.closed.push(finished);
      if (state.closed.length > this.maxCandles) {
        state.closed.splice(0, state.closed.length - this.maxCandles);
        this.reanchorPrevHa(state);
      } else {
        state.prevHa = haFinished.next;
      }
      state.phase = "CLOSED";
      state.projectionCache = null;
      state.lookaheadCache = null;
      this.onRawBar?.(finished, normSymbol, this.timeframe);
      if (!this.suppressCloseCallbacks) {
        this.onCandleClose?.(
          { ...finished, ...haFinished.bar },
          normSymbol,
          this.timeframe,
        );
      }
      state.live = {
        timestamp: currentBucket,
        open: spot,
        high: spot,
        low: spot,
        close: spot,
        volume: tick.volume ?? 0,
      };
      state.isLiveSynthetic = false;
      state.phase = "LIVE";
      state.bucketsCreated += 1;
      state.bucketWrites += 1;
    } else if (state.live.timestamp === currentBucket) {
      // Fixed lifecycle: the candle owns the whole interval. A real tick only
      // morphs OHLC in place — open stays pinned to the interval start, never
      // rebased.
      state.live.high = Math.max(state.live.high, spot);
      state.live.low = Math.min(state.live.low, spot);
      state.live.close = spot;
      state.live.volume += tick.volume ?? 0;
      state.bucketsUpdated += 1;
      state.bucketWrites += 1;
      if (state.isLiveSynthetic) {
        state.isLiveSynthetic = false;
        state.phase = "LIVE";
      }
    }
    // else: STRICTLY OLDER bucket — a late/out-of-order print. Candle state is
    // never touched; lastPrice was already updated above. The next tick on or
    // ahead of the live bucket continues the bar untouched.

    // Burst ticket: the leading projection cache is invalidated on EVERY real
    // tick so the defeatist frame-read (or the 150ms projector beat) recomputes
    // from the freshest tape — the leading marker reacts the frame a burst lands.
    state.projectionCache = null;
    state.lookaheadCache = null;

    // ── ZERO-LATENCY EMIT ──
    // Synchronously fan the mutated candle out to direct chart subscribers
    // AND the store's React publish, all inside the WebSocket handler stack.
    this.emitCandleUpdate(
      this.haLive(state) ?? { ...state.live },
      normSymbol,
      this.timeframe,
    );
    return { ...state.live };
  }

  /**
   * REPLAY SEEDING — bulk-fold a real backend replay batch (the server's
   * 2000-tick ring) into a symbol's series after a (re)subscribe.
   *
   * The backend ships the ring on `history` so a reconnecting client rebuilds
   * continuity from the last tick before the disconnect to the first live tick
   * after — closing the chart gap without waiting for the feed to move again.
   *
   * Zero-trigger guarantees:
   *   • Every tick is RE-ANCHORED to the arrival wall-clock so the replay
   *     lands on the exact same bucket grid as the live engine (never a
   *     server-clock time jump on the chart axis).
   *   • Closed buckets are folded silently (`syncWallClockSilent`) — replayed
   *     bars are historical filler and MUST NOT re-fire onCandleClose (that
   *     would storm /predict → re-seed → close → …).
   *   • The final live bar is emitted exactly once via the zero-hop stream so
   *     the chart paints the replay synchronously.
   *
   * Returns a null when nothing usable arrives (never fabricates bars).
   */
  public seedBatch(
    symbol: string,
    rawTicks: unknown[],
  ): { closed: Candle[]; live: Candle | null } | null {
    const norm = (symbol || "").trim().toUpperCase();
    if (!norm || !Array.isArray(rawTicks) || rawTicks.length === 0) return null;

    const ticks: LiveTick[] = [];
    for (const raw of rawTicks) {
      const t = normaliseTick(raw);
      if (t && t.symbol.trim().toUpperCase() === norm) ticks.push(t);
    }
    if (ticks.length === 0) return null;
    this.latestUpstreamTimestamp = Math.max(
      this.latestUpstreamTimestamp,
      ...ticks.map((tick) => tick.timestamp),
    );
    this.clockOffsetMs = this.latestUpstreamTimestamp - Date.now();

    // ── ZERO-FABRICATION ANCHORING ──
    // Preserve each replayed tick's UPSTREAM timestamp (the bridge's PO-aligned
    // epoch) so the replay lands on the same buckets the backend computed.
    // Arrival time is used only for ticks whose upstream timestamp is missing
    // Each replay tick retains its upstream timestamp without re-anchoring.
    const anchored: LiveTick[] = ticks.map((t) => {
      return {
        symbol: norm,
        price: t.price,
        timestamp: t.timestamp,
        serverTimestamp: t.timestamp,
        volume: t.volume,
      };
    });
    anchored.sort((a, b) => a.timestamp - b.timestamp);

    // ── REPLAY SPIKE PURGE (isolated drop/spike prints) ──
    // A replayed ring can carry a single wild blip (a dropped reprint or an
    // exchange anomaly) that, folded verbatim, inflates one candle's wick and
    // draws a false drop/spike through the reconstructed opening series. Detect
    // ISOLATED spikes: a tick whose price deviates from BOTH its neighbours by
    // more than the batch's robust median consecutive step. A genuine move
    // jumps and STAYS (only one side out of band) and survives; a spike jumps
    // and immediately reverts (both sides out of band) and is excluded from
    // the fold AND the retained ring, exactly like the chart's own prune.
    let replayedSpikes = 0;
    let replayedTicks: LiveTick[] = [];
    {
      const steps: number[] = [];
      for (let i = 1; i < anchored.length; i++) {
        const s = Math.abs(anchored[i].price - anchored[i - 1].price);
        if (Number.isFinite(s)) steps.push(s);
      }
      const stepMed = this.medianOf(steps);
      const cutoff = stepMed > 0 ? stepMed * REPLAY_TICK_SPIKE_MULT : 0;
      if (cutoff > 0 && anchored.length >= 3) {
        for (let i = 0; i < anchored.length; i++) {
          const t = anchored[i];
          const prev = i > 0 ? Math.abs(t.price - anchored[i - 1].price) : 0;
          const next =
            i < anchored.length - 1
              ? Math.abs(anchored[i + 1].price - t.price)
              : 0;
          if (prev > cutoff && next > cutoff) {
            replayedSpikes += 1;
            continue;
          }
          replayedTicks.push(t);
        }
        if (replayedSpikes > 0) {
          console.warn(
            `[Aggregator] seedBatch purged ${replayedSpikes} isolated spurious ` +
              `replay tick(s) for ${norm} (step cutoff ${cutoff.toFixed(6)})`,
          );
        }
      } else {
        replayedTicks = anchored;
      }
    }
    if (replayedTicks.length === 0) return null;

    const state = this.ensure(norm);
    state.lastPrice = replayedTicks.length > 0
      ? replayedTicks[replayedTicks.length - 1].price
      : state.lastPrice;

    // Retain replayed ticks so a timeframe switch re-buckets them (lossless).
    state.ticks.push(...replayedTicks);
    const overflow = state.ticks.length - this.maxTickHistory;
    if (overflow >= 64) state.ticks.splice(0, overflow);

    this.seedVolWindow(norm, replayedTicks.map((t) => t.price));

    const candles = this.clampSeriesWicks(
      this.bucketTicks(replayedTicks, this.bucketMs),
      state,
    );
    if (candles.length === 0) return null;

    const liveSeed = candles[candles.length - 1];
    const closedSeed = candles.slice(0, -1);

    // Merge into existing closed history, dedup-ing on bucket open time.
    const byTs = new Map<number, Candle>();
    for (const c of state.closed) byTs.set(c.timestamp, c);
    for (const c of closedSeed) byTs.set(c.timestamp, c);
    state.closed = Array.from(byTs.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-this.maxCandles);
    this.reanchorPrevHa(state);

    state.live = { ...liveSeed };
    state.isLiveSynthetic = false;
    state.phase = "LIVE";
    // Force an authoritative wall-clock pass: a replay whose last bucket is
    // already in the past folds forward via flat continuity (never a gap).
    state.lastSyncBucket = 0;
    state.projectionCache = null;
    state.lookaheadCache = null;

    // Silent — replay buckets are historical; they must not re-trigger /predict.
    if (state.live) {
      this.emitCandleUpdate(
        this.haLive(state) ?? { ...state.live },
        norm,
        this.timeframe,
      );
    }
    return {
      closed: [...state.closed],
      live: state.live ? { ...state.live } : null,
    };
  }

  /** True when a symbol is already tracked by the aggregation engine. */
  public hasSymbol(symbol: string): boolean {
    return this.symbols.has((symbol || "").trim().toUpperCase());
  }

  // ── Timeframe switching ──

  /**
   * Switch the active timeframe and instantly rebuild the series from the REAL
   * retained ticks (lossless re-bucketing) plus the REAL seeded history.
   * Reschedules the boundary timeout and syncs with wall-clock time.
   */
  public setTimeframe(timeframe: Timeframe): void {
    if (!isTimeframe(timeframe) || timeframe === this.timeframe) return;

    this.timeframe = timeframe;
    this.bucketMs = TIMEFRAME_MS[timeframe];
    // PARITY DEFAULT: `?? 0` re-anchors to the exact PO floor grid on switch.
    this.leadMs = this.leadTimeOffsetOverride ?? 0;

    for (const [symbol, state] of this.symbols.entries()) {
      const rebuilt = this.clampSeriesWicks(
        this.rebuild(state, this.bucketMs),
        state,
      );
      state.closed = rebuilt.slice(0, -1).slice(-this.maxCandles);
      this.reanchorPrevHa(state);
      state.live = rebuilt.length > 0 ? rebuilt[rebuilt.length - 1] : null;
      if (rebuilt.length > 0) {
        state.lastPrice = rebuilt[rebuilt.length - 1].close;
      }
      // Re-derive lifecycle + projection cache against the NEW grid: whatever
      // the previous materialisation was, the current bar starts as SYNTHETIC
      // (wall-clock flat) until a real tick on this grid flips it to LIVE.
      if (state.live) {
        state.phase = state.isLiveSynthetic ? "SYNTHETIC" : "LIVE";
      } else {
        state.phase = "IDLE";
      }
      state.projectionCache = null;
      state.lookaheadCache = null;
      // Force a fresh sync pass on the NEW grid (the cached lastSyncBucket was
      // computed against the OLD bucket width and would otherwise be skipped).
      state.lastSyncBucket = 0;
      // Silent — re-bucketing is a chart replay, not a live rollover; do not
      // fire onCandleClose (avoids a spurious /predict per re-bucket).
      if (state.live) {
        this.emitCandleUpdate(
          this.haLive(state) ?? { ...state.live },
          symbol,
          this.timeframe,
        );
      }
    }
  }

  /**
   * Merge the real tick-derived candles and the real seeded history into ONE
   * ascending continuous series by open time (target bucket grid).
   */
  private rebuild(state: SymbolState, bucketMs: number): Candle[] {
    const byTime = new Map<number, Candle>();
    for (const c of this.resampleHistoryCandles(state.history, bucketMs)) {
      byTime.set(c.timestamp, c);
    }
    for (const c of this.bucketTicks(state.ticks, bucketMs)) {
      byTime.set(c.timestamp, c);
    }
    if (byTime.size === 0 && state.live) {
      byTime.set(
        this.bucketForTimestamp(state.live.timestamp),
        state.live,
      );
    }
    return Array.from(byTime.values()).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
  }

  /**
   * Re-aggregate REAL historical candles into a COARSER bucket width.
   */
  private resampleHistoryCandles(
    candles: Candle[],
    targetMs: number,
  ): Candle[] {
    if (!Array.isArray(candles) || candles.length === 0) return [];

    // ── LEAD-AWARE RE-AGGREGATION ──
    // state.history stores RAW-grid, skew-corrected candles. Rebuilding to a
    // (usually coarser) grid must place each candle on the SAME lead-shifted
    // axis the live buckets occupy (bucketForTimestamp) — never a raw floor —
    // or the re-bucketed history lands one slot behind the forming candle
    // after a timeframe switch and the seam drops. Buckets are folded by the
    // strict lead-shifted open time; no path here can mix two x-axes.
    const out: Candle[] = [];
    let current: Candle | null = null;
    let currentOpenMs = -1;

    for (const c of candles) {
      if (!Number.isFinite(c.timestamp) || c.timestamp <= 0) continue;
      const target = this.bucketForTimestamp(c.timestamp);
      if (!Number.isFinite(target) || target <= 0) continue;
      if (!current || target !== currentOpenMs) {
        if (current) out.push(current);
        current = { ...c, timestamp: target };
        currentOpenMs = target;
      } else {
        current.high = Math.max(current.high, c.high, c.open, c.close);
        current.low = Math.min(current.low, c.low, c.open, c.close);
        current.close = c.close;
        current.volume += c.volume;
      }
    }
    if (current) out.push(current);
    return out;
  }

  /** Pure re-bucketing of the REAL tick series into aligned OHLCV candles. */
  private bucketTicks(ticks: LiveTick[], bucketMs: number): Candle[] {
    const out: Candle[] = [];
    let current: Candle | null = null;

    for (const tick of ticks) {
      // Lead-aware re-bucketing: a tick at raw T folds into the bucket that
      // begins at bucketStart(T + leadMs) — the exact same grid ingest() uses,
      // so a re-bucket (timeframe switch/rebuild) never shifts bars.
      const openTime = this.bucketForTimestamp(tick.timestamp);
      if (!current || openTime !== current.timestamp) {
        if (current) out.push(current);
        current = {
          timestamp: openTime,
          open: tick.price,
          high: tick.price,
          low: tick.price,
          close: tick.price,
          volume: tick.volume ?? 0,
        };
      } else {
        current.high = Math.max(current.high, tick.price);
        current.low = Math.min(current.low, tick.price);
        current.close = tick.price;
        current.volume += tick.volume ?? 0;
      }
    }
    if (current) out.push(current);
    return out;
  }

  // ── Read APIs for the chart layer ──

  private haLive(state: SymbolState): Candle | null {
    if (!state.live) return null;
    const { bar } = toHeikinAshiBar(state.live, state.prevHa);
    return { ...state.live, ...bar };
  }

  /** Closed candles plus the in-progress bar — NATIVE Heikin-Ashi, ready to hand to the chart. */
  public getSeries(symbol: string): Candle[] {
    const state = this.symbols.get((symbol || "").trim().toUpperCase());
    if (!state) return [];
    const rows: Candle[] = [];
    const raw = state.live
      ? [...state.closed, { ...state.live }]
      : [...state.closed];
    for (const c of raw) {
      if (!Number.isFinite(c.timestamp) || c.timestamp <= 0) continue;
      const prev = rows.length > 0 ? rows[rows.length - 1] : null;
      if (prev && c.timestamp <= prev.timestamp) continue;
      rows.push(c);
    }
    return toHeikinAshiSeries(rows);
  }

  /** The bar currently accumulating ticks, or null before the first tick. NATIVE Heikin-Ashi. */
  public getLiveCandle(symbol: string): Candle | null {
    const state = this.symbols.get(symbol.trim().toUpperCase());
    return state ? this.haLive(state) : null;
  }

  /** Exact expiry geometry for the live forming candle. */
  public getLiveCandleClose(nowMs?: number): {
    candleCloseMs: number;
    timeframeMs: number;
    remainingMs: number;
    groundedTsMs: number;
  } | null {
    const symbol = this.activeSymbol;
    const state = symbol ? this.symbols.get(symbol) : null;
    const live = state?.live;
    if (!live || !live.timestamp) return null;
    const now = nowMs != null && nowMs > 0 ? nowMs : this.timingNow();
    const groundedTsMs = this.bucketForTimestamp(live.timestamp);
    const candleCloseMs = groundedTsMs + this.bucketMs;
    const remainingMs = Math.max(0, candleCloseMs - now);
    return {
      candleCloseMs,
      timeframeMs: this.bucketMs,
      remainingMs,
      groundedTsMs,
    };
  }

  /** Debug surface for the aggregator (PO-parity diagnostics). */
  public getDebug(symbol: string): AggregatorDebug {
    const state = this.symbols.get((symbol || "").trim().toUpperCase());
    const projectionSlot0OffsetMs = this.leadMs > 0 ? this.leadMs : this.bucketMs;
    return {
      symbol: (symbol || "").trim().toUpperCase(),
      timeframe: this.timeframe,
      bucketMs: this.bucketMs,
      tickCount: state?.tickCount ?? 0,
      bucketWrites: state?.bucketWrites ?? 0,
      bucketsCreated: state?.bucketsCreated ?? 0,
      bucketsUpdated: state?.bucketsUpdated ?? 0,
      gapCount: state?.gapCount ?? 0,
      historyRejectedCount: state?.historyRejectedCount ?? 0,
      historyLiveRejected: state?.historyLiveRejected ?? 0,
      projectionSlot0OffsetMs,
    };
  }

  /** Real tick price (RAW — NOT Heikin-Ashi close) for price lines and projections. */
  public getLastPrice(symbol: string): number {
    const state = this.symbols.get(symbol.trim().toUpperCase());
    return state && state.lastPrice > 0 ? state.lastPrice : 0;
  }

  /**
   * SYSTEMATIC-SKEW GRID NORMALIZATION — when the whole seeded series sits
   * AHEAD of the active lead-shifted session tip by a whole bucket multiple
   * (at least SEED_SKEW_MIN_BARS agree, at least SEED_SKEW_AHEAD_SHARE of
   * them), shift EVERY bar back by that multiple so the history chain and the
   * live buckets share one grid. The reference tip is the LIVE-GRID TIP
   * (bucketForTimestamp(upstream) when a tick has established the clock, else
   * the wall-clock lead grid) so the phase comparison is always between two
   * bucket-aligned values — never polluted by the sub-minute residue of
   * `Date.now()` that made the previous median-offset check fire only by luck.
   * Genuine isolated anomalies are left untouched (the chart's own future
   * filter drops stray far-future bars it cannot place).
   *
   * The reference clock is the upstream PO-aligned epoch (timingNow) when it
   * exists, falling back to real wall-clock (Date.now()) before the first tick
   * arrives. This aligns the detection with the SAME clock the live aggregator
   * uses for its buckets, so a server-vs-wall skew in the /predict candle
   * source is corrected into the correct live-grid region.
   */
  private normalizeSeedGrid(candles: Candle[]): Candle[] {
    if (!Array.isArray(candles)) return [];
    const clean = candles
      .filter((c) => Number.isFinite(c.timestamp) && c.timestamp > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (clean.length < SEED_SKEW_MIN_BARS) return clean;

    const refNow = this.timingNow() > 0 ? this.timingNow() : Date.now();
    const liveTipGrid = this.bucketForTimestamp(refNow);
    const shiftMs = detectSystematicSeedSkew(clean, liveTipGrid, this.bucketMs);
    if (shiftMs > 0) {
      const buckets = Math.round(shiftMs / this.bucketMs);
      console.warn(
        `[Aggregator] Re-anchored systematic seed-grid skew: ` +
          `${clean.length} bars shifted back ${buckets} bucket(s) ` +
          `(${(shiftMs / 1000).toFixed(0)}s)`,
      );
      return clean.map((c) => ({ ...c, timestamp: c.timestamp - shiftMs }));
    }
    return clean;
  }

  /** Robust median of an unsorted numeric array (0 for an empty input). */
  private medianOf(nums: number[]): number {
    if (nums.length === 0) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
  }

  private recomputeVol(state: SymbolState): void {
    const n = state.recentPrices.length;
    if (n < 2) return;
    const median = this.medianOf(state.recentPrices);
    let dev = 0;
    for (let i = 0; i < n; i++) {
      dev += Math.abs(state.recentPrices[i] - median);
    }
    state.volMedian = median;
    state.volScale = Math.max(
      (dev / n) * MAD_TO_SIGMA,
      Math.abs(median) * 1e-4,
      1e-8,
    );
  }

  private trackVol(symbol: string, price: number): void {
    const state = this.symbols.get((symbol || "").trim().toUpperCase());
    if (!state) return;
    if (state.volScale > 0 && state.volMedian > 0) {
      const band = state.volScale * LIVE_TICK_CLAMP_SIGMA;
      if (price > state.volMedian + band || price < state.volMedian - band) {
        const side = price > state.volMedian + band ? 1 : -1;
        if (state.volSide === side) {
          state.volStreak += 1;
        } else {
          state.volStreak = 1;
          state.volSide = side;
        }
        if (state.volStreak < 2) return;
      } else {
        state.volStreak = 0;
        state.volSide = 0;
      }
    }
    state.recentPrices.push(price);
    if (state.recentPrices.length > LIVE_VOL_WINDOW) {
      state.recentPrices.splice(0, state.recentPrices.length - LIVE_VOL_WINDOW);
    }
    this.recomputeVol(state);
  }

  private seedVolWindow(symbol: string, prices: number[]): void {
    const state = this.symbols.get((symbol || "").trim().toUpperCase());
    if (!state || !Array.isArray(prices)) return;
    const clean = prices.filter((p) => Number.isFinite(p) && p > 0);
    if (clean.length < 2) return;
    state.recentPrices = clean.slice(-LIVE_VOL_WINDOW);
    state.volStreak = 0;
    state.volSide = 0;
    this.recomputeVol(state);
  }

  private previousCloseOf(symbol: string): number {
    const s = (symbol || "").trim().toUpperCase();
    const state = this.symbols.get(s);
    if (!state) return 0;
    if (state.live && state.live.close > 0) return state.live.close;
    if (state.closed.length > 0)
      return state.closed[state.closed.length - 1].close;
    return state.lastPrice > 0 ? state.lastPrice : 0;
  }

  private clampSeriesWicks(candles: Candle[], state: SymbolState): Candle[] {
    if (candles.length < CANDLE_WICK_GUARD_MIN_N) return candles;
    const spreads = candles
      .map((c) =>
        Number.isFinite(c.high) && Number.isFinite(c.low)
          ? Math.max(0, c.high - c.low)
          : NaN,
      )
      .filter(Number.isFinite);
    if (spreads.length < CANDLE_WICK_GUARD_MIN_N) return candles;
    const baseSpread = this.medianOf(spreads);
    if (!(baseSpread > 0)) return candles;
    const clampBand = baseSpread * CANDLE_WICK_CLAMP_MULT;
    let clamped = 0;
    const out = candles.map((c) => {
      if (!Number.isFinite(c.high) || !Number.isFinite(c.low)) return c;
      const spread = c.high - c.low;
      if (spread <= baseSpread * CANDLE_WICK_OUTLIER_MULT) return c;
      const top = Math.max(c.open, c.close);
      const bottom = Math.min(c.open, c.close);
      clamped += 1;
      return {
        ...c,
        high: Math.min(c.high, top + clampBand),
        low: Math.max(c.low, bottom - clampBand),
      };
    });
    if (clamped > 0) {
      console.warn(
        `[Aggregator] Clamped ${clamped} outlier wick(s) during rebuild ` +
          `(base spread ${baseSpread.toFixed(6)})`,
      );
    }
    return out;
  }

  /**
   * OUTLIER-WICK PURGE for SEEDED CANDLES (runs BEFORE any bucket folding).
   * A single corrupted historical bar (dropped tape reprint / spurious blob)
   * would otherwise fold its far high/low into the opening chain as a false
   * drop/spike. Any candle whose high-low spread exceeds
   * CANDLE_WICK_OUTLIER_MULT × the series' MEDIAN spread is an outlier wick:
   * its high/low are clamped into a sane band (CANDLE_WICK_CLAMP_MULT × spread
   * beyond its own open/close extremes) — never a fabricated level, and only
   * when enough candles exist for the median to be a trustworthy baseline.
   */
  private sanitizeSeedWicks(candles: Candle[], symbol: string): Candle[] {
    if (candles.length < CANDLE_WICK_GUARD_MIN_N) return candles;
    const spreads = candles
      .map((c) =>
        Number.isFinite(c.high) && Number.isFinite(c.low)
          ? Math.max(0, c.high - c.low)
          : NaN,
      )
      .filter(Number.isFinite);
    if (spreads.length < CANDLE_WICK_GUARD_MIN_N) return candles;
    const baseSpread = this.medianOf(spreads);
    if (!(baseSpread > 0)) return candles;
    const clampBand = baseSpread * CANDLE_WICK_CLAMP_MULT;
    let clamped = 0;
    const out = candles.map((c) => {
      if (!Number.isFinite(c.high) || !Number.isFinite(c.low)) return c;
      const spread = c.high - c.low;
      if (spread <= baseSpread * CANDLE_WICK_OUTLIER_MULT) return c;
      const top = Math.max(c.open, c.close);
      const bottom = Math.min(c.open, c.close);
      clamped += 1;
      return {
        ...c,
        high: Math.min(c.high, top + clampBand),
        low: Math.max(c.low, bottom - clampBand),
      };
    });
    if (clamped > 0) {
      console.warn(
        `[Aggregator] Clamped ${clamped} outlier wick(s) in seeded history ` +
          `for ${symbol} (base spread ${baseSpread.toFixed(6)})`,
      );
    }
    return out;
  }

  /**
   * LEAD-GRID ALIGNMENT — place candles on the ACTIVE predictive-lead grid
   * (`bucketForTimestamp`), folding duplicate buckets into one candle (open of
   * the first bar, high/low unioned, close of the last bar, volume summed).
   * Both `seedHistory` and the timeframe-switch rebuild route their history
   * through this so the seeded chain and the live/replay buckets share ONE
   * lead-shifted x-axis. Stored as the "closed" series consumed by getSeries.
   */
  private leadAlignCandles(
    candles: Candle[],
  ): Candle[] {
    const byTs = new Map<number, Candle>();
    for (const c of candles) {
      if (!Number.isFinite(c.timestamp) || c.timestamp <= 0) continue;
      const target = this.bucketForTimestamp(c.timestamp);
      if (!Number.isFinite(target) || target <= 0) continue;
      const existing = byTs.get(target);
      if (!existing) {
        byTs.set(target, { ...c, timestamp: target });
        continue;
      }
      existing.high = Math.max(
        existing.high,
        c.high,
        c.open,
        c.close,
        existing.open,
        existing.close,
      );
      existing.low = Math.min(
        existing.low,
        c.low,
        c.open,
        c.close,
        existing.open,
        existing.close,
      );
      existing.close = c.close;
      existing.volume += c.volume;
    }
    return Array.from(byTs.values()).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
  }

  /** Milliseconds remaining until the active bucket closes (countdown).
   *  Uses the predictive lead clock so the countdown reflects the LEADING
   *  boundary — the candle closes and /predict fires when this hits zero.
   *  Derived from the exact boundary geometry (never a modulo side-effect). */
  public msUntilClose(): number {
    return this.leadGeometry().boundaryIn;
  }

  /**
   * Exact expiry geometry for the ACTIVE bucket on the predictive clock:
   * bucket open/close instants, countdown, and 0..1 progress. The chart and
   * trade clock consume this directly so their countdown is grid-locked to
   * the precise expiry timing requested, independent of any external feed.
   */
  public getBoundary(): BoundaryGeometry {
    return this.leadGeometry();
  }

  /** Lifecycle phase of a symbol's in-progress candle (IDLE/SYNTHETIC/LIVE). */
  public getPhase(symbol: string): CandlePhase {
    return this.symbols.get(symbol.trim().toUpperCase())?.phase ?? "IDLE";
  }

  /**
   * Pre-register an arbitrary set of currency pairs (all 34+ OTC symbols) so
   * the wall-clock engine indexes their bucket grid IMMEDIATELY, before their
   * first tick ever lands. A pair that has previously seen a real price gets
   * its live bucket opened synchronously (phase SYNTHETIC); an untouched pair
   * stays IDLE — honestly, with no fabricated price — but its first late tick
   * folds straight into the exact boundary-aligned bucket with zero feed
   * handshake. This is what disconnects candle formation from external-feed
   * latency: once ANY real price exists, the bar state is computed and locked
   * by the local engine alone.
   */
  public registerSymbols(symbols: string[]): number {
    let added = 0;
    for (const raw of symbols) {
      const norm = (raw || "").trim().toUpperCase();
      if (!norm) continue;
      if (!this.symbols.has(norm)) added++;
      this.ensure(norm);
    }
    if (added > 0) {
      // Open/refresh live buckets for every registered pair that has a price
      // reference, all on the same leading grid instant (feed-independent).
      this.syncWallClockSilent();
    }
    return this.symbols.size;
  }

  /**
   * PRIME A PAIR WITH A REAL OBSERVED PRICE (e.g. the /predict `current_price`
   * served by the backend) when no live tick has landed for it yet.
   *
   * This is the last missing link of the autonomous engine: a freshly selected
   * pair whose WebSocket tape has not delivered its first tick — and which has
   * no seeded history — previously stayed IDLE with a blank chart. Calling this
   * with a GENUINE backend-observed price (never a synthetic/RNG value) gives
   * the pair a legitimate price reference, immediately opening its SYNTHETIC
   * live bucket on the exact leading boundary via syncWallClockSilent — the
   * chart paints its first flat data-driven bar the moment the prediction
   * response lands, decoupled from passive tick-waiting. The first REAL tick
   * then morphs it in place (isLiveSynthetic → LIVE), overwriting the flat
   * silhouette with 100% market data.
   *
   * Guard rails: idempotent per pair, and NEVER overwrites a fresher real tick
   * reference (`lastPrice` already > 0) with a possibly older HTTP price.
   */
  public primePrice(symbol: string, price: number): void {
    const norm = (symbol || "").trim().toUpperCase();
    const p = Number(price);
    if (!norm || !(Number.isFinite(p) && p > 0)) return;
    const state = this.ensure(norm);
    if (state.lastPrice > 0) return;
    state.lastPrice = p;
    // zeroFabrication: hold the genuine observed price reference only — the
    // first REAL tick opens the bucket. Legacy mode opens a synthetic live
    // bucket immediately via the wall-clock sync.
    if (!this.zeroFabrication) {
      this.syncWallClockSilent();
    }
  }

  /**
   * LEADING (PREDICTIVE) PROJECTION — anticipates the ACTIVE bucket's close
   * from the real tick stream, so the platform draws ahead of external feeds.
   *
   * Real-data-driven: fits a RECENCY-WEIGHTED least-squares momentum line to
   * the retained real ticks inside the active-bucket window (current bucket +
   * the two preceding ones) and extends the drift to the bucket's close
   * instant. Recent ticks dominate the fit, so on a sustained move the
   * projection reaches BEYOND the last confirmed print — a true leading edge.
   * The result is clamped into a sanity band around recent realised prices so
   * a burst tick can never explode the projection past plausible movement.
   *
   * AHEAD-OF-SYNC CLOCK: the default instant is the PREDICTIVE LEAD clock
   * (system time + leadMs), so the returned target sits ~170ms ahead of real
   * sync and always aims at the EXPIRATION boundary (bucketOpen + bucketMs) —
   * exactly the timing requested, never "current time". Progress/remaining are
   * the strict numerical mapping of that geometry.
   *
   * PRE-TICK CONTINUITY: with fewer than two retained ticks (fresh pair, dead
   * tape) the projection degrades to a FLAT closing line at the last real
   * price — the leading target is defined from the very first bar of a pair
   * and keeps converging instead of vanishing until the tape wakes up.
   *
   * Pure & synchronous — a cheap O(window) scan, no React, and (via
   * getCachedProjection) cache-throttled for frame-rate reads. It NEVER
   * mutates the real OHLC series — it is a forecast only.
   */
  public getProjection(
    symbol: string,
    nowMs: number = this.timingNow(),
  ): LeadingProjection | null {
    const state = this.symbols.get(symbol.trim().toUpperCase());
    if (!state || !state.live) return null;

    const now = nowMs > 0 ? nowMs : this.timingNow();
    // LEAD-FORWARD GEOMETRY: the projected candle's window and expiry are
    // computed on the SAME axis the live candle actually occupies
    // (leadShiftBucket), so the leading marker targets the EXACT leading
    // bucket the candle grid renders at — never a raw-clock bucket one
    // timeframe behind it.
    const geo = this.leadGeometry(now);
    const bucketOpenMs = geo.bucketOpen;
    const bucketCloseMs = geo.bucketClose;

    // ── PRE-TICK FLAT PROFILE (SYNTHETIC phase / quiet tape) ──
    // A flat leading target pinned to the last real traded price. Zero
    // momentum, but a well-defined unit (open=high=low=close) that the
    // generator can draw instantly — no dead frames while awaiting ticks.
    const ticks = state.ticks;
    const refPrice =
      state.lastPrice > 0
        ? state.lastPrice
        : state.live.close > 0
          ? state.live.close
          : 0;
    if (ticks.length < 2) {
      if (!(refPrice > 0)) return null;
      const ref =
        state.volScale > 0 && state.volMedian > 0
          ? clampSpot(
              refPrice,
              state.volMedian,
              state.volScale,
              PROJECTION_CLAMP_SIGMA,
            )
          : refPrice;
      return {
        close: ref,
        high: Math.max(state.live.high, ref),
        low: Math.min(state.live.low, ref),
        slopePerMs: 0,
        computedAt: now,
        bucketOpen: bucketOpenMs,
        bucketClose: bucketCloseMs,
        remainingMs: geo.boundaryIn,
        progress: geo.progress,
      };
    }
    if (!(refPrice > 0)) return null;

    const windowStart = bucketOpenMs - this.bucketMs * 2;
    const decaySpan = Math.max(this.bucketMs * 0.5, 5_000);

    // ── Recency-weighted least-squares price-vs-time fit ──
    // Weights decay exponentially away from `now`, so the freshest momentum
    // steers the line (the projection leads the last print on trends). The
    // window is capped at MAX_FIT_TICKS so a dense tick burst can never turn
    // the leading-marker path into an O(5000) scan per tick/frame.
    // Timestamps are SHIFTED by the bucket pivot before the fit: raw epoch-
    // millisecond x-values (≈1.8e12) cancel catastrophically in the weighted
    // sums, corrupting the slope; pivoting keeps x ≈ [window] and the fit
    // numerically exact. A slope is translation-invariant, so this is free.
    const MAX_FIT_TICKS = 320;
    const pivot = bucketOpenMs;
    let sumW = 0;
    let sumWx = 0;
    let sumWy = 0;
    let sumWxx = 0;
    let sumWxy = 0;
    let examined = 0;
    for (let i = ticks.length - 1; i >= 0; i--) {
      const t = ticks[i];
      if (t.timestamp < windowStart) break;
      if (++examined > MAX_FIT_TICKS) break;
      const x = t.timestamp - pivot;
      const w = Math.exp(-(now - t.timestamp) / decaySpan);
      sumW += w;
      sumWx += w * x;
      sumWy += w * t.price;
      sumWxx += w * x * x;
      sumWxy += w * x * t.price;
    }
    if (sumW <= 0) return null;

    const denom = sumW * sumWxx - sumWx * sumWx;
    if (denom === 0) return null;
    const slopePerMs = (sumW * sumWxy - sumWx * sumWy) / denom;
    const intercept = (sumWy - slopePerMs * sumWx) / sumW;

    // ── LEADING EXTRAPOLATION TO BUCKET CLOSE ──
    // Extend the fitted drift forward to the bucket's close instant, so the
    // projection arrives at an UNCONFIRMED close BEFORE the candle finishes.
    const lsProj = intercept + slopePerMs * (bucketCloseMs - pivot);

    // ── INSTANT-VELOCITY PULSE (preemptive last-print reaction) ──
    // The recency-weighted fit is smooth, but the SINGLE freshest print can
    // carry momentum the fit has not yet absorbed (a burst on the tape). When
    // the last two real ticks show an instantaneous velocity clearly stronger
    // than the fitted trend, the projection is biased toward that velocity —
    // so the leading marker reacts the SAME frame the burst lands, drawing
    // AHEAD of feeds that only move when a candle confirms. Blended 50/50 and
    // still clamped inside the sanity band below, so noise can't yank the lead.
    let lead = lsProj;
    const lastTick = ticks[ticks.length - 1];
    const prevTick = ticks.length >= 2 ? ticks[ticks.length - 2] : null;
    if (lastTick && prevTick) {
      const dt = lastTick.timestamp - prevTick.timestamp;
      if (dt > 0) {
        const v = (lastTick.price - prevTick.price) / dt;
        if (
          Number.isFinite(v) &&
          Math.abs(v) > Math.abs(slopePerMs) * 1.1 &&
          v !== 0
        ) {
          lead =
            (lsProj +
              (lastTick.price + v * (bucketCloseMs - lastTick.timestamp))) /
            2;
        }
      }
    }

    let close = lead;
    if (state.volScale > 0 && state.volMedian > 0) {
      close = clampSpot(
        lead,
        state.volMedian,
        state.volScale,
        PROJECTION_CLAMP_SIGMA,
      );
    } else {
      const recent = ticks.slice(-Math.min(ticks.length, 30));
      let hi = -Infinity;
      let lo = Infinity;
      for (const t of recent) {
        if (t.price > hi) hi = t.price;
        if (t.price < lo) lo = t.price;
      }
      hi = Math.max(hi, state.live.high);
      lo = Math.min(lo, state.live.low);
      const band = Math.max(hi - lo, 1e-8) * 1.5;
      close = Math.min(Math.max(lead, lo - band), hi + band);
    }

    return {
      close,
      high: Math.max(state.live.high, close),
      low: Math.min(state.live.low, close),
      slopePerMs,
      computedAt: now,
      bucketOpen: bucketOpenMs,
      bucketClose: bucketCloseMs,
      remainingMs: geo.boundaryIn,
      progress: geo.progress,
    };
  }

  /**
   * Cache-throttled leading projection for frame-rate reads. Recomputation
   * (the weighted fit) is at most every PROJECTION_CACHE_MS per tick-clean
   * pass; the cache is invalidated on every tick and bucket rollover so burst
   * reactivity stays exact. The chart's rAF loop uses this instead of a raw
   * O(window) scan per frame — the projection stays fluid with near-zero cost.
   */
  public getCachedProjection(
    symbol: string,
    nowMs: number = this.timingNow(),
  ): LeadingProjection | null {
    const state = this.symbols.get(symbol.trim().toUpperCase());
    if (!state) return null;
    const now = nowMs > 0 ? nowMs : this.timingNow();
    const cached = state.projectionCache;
    if (cached && now - cached.at < PROJECTION_CACHE_MS) return cached.value;
    const value = this.getProjection(symbol, now);
    state.projectionCache = { at: now, value };
    return value;
  }

  // ── Predictive Lookahead Timeframe (forward-projecting target candles) ──

  /**
   * Set the predictive lookahead horizon (1m | 2m | 3m | 5m). How far AHEAD of
   * the external platform's timeline the aggregator pre-renders projected
   * target candles. Invalidates every symbol's series cache so the next read /
   * projector beat recomputes at the new horizon.
   */
  public setLookaheadHorizon(minutes: LookaheadHorizonMinutes): void {
    const m = Number(minutes);
    const clamped = (LOOKAHEAD_HORIZON_OPTIONS as number[]).includes(m)
      ? (m as LookaheadHorizonMinutes)
      : DEFAULT_LOOKAHEAD_HORIZON;
    if (clamped === this.lookaheadHorizon) return;
    this.lookaheadHorizon = clamped;
    for (const state of this.symbols.values()) {
      state.lookaheadCache = null;
    }
  }

  public getLookaheadHorizon(): LookaheadHorizonMinutes {
    return this.lookaheadHorizon;
  }

  /**
   * COMPUTE the forward-lookahead target-candle series for a symbol.
   *
   * Pure and synchronous: extrapolates the LIVE bucket's real momentum drift
   * (the same recency-weighted least-squares fit behind getProjection) across
   * the next `horizonMinutes` of wall-clock bucket boundaries, tapering the
   * drift toward mean reversion and expanding each projected wick with
   * √(distance) so distant candles stay plausible without exploding. Every
   * candle is anchored to a REAL grid slot (`liveBucketOpen + k*bucketMs`) —
   * the exact slots the external platform has NOT yet rendered. When the tape
   * has <2 real ticks the series degrades to a flat hold at the last real
   * price (honest continuity, never fabricated).
   *
   * Returns null only when the pair has no live reference price at all.
   */
  public getLookaheadSeries(
    symbol: string,
    minutes?: LookaheadHorizonMinutes,
    nowMs: number = this.timingNow(),
  ): LookaheadEvent | null {
    const norm = (symbol || "").trim().toUpperCase();
    const state = this.symbols.get(norm);
    if (!state || !state.live) return null;

    const now = nowMs > 0 ? nowMs : this.timingNow();
    const horizon =
      minutes != null &&
      (LOOKAHEAD_HORIZON_OPTIONS as number[]).includes(Number(minutes))
        ? (minutes as LookaheadHorizonMinutes)
        : this.lookaheadHorizon;
    const bucketCount = Math.max(
      1,
      Math.round((horizon * 60_000) / this.bucketMs),
    );

    const anchor = { ...state.live };
    const refPrice =
      state.lastPrice > 0
        ? state.lastPrice
        : anchor.close > 0
          ? anchor.close
          : 0;
    if (!(refPrice > 0)) return null;

    // ── Momentum drift from the real tape (recency-weighted least squares) ──
    let slope = 0;
    let realizedRange = 0;
    const proj = this.getProjection(norm, now);
    if (proj) {
      slope = proj.slopePerMs;
      realizedRange = Math.max(proj.high - proj.low, 1e-8);
    } else {
      // No projection (fresh pair): derive a conservative drift from the last
      // two real ticks if present, else a flat hold.
      const ticks = state.ticks;
      if (ticks.length >= 2) {
        const last = ticks[ticks.length - 1];
        const prev = ticks[ticks.length - 2];
        const dt = last.timestamp - prev.timestamp;
        if (dt > 0) slope = (last.price - prev.price) / dt;
      }
      const hi = Math.max(anchor.high, refPrice);
      const lo = Math.min(anchor.low, refPrice);
      realizedRange = Math.max(hi - lo, 1e-8);
    }

    // Scale-invariant momentum ratio: |slope| against the recent range rate.
    const rangeRate = realizedRange / this.bucketMs;
    const momentumRatio = Math.abs(slope) / (rangeRate + 1e-12);
    const baseConfidence = Math.max(
      0.4,
      Math.min(0.97, 0.55 + 0.45 * momentumRatio),
    );

    const volScale =
      state.volScale > 0 ? state.volScale : Math.max(realizedRange, 1e-8);

    const candles: LookaheadCandle[] = [];
    let prevClose = proj ? proj.close : refPrice;
    const anchorOpen = bucketStart(anchor.timestamp, this.bucketMs);
    for (let k = 1; k <= bucketCount; k++) {
      const taper = Math.pow(LOOKAHEAD_TAPER_TAU, k);
      const drift = slope * this.bucketMs * k * taper;
      const open = prevClose;
      const close = open + drift;
      // ATR-scaled wick expansion — grows with √(distance) so the projected
      // body keeps a plausible range without exploding on distant buckets.
      const wick = Math.min(
        volScale * LOOKAHEAD_WICK_MULT * Math.sqrt(k),
        volScale * LOOKAHEAD_WICK_MAX_SIGMA,
      );
      const strength = Math.max(
        0,
        baseConfidence * Math.pow(LOOKAHEAD_STRENGTH_DECAY, k),
      );
      let high = Math.max(open, close) + wick;
      let low = Math.min(open, close) - wick;
      if (state.volScale > 0 && state.volMedian > 0) {
        high = Math.min(
          high,
          Math.max(
            state.volMedian +
              state.volScale * (LOOKAHEAD_CLAMP_SIGMA + k * 0.08),
            Math.max(open, close),
          ),
        );
        low = Math.max(
          low,
          Math.min(
            state.volMedian -
              state.volScale * (LOOKAHEAD_CLAMP_SIGMA + k * 0.08),
            Math.min(open, close),
          ),
        );
      }
      candles.push({
        timestamp: anchorOpen + k * this.bucketMs,
        open,
        high,
        low,
        close,
        volume: 0,
        ahead: k,
        projectionStrength: Number(strength.toFixed(3)),
      });
      prevClose = close;
    }

    return {
      symbol: norm,
      timeframe: this.timeframe,
      horizonMinutes: horizon,
      computedAt: now,
      anchorCandle: anchor,
      candles,
    };
  }

  /**
   * Cache-throttled lookahead series for frame-rate reads — recomputed at most
   * every PROJECTION_CACHE_MS per tick-clean pass, invalidated on every tick /
   * rollover / horizon change.
   */
  public getCachedLookahead(
    symbol: string,
    minutes?: LookaheadHorizonMinutes,
    nowMs: number = this.timingNow(),
  ): LookaheadEvent | null {
    const state = this.symbols.get(symbol.trim().toUpperCase());
    if (!state) return null;
    const now = nowMs > 0 ? nowMs : this.timingNow();
    const horizon =
      minutes != null &&
      (LOOKAHEAD_HORIZON_OPTIONS as number[]).includes(Number(minutes))
        ? (minutes as LookaheadHorizonMinutes)
        : this.lookaheadHorizon;
    const cached = state.lookaheadCache;
    if (cached && now - cached.at < PROJECTION_CACHE_MS) return cached.value;
    const value = this.getLookaheadSeries(symbol, horizon, now);
    state.lookaheadCache = { at: now, value };
    return value;
  }

  // ── Self-Driving Projector (forward-looking buffer) ──

  /**
   * Register which pair the projector loop should drive. The store calls this
   * on mount and on every pair switch so the LEADING target keeps drifting on
   * the active symbol even between ticks (PROJECTION_DRIFT_MS cadence).
   */
  public setActiveSymbol(symbol?: string | null): void {
    this.activeSymbol = (symbol || "").trim().toUpperCase();
  }

  /**
   * Subscribe to the self-driving projection stream. The aggregator recomputes
   * the ACTIVE pair's leading projection on its own cadence (PROJECTION_DRIFT_MS)
   * and broadcasts it — a forward-looking buffer any host can latch onto
   * without polling, and the single computational heart the chart renders from.
   * Returns an unsubscribe.
   */
  public subscribeProjection(fn: (event: ProjectionEvent) => void): () => void {
    this.projectionSubscribers.add(fn);
    return () => {
      this.projectionSubscribers.delete(fn);
    };
  }

  public startProjector(): void {
    if (typeof window === "undefined") return;
    this.stopProjector();
    this.projectorTimer = setInterval(() => {
      try {
        this.emitProjection();
      } catch {
        // The leading-emission path must never break the aggregator.
      }
    }, PROJECTION_DRIFT_MS);
  }

  private stopProjector(): void {
    if (this.projectorTimer) {
      clearInterval(this.projectorTimer);
      this.projectorTimer = null;
    }
  }

  private emitProjection(): void {
    const symbol = this.activeSymbol;
    if (!symbol) return;
    const state = this.symbols.get(symbol);

    // ── PROJECTOR-DRIVEN WALL-CLOCK SYNC ──
    // The self-driving projector beat ALSO advances the wall-clock engine:
    // bucket rollovers are detected + painted on this cadence even if the 100ms
    // heartbeat interval is throttled (e.g. a backgrounded tab), and the O(1)
    // lastSyncBucket skip keeps the redundant call idempotent. A rollover
    // here emits the freshly opened candle through emitCandleUpdate before the
    // projection frame is broadcast, so the chart paints the new live bar in
    // the same call stack.
    try {
      this.syncWallClock();
    } catch {
      // A projector-beat sync hiccup must never break the leading emission.
    }

    const hasLive = !!state?.live;
    const event: ProjectionEvent = {
      symbol,
      timeframe: this.timeframe,
      // IDLE pairs still emit geometry-only events (projection: null) so the
      // boundary grid stays locked and any host keeps its countdown from the
      // very first frame — never a dead space while awaiting the first price.
      phase: hasLive ? (state?.phase ?? "IDLE") : "IDLE",
      geometry: this.getBoundary(),
      projection: hasLive
        ? this.getCachedProjection(symbol, this.timingNow())
        : null,
    };
    for (const fn of this.projectionSubscribers) {
      try {
        fn(event);
      } catch {
        // A projection subscriber must never break the projector loop.
      }
    }
    try {
      this.onProjection?.(event);
    } catch {
      // Same for the store/host callback.
    }

    // ── FORWARD-LOOKAHEAD BROADCAST ──
    // Same projector beat pre-renders the ACTIVE pair's target candles ahead of
    // the live timeline and fans them to lookahead subscribers — the chart's
    // lookahead series outruns the external feed by the configured horizon on
    // the same silent-tape cadence.
    if (hasLive && state) {
      const lookahead = this.getCachedLookahead(symbol, this.lookaheadHorizon);
      if (lookahead) {
        this.emitLookahead(lookahead);
      }
    }
  }

  // ── Lifecycle ──

  public reset(symbol?: string): void {
    if (symbol) {
      this.symbols.delete(symbol.trim().toUpperCase());
    } else {
      this.symbols.clear();
    }
  }

  public destroy(): void {
    this.stopHeartbeat();
    this.stopProjector();
    if (typeof document !== "undefined" && this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = undefined;
    }
  }

  private ensure(symbol: string): SymbolState {
    let state = this.symbols.get(symbol);
    if (!state) {
      state = {
        ticks: [],
        closed: [],
        history: [],
        live: null,
        lastPrice: 0,
        isLiveSynthetic: false,
        lastSyncBucket: 0,
        phase: "IDLE",
        projectionCache: null,
        lookaheadCache: null,
        prevHa: null,
        recentPrices: [],
        volMedian: 0,
        volScale: 0,
        volStreak: 0,
        volSide: 0,
        tickCount: 0,
        bucketWrites: 0,
        bucketsCreated: 0,
        bucketsUpdated: 0,
        gapCount: 0,
        historyRejectedCount: 0,
        historyLiveRejected: 0,
      };
      this.symbols.set(symbol, state);
    }
    return state;
  }
}

export default RealtimeCandleAggregator;
