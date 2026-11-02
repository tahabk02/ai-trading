export type IntraCandleBoundaryKind =
  | "resistance"
  | "bollinger_upper"
  | "support"
  | "bollinger_lower"
  | null;

export type IntraCandleSide = "upper" | "lower" | null;
export type PullbackSignal = "CALL" | "PUT" | null;
export type PullbackEntryTiming = "now" | "wait" | "none";

export interface IntraCandleOhlc {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface IntraCandleTick {
  tsMs: number;
  price: number;
}

export interface WickMetrics {
  upperWickRatio: number;
  lowerWickRatio: number;
  bodyRatio: number;
  range: number;
  direction: "up" | "down" | "flat";
}

export interface BollingerBand {
  middle: number;
  upper: number;
  lower: number;
  percentB: number;
  bandwidthPct: number;
  sampleCount: number;
}

export interface IntraCandleVelocity {
  available: boolean;
  delta5: number;
  delta15: number;
  velocity5: number;
  velocity15: number;
  prior5Velocity: number;
  acceleration: number;
  atrNormalizedMove: number;
  spike: boolean;
  decelerating: boolean;
  direction: "up" | "down" | "flat";
  sampleCount: number;
  window5s: number;
  window15s: number;
}

export interface IntraCandleFeatures {
  available: boolean;
  symbol: string;
  timeframe: string;
  generatedAtMs: number;
  forming: {
    open: number;
    high: number;
    low: number;
    close: number;
    range: number;
    direction: "up" | "down" | "flat";
  };
  wick: WickMetrics;
  atr: number;
  atrTimeframe: string;
  atrSource: "micro" | "forming" | "unavailable";
  boundaries: {
    support: number | null;
    resistance: number | null;
    bollingerUpper: number | null;
    bollingerMiddle: number | null;
    bollingerLower: number | null;
    tolerance: number;
    boundaryKind: IntraCandleBoundaryKind;
    distanceToBoundary: number | null;
  };
  velocity: IntraCandleVelocity;
  exhaustion: {
    detected: boolean;
    side: IntraCandleSide;
    direction: "up" | "down" | "flat";
    spike: boolean;
    decelerating: boolean;
    atrNormalizedMove: number;
  };
  wickRejection: {
    alert: boolean;
    side: IntraCandleSide;
    wickRatio: number;
    threshold: number;
    nearBoundary: boolean;
    boundaryKind: IntraCandleBoundaryKind;
  };
  pullback: {
    signal: PullbackSignal;
    side: IntraCandleSide;
    confidence: number;
    score: number;
    entryTiming: PullbackEntryTiming;
    entryPrice: number | null;
    tierEligible: boolean;
    m1Pullback: boolean;
    reason: string;
  };
  confluence: {
    microValidated: boolean;
    microRejection: boolean;
    tapeReversal: boolean;
    microTimeframe: string;
    timeframe: string;
    score: number;
    tierEligible: boolean;
  };
}

export interface IntraCandleInput {
  symbol: string;
  timeframe: string;
  nowMs: number;
  forming: IntraCandleOhlc;
  closed: IntraCandleOhlc[];
  microForming?: IntraCandleOhlc | null;
  microClosed?: IntraCandleOhlc[];
  tape?: IntraCandleTick[];
  atrPeriod?: number;
  wickThreshold?: number;
}

const EPS = 1e-12;
const DEFAULT_ATR_PERIOD = 20;
const DEFAULT_WICK_THRESHOLD = 0.55;
const BOLLINGER_PERIOD = 20;
const BOLLINGER_MULTIPLIER = 2;
const MIN_BOLLINGER_SAMPLES = 5;
const MAX_VELOCITY_WINDOW_MS = 20_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function computeWickMetrics(candle: IntraCandleOhlc): WickMetrics {
  const range = candle.high - candle.low;
  if (!Number.isFinite(range) || range <= EPS) {
    return {
      upperWickRatio: 0,
      lowerWickRatio: 0,
      bodyRatio: 0,
      range: 0,
      direction: "flat",
    };
  }
  const bodyTop = Math.max(candle.open, candle.close);
  const bodyBottom = Math.min(candle.open, candle.close);
  const upper = Math.max(0, candle.high - bodyTop);
  const lower = Math.max(0, bodyBottom - candle.low);
  return {
    upperWickRatio: clamp(upper / range, 0, 1),
    lowerWickRatio: clamp(lower / range, 0, 1),
    bodyRatio: clamp(Math.abs(candle.close - candle.open) / range, 0, 1),
    range,
    direction:
      candle.close > candle.open
        ? "up"
        : candle.close < candle.open
          ? "down"
          : "flat",
  };
}

function trueRange(
  candle: IntraCandleOhlc,
  previousClose: number | null,
): number {
  if (previousClose === null) return candle.high - candle.low;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
}

export function computeAtr(
  candles: IntraCandleOhlc[],
  period = DEFAULT_ATR_PERIOD,
): number {
  const usable = candles.filter(
    (c) =>
      finitePositive(c.high) &&
      finitePositive(c.low) &&
      finitePositive(c.close) &&
      c.high >= c.low,
  );
  if (usable.length === 0) return 0;
  const take = Math.max(1, Math.min(period, usable.length));
  const start = usable.length - take;
  let sum = 0;
  for (let i = start; i < usable.length; i += 1) {
    const previousClose = i > 0 ? usable[i - 1].close : null;
    sum += trueRange(usable[i], previousClose);
  }
  const atr = sum / take;
  return Number.isFinite(atr) && atr > 0 ? atr : 0;
}

export function computeBollinger(
  closes: number[],
  period = BOLLINGER_PERIOD,
  multiplier = BOLLINGER_MULTIPLIER,
): BollingerBand | null {
  const usable = closes.filter(finitePositive);
  if (usable.length < MIN_BOLLINGER_SAMPLES) return null;
  const take = Math.min(period, usable.length);
  const tail = usable.slice(-take);
  const middle = tail.reduce((sum, value) => sum + value, 0) / take;
  const variance =
    tail.reduce((sum, value) => sum + (value - middle) ** 2, 0) / take;
  const std = Math.sqrt(Math.max(variance, 0));
  const upper = middle + std * multiplier;
  const lower = middle - std * multiplier;
  const width = upper - lower;
  const last = tail[tail.length - 1];
  return {
    middle,
    upper,
    lower,
    percentB: width > EPS ? clamp((last - lower) / width, 0, 1) : 0.5,
    bandwidthPct: middle > EPS ? (width / middle) * 100 : 0,
    sampleCount: take,
  };
}

function priceAtOrBefore(
  tape: IntraCandleTick[],
  targetMs: number,
): IntraCandleTick | null {
  for (let i = tape.length - 1; i >= 0; i -= 1) {
    if (tape[i].tsMs <= targetMs) return tape[i];
  }
  return null;
}

function velocityDirection(delta: number, epsilon: number): "up" | "down" | "flat" {
  if (delta > epsilon) return "up";
  if (delta < -epsilon) return "down";
  return "flat";
}

export function computeIntraCandleVelocity(
  tape: IntraCandleTick[],
  atr: number,
  asOfMs: number,
): IntraCandleVelocity {
  const usable = tape.filter(
    (t) =>
      Number.isFinite(t.tsMs) &&
      t.tsMs > 0 &&
      finitePositive(t.price) &&
      t.tsMs <= asOfMs,
  );
  const empty: IntraCandleVelocity = {
    available: false,
    delta5: 0,
    delta15: 0,
    velocity5: 0,
    velocity15: 0,
    prior5Velocity: 0,
    acceleration: 0,
    atrNormalizedMove: 0,
    spike: false,
    decelerating: false,
    direction: "flat",
    sampleCount: usable.length,
    window5s: 0,
    window15s: 0,
  };
  if (usable.length < 3) return empty;

  const last = usable[usable.length - 1];
  const windowStart = last.tsMs - MAX_VELOCITY_WINDOW_MS;
  const windowTape = usable.filter((t) => t.tsMs >= windowStart);
  if (windowTape.length < 3) return { ...empty, sampleCount: windowTape.length };

  const p15 = priceAtOrBefore(windowTape, last.tsMs - 15_000);
  const p5 = priceAtOrBefore(windowTape, last.tsMs - 5_000);
  const pPriorStart = priceAtOrBefore(windowTape, last.tsMs - 10_000);
  const pPriorEnd = priceAtOrBefore(windowTape, last.tsMs - 5_000);
  if (!p15 || !p5 || !pPriorStart || !pPriorEnd) {
    return { ...empty, sampleCount: windowTape.length };
  }

  const span5 = (last.tsMs - p5.tsMs) / 1000;
  const span15 = (last.tsMs - p15.tsMs) / 1000;
  if (span5 < 1 || span15 < 1) {
    return { ...empty, sampleCount: windowTape.length };
  }

  const delta5 = last.price - p5.price;
  const delta15 = last.price - p15.price;
  const velocity5 = delta5 / span5;
  const velocity15 = delta15 / span15;
  const priorSpan = (pPriorEnd.tsMs - pPriorStart.tsMs) / 1000;
  const prior5Velocity =
    priorSpan > 0 ? (pPriorEnd.price - pPriorStart.price) / priorSpan : 0;
  const acceleration = (velocity5 - prior5Velocity) / span5;
  const atrNormalizedMove = atr > EPS ? Math.abs(delta5) / atr : 0;
  const spike = atr > EPS && Math.abs(delta5) >= atr * 1.5;
  const decelerating =
    (Math.abs(prior5Velocity) > EPS &&
      Math.abs(velocity5) <= Math.abs(prior5Velocity) * 0.6) ||
    (Math.abs(velocity5) > EPS &&
      Math.sign(acceleration) !== 0 &&
      Math.sign(acceleration) !== Math.sign(velocity5));

  return {
    available: true,
    delta5,
    delta15,
    velocity5,
    velocity15,
    prior5Velocity,
    acceleration,
    atrNormalizedMove,
    spike,
    decelerating,
    direction: velocityDirection(delta15, EPS),
    sampleCount: windowTape.length,
    window5s: span5,
    window15s: span15,
  };
}

function tapeReversal(tape: IntraCandleTick[], side: "upper" | "lower"): boolean {
  if (tape.length < 6) return false;
  const tail = tape.slice(-6);
  const priorMove = tail[2].price - tail[0].price;
  const recentMove = tail[5].price - tail[3].price;
  return side === "upper"
    ? priorMove > EPS && recentMove < -EPS
    : priorMove < -EPS && recentMove > EPS;
}

function boundaryPick(
  side: "upper" | "lower",
  resistance: number | null,
  support: number | null,
  bollinger: BollingerBand | null,
  candle: IntraCandleOhlc,
): { kind: IntraCandleBoundaryKind; distance: number | null } {
  const candidates: Array<{
    kind: Exclude<IntraCandleBoundaryKind, null>;
    level: number;
  }> = [];
  if (side === "upper") {
    if (resistance !== null) {
      candidates.push({ kind: "resistance", level: resistance });
    }
    if (bollinger) {
      candidates.push({ kind: "bollinger_upper", level: bollinger.upper });
    }
  } else {
    if (support !== null) {
      candidates.push({ kind: "support", level: support });
    }
    if (bollinger) {
      candidates.push({ kind: "bollinger_lower", level: bollinger.lower });
    }
  }
  let best: { kind: IntraCandleBoundaryKind; distance: number | null } = {
    kind: null,
    distance: null,
  };
  for (const candidate of candidates) {
    const distance =
      side === "upper"
        ? Math.abs(candidate.level - candle.high)
        : Math.abs(candidate.level - candle.low);
    if (best.distance === null || distance < best.distance) {
      best = { kind: candidate.kind, distance };
    }
  }
  return best;
}

export function detectIntraCandlePullback(
  input: IntraCandleInput,
): IntraCandleFeatures {
  const { forming, closed } = input;
  const wickThreshold = input.wickThreshold ?? DEFAULT_WICK_THRESHOLD;
  const wick = computeWickMetrics(forming);
  const microForming = input.microForming ?? null;
  const microClosed = input.microClosed ?? [];
  const microBars = microForming ? [...microClosed, microForming] : [];
  const atrBars = microBars.length >= 2 ? microBars : [...closed, forming];
  const atr = computeAtr(atrBars, input.atrPeriod ?? DEFAULT_ATR_PERIOD);
  const atrSource: "micro" | "forming" | "unavailable" =
    atr <= EPS ? "unavailable" : microBars.length >= 2 ? "micro" : "forming";
  const bollingerCloses =
    closed.length > 0
      ? [...closed.map((c) => c.close), forming.close]
      : [...microClosed.map((c) => c.close), forming.close];
  const bollinger = computeBollinger(
    bollingerCloses,
    BOLLINGER_PERIOD,
    BOLLINGER_MULTIPLIER,
  );

  const levelWindow =
    closed.length > 0
      ? closed.slice(-20)
      : microClosed.length > 0
        ? microClosed.slice(-20)
        : [];
  let resistance =
    levelWindow.length > 0
      ? Math.max(...levelWindow.map((c) => c.high))
      : null;
  let support =
    levelWindow.length > 0 ? Math.min(...levelWindow.map((c) => c.low)) : null;
  const inputTape = input.tape ?? [];
  if (resistance === null && support === null && inputTape.length > 0) {
    const lastTs = inputTape[inputTape.length - 1].tsMs;
    const priorTape = inputTape.filter((t) => t.tsMs <= lastTs - 5_000);
    const levelTape = priorTape.length > 0 ? priorTape : inputTape.slice(0, -1);
    if (levelTape.length > 0) {
      resistance = Math.max(...levelTape.map((t) => t.price));
      support = Math.min(...levelTape.map((t) => t.price));
    }
  }
  const tolerance = Math.max(atr * 0.25, forming.close * 1e-5);

  const atUpperBoundary =
    (resistance !== null && forming.high >= resistance - tolerance) ||
    (bollinger !== null && forming.high >= bollinger.upper - tolerance);
  const atLowerBoundary =
    (support !== null && forming.low <= support + tolerance) ||
    (bollinger !== null && forming.low <= bollinger.lower + tolerance);

  const upperAlert = atUpperBoundary && wick.upperWickRatio > wickThreshold;
  const lowerAlert = atLowerBoundary && wick.lowerWickRatio > wickThreshold;
  const side: IntraCandleSide =
    upperAlert && (!lowerAlert || wick.upperWickRatio >= wick.lowerWickRatio)
      ? "upper"
      : lowerAlert
        ? "lower"
        : null;
  const picked =
    side === null
      ? { kind: null, distance: null }
      : boundaryPick(side, resistance, support, bollinger, forming);

  const asOfMs =
    input.nowMs > 0
      ? input.nowMs
      : (input.tape && input.tape.length > 0
          ? input.tape[input.tape.length - 1].tsMs
          : Date.now());
  const velocity = computeIntraCandleVelocity(
    input.tape ?? [],
    atr,
    asOfMs,
  );

  const microWick = microForming ? computeWickMetrics(microForming) : null;
  const microNearUpper =
    microForming !== null &&
    ((resistance !== null && microForming.high >= resistance - tolerance) ||
      (bollinger !== null && microForming.high >= bollinger.upper - tolerance));
  const microNearLower =
    microForming !== null &&
    ((support !== null && microForming.low <= support + tolerance) ||
      (bollinger !== null && microForming.low <= bollinger.lower + tolerance));
  const microRejection =
    side === "upper"
      ? microNearUpper &&
        ((microWick?.upperWickRatio ?? 0) >= 0.4 ||
          microForming!.close < microForming!.open)
      : side === "lower"
        ? microNearLower &&
          ((microWick?.lowerWickRatio ?? 0) >= 0.4 ||
            microForming!.close > microForming!.open)
        : false;
  const reversal = side === null ? false : tapeReversal(input.tape ?? [], side);
  const microValidated = microRejection || reversal;

  const rejectionDirection =
    velocity.direction === "up"
      ? "upper"
      : velocity.direction === "down"
        ? "lower"
        : null;
  const directionalExhaustion = side !== null && rejectionDirection === side;
  const alert = side !== null;
  const triggered =
    alert && directionalExhaustion && velocity.spike && velocity.decelerating;
  const signal: PullbackSignal =
    triggered && microValidated ? (side === "upper" ? "PUT" : "CALL") : null;
  const ratio = side === "upper" ? wick.upperWickRatio : wick.lowerWickRatio;
  const ratioNorm =
    side === null ? 0 : clamp((ratio - wickThreshold) / (1 - wickThreshold), 0, 1);
  const spikeNorm = clamp(velocity.atrNormalizedMove / 3, 0, 1);
  const score = clamp(
    0.35 * ratioNorm +
      0.25 * (velocity.spike ? 1 : 0) +
      0.2 * (velocity.decelerating ? 1 : 0) +
      0.2 * (microValidated ? 1 : 0),
    0,
    1,
  );
  const confidence =
    signal === null
      ? 0
      : Number(
          clamp(
            55 + 30 * ratioNorm + 10 * spikeNorm + 5 * (microValidated ? 1 : 0),
            0,
            96.5,
          ).toFixed(2),
        );
  const tierEligible = signal !== null && score >= 0.7 && confidence >= 70;
  const entryTiming: PullbackEntryTiming = signal
    ? "now"
    : alert && velocity.spike
      ? "wait"
      : "none";
  const entryPrice =
    side === "upper" ? forming.high : side === "lower" ? forming.low : null;

  let reason = "no_boundary_wick_rejection";
  if (alert && !directionalExhaustion) reason = "wick_rejection_without_exhaustion";
  else if (alert && !velocity.spike) reason = "wick_rejection_without_velocity_spike";
  else if (alert && !velocity.decelerating) reason = "velocity_not_decelerating";
  else if (alert && !microValidated) reason = "micro_timeframe_not_validated";
  else if (signal) reason = "wick_rejection_exhaustion_pullback";
  else if (alert) reason = "pullback_setup_not_confirmed";

  return {
    available: true,
    symbol: input.symbol,
    timeframe: input.timeframe,
    generatedAtMs: asOfMs,
    forming: {
      open: forming.open,
      high: forming.high,
      low: forming.low,
      close: forming.close,
      range: forming.high - forming.low,
      direction: wick.direction,
    },
    wick,
    atr,
    atrTimeframe: atrSource === "micro" ? "S5" : input.timeframe,
    atrSource,
    boundaries: {
      support,
      resistance,
      bollingerUpper: bollinger?.upper ?? null,
      bollingerMiddle: bollinger?.middle ?? null,
      bollingerLower: bollinger?.lower ?? null,
      tolerance,
      boundaryKind: picked.kind,
      distanceToBoundary: picked.distance,
    },
    velocity,
    exhaustion: {
      detected: directionalExhaustion && velocity.spike && velocity.decelerating,
      side,
      direction: velocity.direction,
      spike: velocity.spike,
      decelerating: velocity.decelerating,
      atrNormalizedMove: velocity.atrNormalizedMove,
    },
    wickRejection: {
      alert,
      side,
      wickRatio: ratio,
      threshold: wickThreshold,
      nearBoundary: alert,
      boundaryKind: picked.kind,
    },
    pullback: {
      signal,
      side,
      confidence,
      score: Number(score.toFixed(4)),
      entryTiming,
      entryPrice,
      tierEligible,
      m1Pullback: side !== null && input.timeframe === "M1",
      reason,
    },
    confluence: {
      microValidated,
      microRejection,
      tapeReversal: reversal,
      microTimeframe: "S5",
      timeframe: input.timeframe,
      score: Number(score.toFixed(4)),
      tierEligible,
    },
  };
}
