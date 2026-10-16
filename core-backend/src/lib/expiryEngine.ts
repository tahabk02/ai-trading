/**
 * expiryEngine.ts — deterministic expiry + strike/target trade parameters.
 *
 * Backend twin of `ai-engine/app/services/expiry_engine.py`. Given a live entry
 * price, a selected horizon and the AI Engine's projected endpoint, it derives
 * the point-in-time contract boundary the UI needs:
 *
 *   entryTimestamp · entryPrice · expiryTimestamp · predictedTargetPrice ·
 *   targetStatus (ABOVE / BELOW / AT the entry strike)
 *
 * plus the RAW MATH VECTORS (start price, predicted end price, probability
 * score, basis) so the socket frame carries the numbers the projection was
 * computed from — never a mock.
 *
 * HONESTY CONTRACT (docs/DATA-PROVENANCE-POLICY.md): a missing endpoint stays
 * `null`; nothing is invented. `computePriceTargetVector` returns
 * `available:false` with all-null vectors when the tape is too short or
 * degenerate, and withholds the probability when residual σ is zero.
 */

export const HORIZON_SECONDS = [5, 15, 30, 60, 300] as const;

export const MIN_REGRESSION_SAMPLES = 5;

export const PROBABILITY_BASIS = "regression_residual_gaussian";

const DEFAULT_Z = 1.959963984540054;
const EPS = 1e-12;

export type Direction = "BUY" | "SELL";
export type TargetStatus = "ABOVE" | "BELOW" | "AT";

export interface PriceTargetVector {
  available: boolean;
  reason: string | null;
  direction: Direction | null;
  horizonSeconds: number;
  entryPrice: number | null;
  predictedEndPrice: number | null;
  confidenceMargin: number | null;
  confidenceLower: number | null;
  confidenceUpper: number | null;
  holdProbability: number | null;
  probabilityBasis: string | null;
  samples: number;
  residualSigma: number | null;
  r2: number | null;
}

export interface PredictionVectors {
  start_price: number | null;
  predicted_end_price: number | null;
  probability_score: number | null;
  probability_basis: string | null;
  direction: Direction | null;
  horizon_seconds: number;
}

export interface TradeParameters {
  entryTimestamp: string | null;
  entryPrice: number | null;
  expiryTimestamp: string | null;
  predictedTargetPrice: number | null;
  targetStatus: TargetStatus | null;
  horizonSeconds: number;
  predictionVectors: PredictionVectors;
}

export interface PriceTargetInput {
  closes: Array<number | null | undefined>;
  entryPrice?: number | null;
  horizonSeconds: number | string | null;
  direction?: Direction | string | null;
  symbolDigits?: number;
  z?: number;
}

export interface TradeParametersInput {
  entryMs: number | null;
  entryPrice: number | null;
  livePrice: number | null;
  horizonSeconds: number | string | null;
  direction?: Direction | string | null;
  predictedTargetPrice?: number | null;
  holdProbability?: number | null;
  probabilityBasis?: string | null;
}

const finiteOrNull = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Snap an arbitrary horizon request onto the supported SECOND set. Unknown /
 * None / ≤0 → the shortest supported horizon (floor bias on ties, so an
 * unsupported 45s resolves to 30s, never silently to 60s).
 */
export function resolveHorizonSeconds(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return HORIZON_SECONDS[0];
  const set: readonly number[] = HORIZON_SECONDS;
  if (set.includes(n)) return n;
  let best: number = HORIZON_SECONDS[0];
  for (const s of set) {
    if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  }
  return best;
}

/**
 * Smallest Δt boundary at/after `entry + Δt` (boundary-aligned expiry). The
 * contract always lands ON a timeframe edge rather than mid-bar; an entry
 * already exactly on a boundary is preserved.
 */
export function alignExpiryMs(entryMs: number, deltaSeconds: number): number {
  if (!Number.isFinite(entryMs)) throw new RangeError("entryMs must be finite");
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    throw new RangeError("deltaSeconds must be positive");
  }
  const deltaMs = deltaSeconds * 1000;
  const target = entryMs + deltaMs;
  const aligned = Math.ceil(target / deltaMs) * deltaMs;
  return Math.round(aligned);
}

/** Abramowitz & Stegun 7.1.26 error-function approximation. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Decimal precision per asset class: crypto → 2, JPY quote → 3, else 5. */
export function symbolPriceDigits(symbol: string): number {
  const sym = (symbol || "").trim().toUpperCase();
  if (sym === "BTC/USD" || sym === "ETH/USD") return 2;
  const quote = sym.split("/")[1];
  if (!quote) return 5;
  return quote === "JPY" ? 3 : 5;
}

const round = (v: number, digits: number): number =>
  Number(v.toFixed(Math.max(0, digits)));

const withheld = (samples: number, horizonSeconds: number, reason: string): PriceTargetVector => ({
  available: false,
  reason,
  direction: null,
  horizonSeconds,
  entryPrice: null,
  predictedEndPrice: null,
  confidenceMargin: null,
  confidenceLower: null,
  confidenceUpper: null,
  holdProbability: null,
  probabilityBasis: null,
  samples,
  residualSigma: null,
  r2: null,
});

/**
 * OLS regression over the real close tape, projected `horizonSeconds` ahead.
 * The confidence band is ±z·σ·√Δt and `holdProbability` is the normal CDF of
 * the projected edge over that band (a MODELED estimate whose basis is
 * disclosed). All numbers round to the instrument's precision; a short,
 * degenerate or zero-σ tape withholds rather than fabricates.
 */
