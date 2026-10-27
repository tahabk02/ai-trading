export type MarketClass = "otc" | "real" | "crypto";

export type RegimeLabel =
  | "trending"
  | "mean_reverting"
  | "random_walk"
  | "consolidation"
  | "chaotic"
  | "insufficient_data";

export type RegimeGate = "allow" | "caution" | "block";

export interface MarketRegimeMetrics {
  samples: number;
  volatilityPct: number;
  momentumPct: number;
  trendStrength: number;
  meanReversionZ: number;
  rangeCompression: number;
  roundNumberAffinity: number;
  autocorrelation: number;
}

export interface MarketRegimeVerdict {
  marketClass: MarketClass;
  regime: RegimeLabel;
  gate: RegimeGate;
  tradable: boolean;
  score: number;
  reason: string;
  metrics: MarketRegimeMetrics;
}

export interface MarketRegimeInput {
  prices: readonly number[];
  symbol?: string;
  marketClass?: MarketClass;
  maxSamples?: number;
}

const MIN_SAMPLES = 12;
const CRYPTO_HINTS = [
  "BTC",
  "ETH",
  "LTC",
  "XRP",
  "SOL",
  "DOGE",
  "BNB",
  "ADA",
  "DOT",
  "AVAX",
  "MATIC",
];
const OTC_HINTS = ["OTC", "_OTC", "-OTC"];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(
    values.reduce((acc, v) => acc + (v - m) * (v - m), 0) /
      (values.length - 1),
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function inferMarketClass(
  symbol: unknown,
  explicit?: MarketClass,
): MarketClass {
  if (explicit === "otc" || explicit === "real" || explicit === "crypto") {
    return explicit;
  }
  const raw = String(symbol ?? "").trim().toUpperCase();
  if (OTC_HINTS.some((hint) => raw.includes(hint))) return "otc";
  const root = raw.split(/[\/_\-\s]/)[0] ?? raw;
  if (CRYPTO_HINTS.some((hint) => root.startsWith(hint))) return "crypto";
  return "real";
}

function roundNumberAffinity(prices: readonly number[]): number {
  const digits = Math.abs(prices[prices.length - 1] ?? 0) >= 100 ? 1 : 4;
  const step = Math.pow(10, -digits);
  let hits = 0;
  for (const price of prices) {
    const scaled = price / step;
    const distance = Math.abs(scaled - Math.round(scaled));
    if (distance <= 0.02) hits += 1;
  }
  return prices.length > 0 ? hits / prices.length : 0;
}

function buildMetrics(prices: readonly number[]): MarketRegimeMetrics {
  const n = prices.length;
  if (n < 2) {
    return {
      samples: n,
      volatilityPct: 0,
      momentumPct: 0,
      trendStrength: 0,
      meanReversionZ: 0,
      rangeCompression: 0,
      roundNumberAffinity: 0,
      autocorrelation: 0,
    };
  }

  const returns: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const prev = prices[i - 1];
    if (prev > 0) returns.push((prices[i] - prev) / prev);
  }
  const vol = stdDev(returns) * 100;
  const first = returns[0] ?? 0;
  const last = returns[returns.length - 1] ?? 0;
  const momentumPct =
    ((prices[n - 1] - prices[0]) / Math.max(prices[0], 1e-12)) * 100;
  const direction = Math.sign(momentumPct);
  const alignedMoves = returns.filter((r) => Math.sign(r) === direction).length;
  const trendStrength =
    returns.length > 0 ? alignedMoves / returns.length : 0;

  const retMean = mean(returns);
  const retStd = stdDev(returns);
  const meanReversionZ =
    retStd > 0 ? (last - retMean) / retStd : 0;

  const bodyRange = Math.abs(prices[n - 1] - prices[0]);
  const range =
    Math.max(...prices) - Math.min(...prices);
  const rangeCompression =
    range > 0 ? clamp(1 - bodyRange / range, 0, 1) : 1;

  let autocorr = 0;
  if (returns.length >= 3) {
    const m = mean(returns);
    let num = 0;
    let den = 0;
    for (let i = 1; i < returns.length; i += 1) {
      num += (returns[i] - m) * (returns[i - 1] - m);
    }
    for (const r of returns) den += (r - m) * (r - m);
    autocorr = den > 0 ? num / den : 0;
  }

  return {
    samples: n,
    volatilityPct: vol,
    momentumPct,
    trendStrength,
    meanReversionZ,
    rangeCompression,
    roundNumberAffinity: roundNumberAffinity(prices),
    autocorrelation: autocorr,
  };
}

function verdict(
  marketClass: MarketClass,
  regime: RegimeLabel,
  gate: RegimeGate,
  score: number,
  reason: string,
  metrics: MarketRegimeMetrics,
): MarketRegimeVerdict {
  return {
    marketClass,
    regime,
    gate,
    tradable: gate !== "block",
    score: Math.round(clamp(score, 0, 100)),
    reason,
    metrics,
  };
}

