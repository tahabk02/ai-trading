export interface AccuracyBar {
  symbol: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

export type AccuracyDirection = "BUY" | "SELL";

export interface AccuracySignal {
  id: string;
  symbol: string;
  timeframe: string;
  direction: AccuracyDirection;
  confidence: number;
  entryPrice: number;
  targetPrice: number;
  emittedAt: number;
  horizonMs: number;
  source: string;
}

export interface ProjectionRecord {
  symbol: string;
  timeframe: string;
  bucketOpen: number;
  direction: AccuracyDirection;
  projectionClose: number;
  projectedHigh: number;
  projectedLow: number;
  recordedAt: number;
}

export interface AccuracyBand {
  lo: number;
  hi: number;
  total: number;
  correct: number;
  errorRate: number;
}

export interface AccuracySnapshot {
  samples: number;
  correct: number;
  wrong: number;
  errorRate: number;
  accuracyPct: number;
  validated: boolean;
  blocking: boolean;
  blocked: boolean;
  targetReachedPct: number;
  reason: string | null;
  confidenceBands: AccuracyBand[];
  projectedMeanAbsErrorPct: number;
  projectionSamples: number;
  barsObserved: number;
  lastRealizedAt: number | null;
  pendingSignals: number;
  lastPrice: number;
}

export const ERROR_RATE_LIMIT = 0.03;
export const MIN_VALIDATED_SAMPLES = 5;
export const ROLLING_WINDOW = 120;
export const RECOVERY_EVALUATIONS = 8;

interface PoolSample {
  correct: boolean;
  errorPct: number;
  confidence: number;
  banded: boolean;
  reachedTarget: boolean;
  at: number;
}

const BAND_EDGES: Array<[number, number]> = [
  [0, 60],
  [60, 80],
  [80, 90],
  [90, 95],
  [95, 100],
];

export class MarketAccuracyVerifier {
  private signals = new Map<string, AccuracySignal>();
  private projections = new Map<string, ProjectionRecord>();
  private pool: PoolSample[] = [];
  private projectionErrors: number[] = [];
  private barsObserved = 0;
  private lastRealizedAt: number | null = null;
  private lastPrice = 0;
  private blocked = false;
  private recoveryStreak = 0;

  recordSignal(sig: AccuracySignal): void {
    if (!sig || typeof sig.id !== "string" || sig.id.length === 0) return;
    this.signals.set(sig.id, sig);
  }

  recordProjection(rec: ProjectionRecord): void {
    if (!rec || !rec.symbol || rec.bucketOpen <= 0) return;
    const key = `${rec.symbol.trim().toUpperCase()}::${rec.timeframe || ""}::${rec.bucketOpen}`;
    if (!this.projections.has(key)) this.projections.set(key, rec);
  }

  realizeBar(bar: AccuracyBar): void {
    if (!bar || !bar.symbol || bar.symbol.trim().length === 0) return;
    const values = [bar.open, bar.high, bar.low, bar.close];
    if (!values.every((v) => Number.isFinite(v) && v > 0)) return;
    const normSymbol = bar.symbol.trim().toUpperCase();

    if (bar.timestamp > 0) {
      this.barsObserved += 1;
      this.lastRealizedAt = bar.timestamp;
      this.lastPrice = bar.close;
    }

    const bucketKey = `${normSymbol}::${bar.timeframe || ""}::${bar.timestamp}`;
    const proj = this.projections.get(bucketKey);
    if (proj && bar.close > 0) {
      const realizedUp = bar.close >= bar.open;
      const correct = realizedUp === (proj.direction === "BUY");
      const errPct = (Math.abs(proj.projectionClose - bar.close) / bar.close) * 100;
      this.pool.push({
        correct,
        errorPct: Number.isFinite(errPct) ? errPct : 0,
        confidence: 0,
        banded: false,
        reachedTarget: proj.direction === "BUY" ? bar.high >= proj.projectionClose : bar.low <= proj.projectionClose,
        at: bar.timestamp,
      });
      this.prunePool();
      if (Number.isFinite(errPct)) {
        this.projectionErrors.push(errPct);
        if (this.projectionErrors.length > ROLLING_WINDOW) {
          this.projectionErrors.splice(0, this.projectionErrors.length - ROLLING_WINDOW);
        }
      }
      this.projections.delete(bucketKey);
    }

    const expired: AccuracySignal[] = [];
    for (const sig of this.signals.values()) {
      if (sig.symbol.trim().toUpperCase() !== normSymbol) continue;
      if (sig.timeframe && sig.timeframe !== bar.timeframe) continue;
      const base = Number.isFinite(sig.emittedAt) && sig.emittedAt > 0 ? sig.emittedAt : bar.timestamp;
      const horizon = Number.isFinite(sig.horizonMs) && sig.horizonMs > 0 ? sig.horizonMs : 0;
      if (bar.timestamp < base + horizon) continue;
      if (!(sig.entryPrice > 0) || !(bar.close > 0)) {
        expired.push(sig);
        continue;
      }
      const up = sig.direction === "BUY";
      const correct = up ? bar.close > sig.entryPrice : bar.close < sig.entryPrice;
      const errPct = (Math.abs(bar.close - sig.entryPrice) / sig.entryPrice) * 100;
      const reachedTarget =
        sig.targetPrice > 0
          ? up
            ? bar.high >= sig.targetPrice
            : bar.low <= sig.targetPrice
          : false;
      this.pool.push({
        correct,
        errorPct: Number.isFinite(errPct) ? errPct : 0,
        confidence: Number.isFinite(sig.confidence) ? sig.confidence : 0,
        banded: true,
        reachedTarget,
        at: bar.timestamp,
      });
      this.prunePool();
      expired.push(sig);
    }
    for (const sig of expired) this.signals.delete(sig.id);
  }

  snapshot(): AccuracySnapshot {
    const windowPool = this.pool.slice(-ROLLING_WINDOW);
    const samples = windowPool.length;
    const correct = windowPool.filter((s) => s.correct).length;
    const wrong = samples - correct;
    const errorRate = samples > 0 ? wrong / samples : 0;

    if (this.blocked) {
      if (errorRate < ERROR_RATE_LIMIT) {
        this.recoveryStreak += 1;
        if (this.recoveryStreak >= RECOVERY_EVALUATIONS) {
          this.blocked = false;
          this.recoveryStreak = 0;
        }
      } else {
        this.recoveryStreak = 0;
      }
    } else if (samples >= MIN_VALIDATED_SAMPLES && errorRate >= ERROR_RATE_LIMIT) {
      this.blocked = true;
      this.recoveryStreak = 0;
    }

    const blocking = this.blocked;
    const targetReached = windowPool.filter((s) => s.reachedTarget).length;
    const confidenceBands = this.buildBands();
    const projectedMeanAbsErrorPct =
      this.projectionErrors.length > 0
        ? this.projectionErrors.reduce((a, b) => a + b, 0) / this.projectionErrors.length
        : 0;

    const reason = blocking
      ? `Statistical accuracy gate: ${(errorRate * 100).toFixed(1)}% realized error over ${samples} real-tape samples (limit ${(ERROR_RATE_LIMIT * 100).toFixed(1)}%).`
      : null;

    return {
      samples,
      correct,
      wrong,
      errorRate,
      accuracyPct: (1 - errorRate) * 100,
      validated: samples >= MIN_VALIDATED_SAMPLES && !blocking,
      blocking,
      blocked: this.blocked,
      targetReachedPct: samples > 0 ? (targetReached / samples) * 100 : 0,
      reason,
      confidenceBands,
      projectedMeanAbsErrorPct,
      projectionSamples: this.projectionErrors.length,
      barsObserved: this.barsObserved,
      lastRealizedAt: this.lastRealizedAt,
      pendingSignals: this.signals.size,
      lastPrice: this.lastPrice,
    };
  }

  reset(): void {
    this.signals.clear();
    this.projections.clear();
    this.pool = [];
    this.projectionErrors = [];
    this.barsObserved = 0;
    this.lastRealizedAt = null;
    this.lastPrice = 0;
    this.blocked = false;
    this.recoveryStreak = 0;
  }

  private prunePool(): void {
    if (this.pool.length > ROLLING_WINDOW) {
      this.pool.splice(0, this.pool.length - ROLLING_WINDOW);
    }
  }

  private buildBands(): AccuracyBand[] {
    const bands: AccuracyBand[] = BAND_EDGES.map(([lo, hi]) => ({
      lo,
      hi,
      total: 0,
      correct: 0,
      errorRate: 0,
    }));
    for (const sample of this.pool) {
      if (!sample.banded || !Number.isFinite(sample.confidence)) continue;
      const conf = Math.max(0, Math.min(100, sample.confidence));
      const band = bands.find((b) => conf >= b.lo && conf < b.hi);
      if (!band) continue;
      band.total += 1;
      if (sample.correct) band.correct += 1;
    }
    for (const band of bands) {
      band.errorRate = band.total > 0 ? (band.total - band.correct) / band.total : 0;
    }
    return bands;
  }
}

export const tradingAccuracyVerifier = new MarketAccuracyVerifier();

export default tradingAccuracyVerifier;