export function computePriceTargetVector(input: PriceTargetInput): PriceTargetVector {
  const horizon = resolveHorizonSeconds(input.horizonSeconds);
  const digits =
    input.symbolDigits && input.symbolDigits > 0 ? input.symbolDigits : 5;
  const z = Number.isFinite(input.z) && (input.z as number) > 0 ? (input.z as number) : DEFAULT_Z;

  const closes = (Array.isArray(input.closes) ? input.closes : [])
    .map((c) => finiteOrNull(c))
    .filter((c): c is number => c !== null && c > 0);
  const n = closes.length;

  if (n < MIN_REGRESSION_SAMPLES) {
    return withheld(n, horizon, "insufficient_history");
  }

  let sx = 0;
  let sxx = 0;
  let sy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += i;
    sxx += i * i;
    sy += closes[i];
    sxy += i * closes[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) <= EPS) {
    return withheld(n, horizon, "degenerate_index");
  }

  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  const mean = sy / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const fitted = slope * i + intercept;
    const r = closes[i] - fitted;
    ssRes += r * r;
    const d = closes[i] - mean;
    ssTot += d * d;
  }
  const sigma = Math.sqrt(ssRes / n);
  const r2 = ssTot > EPS ? 1 - ssRes / ssTot : 0;

  const predicted = intercept + slope * (n - 1 + horizon);
  const sigmaH = sigma * Math.sqrt(horizon);

  let direction: Direction = input.direction === "SELL" ? "SELL" : input.direction === "BUY" ? "BUY" : slope >= 0 ? "BUY" : "SELL";

  const entry = finiteOrNull(input.entryPrice);
  const entryValid = entry !== null && entry > 0 ? entry : null;

  const margin = z * sigmaH;
  let hold: number | null = null;
  if (entryValid !== null && sigmaH > EPS) {
    const edge =
      direction === "BUY" ? predicted - entryValid : entryValid - predicted;
    hold = Math.max(0, Math.min(1, normalCdf(edge / sigmaH)));
  }

  return {
    available: true,
    reason: null,
    direction,
    horizonSeconds: horizon,
    entryPrice: entryValid !== null ? round(entryValid, digits) : null,
    predictedEndPrice: round(predicted, digits),
    confidenceMargin: round(margin, digits),
    confidenceLower: round(predicted - margin, digits),
    confidenceUpper: round(predicted + margin, digits),
    holdProbability: hold !== null ? round(hold, 4) : null,
    probabilityBasis: hold !== null ? PROBABILITY_BASIS : null,
    samples: n,
    residualSigma: round(sigma, Math.max(digits, 6)),
    r2: round(Math.max(0, Math.min(1, r2)), 4),
  };
}

/** Where the live price sits relative to the entry strike. */
export function computeTargetStatus(
  livePrice: number | null,
  entryPrice: number | null,
): TargetStatus | null {
  if (livePrice === null || entryPrice === null) return null;
  if (!Number.isFinite(livePrice) || !Number.isFinite(entryPrice)) return null;
  if (livePrice > entryPrice) return "ABOVE";
  if (livePrice < entryPrice) return "BELOW";
  return "AT";
}

const toIsoOrNull = (ms: number | null): string | null =>
  ms !== null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/**
 * Assemble the deterministic trade parameters + raw prediction vectors. A
 * non-positive/missing endpoint and a missing entry time both stay `null`; the
 * horizon is always normalised onto the supported set so an expiry boundary is
 * always produced when the entry time exists. `targetStatus` reports where the
 * PROJECTED endpoint sits relative to the entry strike (ABOVE = CALL target
 * above the strike, BELOW = PUT target below it).
 */
export function computeTradeParameters(input: TradeParametersInput): TradeParameters {
  const horizon = resolveHorizonSeconds(input.horizonSeconds);
  const entryMs =
    input.entryMs !== null && Number.isFinite(input.entryMs) ? input.entryMs : null;

  const entryPrice =
    input.entryPrice !== null && Number.isFinite(input.entryPrice) && input.entryPrice > 0
      ? input.entryPrice
      : null;

  const predictedRaw = finiteOrNull(input.predictedTargetPrice);
  const predictedTargetPrice =
    predictedRaw !== null && predictedRaw > 0 ? predictedRaw : null;

  const holdProbability =
    input.holdProbability !== null &&
    input.holdProbability !== undefined &&
    Number.isFinite(input.holdProbability) &&
    input.holdProbability >= 0 &&
    input.holdProbability <= 1
      ? input.holdProbability
      : null;

  const direction: Direction | null =
    input.direction === "BUY" || input.direction === "SELL" ? input.direction : null;

  const expiryMs = entryMs !== null ? alignExpiryMs(entryMs, horizon) : null;

  return {
    entryTimestamp: toIsoOrNull(entryMs),
    entryPrice,
    expiryTimestamp: toIsoOrNull(expiryMs),
    predictedTargetPrice,
    targetStatus: computeTargetStatus(predictedTargetPrice, entryPrice),
    horizonSeconds: horizon,
    predictionVectors: {
      start_price: entryPrice,
      predicted_end_price: predictedTargetPrice,
      probability_score: holdProbability,
      probability_basis:
        holdProbability !== null ? input.probabilityBasis ?? PROBABILITY_BASIS : null,
      direction,
      horizon_seconds: horizon,
    },
  };
}