export function analyzeMarketRegime(
  input: MarketRegimeInput,
): MarketRegimeVerdict {
  const marketClass = inferMarketClass(input?.symbol, input?.marketClass);
  const limit = Math.max(2, Math.floor(Number(input?.maxSamples ?? 240)));
  const prices = (Array.isArray(input?.prices) ? input.prices : [])
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p) && p > 0)
    .slice(-limit);
  const metrics = buildMetrics(prices);

  if (prices.length < MIN_SAMPLES) {
    return verdict(
      marketClass,
      "insufficient_data",
      "caution",
      35,
      "insufficient_samples",
      metrics,
    );
  }

  const {
    volatilityPct,
    momentumPct,
    trendStrength,
    meanReversionZ,
    rangeCompression,
    roundNumberAffinity,
    autocorrelation,
  } = metrics;

  const absoluteMomentum = Math.abs(momentumPct);
  const highVolatility = volatilityPct >= 0.35;
  const flatExit = absoluteMomentum <= 0.01 && rangeCompression >= 0.85;

  if (flatExit) {
    return verdict(
      marketClass,
      "consolidation",
      "block",
      10,
      "flat_tape_consolidation",
      metrics,
    );
  }

  if (
    highVolatility &&
    trendStrength < 0.42 &&
    Math.abs(autocorrelation) < 0.1 &&
    rangeCompression < 0.35
  ) {
    return verdict(
      marketClass,
      "chaotic",
      "block",
      15,
      "chaotic_volatility_no_structure",
      metrics,
    );
  }

  if (marketClass === "otc") {
    const structuredMeanReversion =
      autocorrelation <= -0.18 &&
      Math.abs(meanReversionZ) >= 1.1 &&
      roundNumberAffinity >= 0.35;
    const structuredTrend =
      trendStrength >= 0.62 &&
      absoluteMomentum >= 0.02 &&
      rangeCompression <= 0.5;
    if (structuredMeanReversion) {
      return verdict(
        marketClass,
        "mean_reverting",
        "allow",
        82,
        "otc_round_number_mean_reversion",
        metrics,
      );
    }
    if (structuredTrend) {
      return verdict(
        marketClass,
        "trending",
        "allow",
        78,
        "otc_directional_trend",
        metrics,
      );
    }
    if (rangeCompression >= 0.8 && absoluteMomentum <= 0.015) {
      return verdict(
        marketClass,
        "consolidation",
        "block",
        20,
        "otc_range_pinned",
        metrics,
      );
    }
    return verdict(
      marketClass,
      "random_walk",
      "caution",
      52,
      "otc_unstructured_tape",
      metrics,
    );
  }

  const structuredTrend =
    trendStrength >= 0.6 &&
    absoluteMomentum >= 0.03 &&
    rangeCompression <= 0.45;
  if (structuredTrend) {
    return verdict(
      marketClass,
      "trending",
      "allow",
      85,
      "session_momentum_trend",
      metrics,
    );
  }

  if (
    autocorrelation <= -0.2 &&
    Math.abs(meanReversionZ) >= 1.2 &&
    rangeCompression <= 0.65
  ) {
    return verdict(
      marketClass,
      "mean_reverting",
      "allow",
      78,
      "session_mean_reversion",
      metrics,
    );
  }

  if (rangeCompression >= 0.7 && absoluteMomentum <= 0.02) {
    return verdict(
      marketClass,
      "consolidation",
      "block",
      18,
      "session_low_liquidity_consolidation",
      metrics,
    );
  }

  return verdict(
    marketClass,
    "random_walk",
    "caution",
    50,
    "session_unstructured_tape",
    metrics,
  );
}

export function regimeConfidenceMultiplier(verdict: MarketRegimeVerdict): number {
  if (verdict.gate === "block") return 0;
  if (verdict.gate === "caution") return 0.85;
  return verdict.score >= 80 ? 1 : 0.95;
}

export function summarizeRegime(
  verdict: MarketRegimeVerdict,
): Record<string, unknown> {
  return {
    market_class: verdict.marketClass,
    regime: verdict.regime,
    gate: verdict.gate,
    score: verdict.score,
    reason: verdict.reason,
    tradable: verdict.tradable,
    volatility_pct: Math.round(verdict.metrics.volatilityPct * 1000) / 1000,
    momentum_pct: Math.round(verdict.metrics.momentumPct * 1000) / 1000,
    trend_strength: Math.round(verdict.metrics.trendStrength * 1000) / 1000,
    mean_reversion_z:
      Math.round(verdict.metrics.meanReversionZ * 1000) / 1000,
    round_number_affinity:
      Math.round(verdict.metrics.roundNumberAffinity * 1000) / 1000,
    samples: verdict.metrics.samples,
  };
}
