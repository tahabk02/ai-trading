export interface BrokerClockOptions {
  maxSamples?: number;
  warmupSamples?: number;
  maxOffsetMs?: number;
  maxJitterMs?: number;
  maxLatencyMs?: number;
  staleAfterMs?: number;
}

export interface BrokerClockSample {
  offsetMs: number;
  latencyMs: number;
  atMs: number;
}

export interface BrokerClockSnapshot {
  calibrated: boolean;
  stale: boolean;
  source: "calibrated" | "fallback";
  sampleCount: number;
  offsetMs: number;
  latencyMs: number | null;
  jitterMs: number | null;
  confidence: number;
  lastSampleAtMs: number | null;
  brokerNowMs: number;
}

export interface BrokerClockObservation {
  brokerTsMs: number;
  localReceivedMs?: number;
  latencyMs?: number;
}

export const DEFAULT_BROKER_CLOCK_OPTIONS: Required<BrokerClockOptions> = {
  maxSamples: 120,
  warmupSamples: 5,
  maxOffsetMs: 5 * 60_000,
  maxJitterMs: 250,
  maxLatencyMs: 10_000,
  staleAfterMs: 30_000,
};

function finitePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mad(values: readonly number[], center: number): number {
  if (values.length === 0) return 0;
  return median(values.map((v) => Math.abs(v - center)));
}

export class BrokerClockCalibrator {
  private readonly options: Required<BrokerClockOptions>;
  private samples: BrokerClockSample[] = [];
  private lastBrokerNowMs = 0;

  constructor(options: BrokerClockOptions = {}) {
    this.options = { ...DEFAULT_BROKER_CLOCK_OPTIONS, ...options };
  }

  public observe(observation: BrokerClockObservation): BrokerClockSnapshot {
    const brokerTs = finitePositive(observation?.brokerTsMs);
    const localReceived = finitePositive(
      observation?.localReceivedMs ?? Date.now(),
    );
    if (brokerTs === null || localReceived === null) {
      const now = localReceived ?? Date.now();
      return this.snapshot(now);
    }

    const rawLatency = Number(observation?.latencyMs);
    const latencyMs =
      Number.isFinite(rawLatency) && rawLatency >= 0
        ? Math.min(rawLatency, this.options.maxLatencyMs)
        : 0;
    const estimate = brokerTs - localReceived + latencyMs / 2;
    if (Number.isFinite(estimate) && Math.abs(estimate) <= this.options.maxOffsetMs) {
      this.samples.push({ offsetMs: estimate, latencyMs, atMs: localReceived });
      if (this.samples.length > this.options.maxSamples) {
        this.samples.splice(0, this.samples.length - this.options.maxSamples);
      }
    }
    return this.snapshot(localReceived);
  }

  public now(localNowMs: number = Date.now()): number {
    const snap = this.snapshot(localNowMs);
    const next = Math.max(snap.brokerNowMs, this.lastBrokerNowMs);
    this.lastBrokerNowMs = next;
    return next;
  }

  public snapshot(localNowMs: number = Date.now()): BrokerClockSnapshot {
    const now = Number.isFinite(localNowMs) ? localNowMs : Date.now();
    const fresh = this.samples.filter(
      (s) => now - s.atMs >= 0 && now - s.atMs <= this.options.staleAfterMs,
    );
    const pool = fresh.length > 0 ? fresh : this.samples;
    const last = pool.length > 0 ? pool[pool.length - 1] : null;
    const stale =
      last === null ||
      now - last.atMs < 0 ||
      now - last.atMs > this.options.staleAfterMs;

    if (pool.length === 0) {
      return this.buildSnapshot({
        calibrated: false,
        stale: true,
        sampleCount: 0,
        offsetMs: 0,
        latencyMs: null,
        jitterMs: null,
        confidence: 0,
        lastSampleAtMs: null,
        localNowMs: now,
      });
    }

    const bestPool = [...pool]
      .sort((a, b) => a.latencyMs - b.latencyMs)
      .slice(0, Math.max(3, Math.ceil(pool.length * 0.25)));
    const rawMedian = median(bestPool.map((s) => s.offsetMs));
    const deviation = mad(bestPool.map((s) => s.offsetMs), rawMedian);
    const guard = Math.max(1, deviation * 4);
    const inliers = bestPool.filter(
      (s) => Math.abs(s.offsetMs - rawMedian) <= guard,
    );
    const chosen = inliers.length >= Math.min(3, bestPool.length) ? inliers : bestPool;
    const offsetMs = median(chosen.map((s) => s.offsetMs));
    const jitterMs = mad(chosen.map((s) => s.offsetMs), offsetMs);
    const latencyMs = median(chosen.map((s) => s.latencyMs));
    const enough = pool.length >= this.options.warmupSamples;
    const stable = jitterMs <= this.options.maxJitterMs;
    const calibrated = enough && stable && !stale;
    const confidence = Math.max(
      0,
      Math.min(
        1,
        (Math.min(pool.length, 20) / 20) *
          (stable ? 1 : this.options.maxJitterMs / Math.max(jitterMs, 1)) *
          (stale ? 0.25 : 1),
      ),
    );

    return this.buildSnapshot({
      calibrated,
      stale,
      sampleCount: pool.length,
      offsetMs,
      latencyMs,
      jitterMs,
      confidence,
      lastSampleAtMs: last?.atMs ?? null,
      localNowMs: now,
    });
  }

  public reset(): void {
    this.samples = [];
    this.lastBrokerNowMs = 0;
  }

  private buildSnapshot(input: {
    calibrated: boolean;
    stale: boolean;
    sampleCount: number;
    offsetMs: number;
    latencyMs: number | null;
    jitterMs: number | null;
    confidence: number;
    lastSampleAtMs: number | null;
    localNowMs: number;
  }): BrokerClockSnapshot {
    const boundedOffset = Math.max(
      -this.options.maxOffsetMs,
      Math.min(this.options.maxOffsetMs, input.offsetMs),
    );
    const brokerNowMs = Math.round(input.localNowMs + boundedOffset);
    return {
      calibrated: input.calibrated,
      stale: input.stale,
      source: input.calibrated ? "calibrated" : "fallback",
      sampleCount: input.sampleCount,
      offsetMs: Math.round(boundedOffset),
      latencyMs:
        input.latencyMs === null ? null : Math.round(input.latencyMs),
      jitterMs: input.jitterMs === null ? null : Math.round(input.jitterMs),
      confidence: Math.round(input.confidence * 1000) / 1000,
      lastSampleAtMs: input.lastSampleAtMs,
      brokerNowMs,
    };
  }
}

export const brokerClock = new BrokerClockCalibrator();
