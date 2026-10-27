export interface TimeSyncPayload {
  brokerNowMs?: number;
  localNowMs?: number;
  offsetMs?: number;
  calibrated?: boolean;
  sampleCount?: number;
  latencyMs?: number | null;
  jitterMs?: number | null;
  confidence?: number;
  timestamp?: string;
}

export interface ClientClockSnapshot {
  calibrated: boolean;
  stale: boolean;
  offsetMs: number;
  latencyMs: number | null;
  jitterMs: number | null;
  confidence: number;
  sampleCount: number;
  lastSyncAtMs: number | null;
  brokerNowMs: number;
}

interface ClientClockSample {
  offsetMs: number;
  latencyMs: number;
  atMs: number;
}

export interface ClientClockOptions {
  maxSamples?: number;
  warmupSamples?: number;
  maxOffsetMs?: number;
  maxJitterMs?: number;
  staleAfterMs?: number;
}

const DEFAULTS: Required<ClientClockOptions> = {
  maxSamples: 30,
  warmupSamples: 3,
  maxOffsetMs: 5 * 60_000,
  maxJitterMs: 400,
  staleAfterMs: 30_000,
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class ClientClockSync {
  private readonly options: Required<ClientClockOptions>;
  private samples: ClientClockSample[] = [];
  private lastBrokerNowMs = 0;
  private pendingSentAtMs: number | null = null;

  constructor(options: ClientClockOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  public beginSync(localSentMs: number = Date.now()): void {
    this.pendingSentAtMs = localSentMs;
  }

  public ingest(
    payload: TimeSyncPayload | null | undefined,
    localReceivedMs: number = Date.now(),
  ): ClientClockSnapshot {
    const brokerNowMs = finite(payload?.brokerNowMs);
    if (brokerNowMs === null || brokerNowMs <= 0) {
      return this.snapshot(localReceivedMs);
    }
    const sentAt = this.pendingSentAtMs;
    this.pendingSentAtMs = null;
    const serverLocalNowMs = finite(payload?.localNowMs);
    const latencyMs =
      sentAt !== null && localReceivedMs >= sentAt
        ? Math.min(10_000, localReceivedMs - sentAt)
        : Math.max(0, finite(payload?.latencyMs) ?? 0);
    const localAtServer =
      serverLocalNowMs !== null && latencyMs > 0
        ? serverLocalNowMs + latencyMs / 2
        : localReceivedMs;
    const offsetMs = brokerNowMs - localAtServer;
    if (Math.abs(offsetMs) <= this.options.maxOffsetMs) {
      this.samples.push({ offsetMs, latencyMs, atMs: localReceivedMs });
      if (this.samples.length > this.options.maxSamples) {
        this.samples.splice(0, this.samples.length - this.options.maxSamples);
      }
    }
    return this.snapshot(localReceivedMs);
  }

  public now(localNowMs: number = Date.now()): number {
    const raw = this.snapshot(localNowMs).brokerNowMs;
    const next = Math.max(raw, this.lastBrokerNowMs);
    this.lastBrokerNowMs = next;
    return next;
  }

  public snapshot(localNowMs: number = Date.now()): ClientClockSnapshot {
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
      return {
        calibrated: false,
        stale: true,
        offsetMs: 0,
        latencyMs: null,
        jitterMs: null,
        confidence: 0,
        sampleCount: 0,
        lastSyncAtMs: null,
        brokerNowMs: Math.round(now),
      };
    }

    const best = [...pool]
      .sort((a, b) => a.latencyMs - b.latencyMs)
      .slice(0, Math.max(3, Math.ceil(pool.length * 0.25)));
    const center = median(best.map((s) => s.offsetMs));
    const jitterMs = median(best.map((s) => Math.abs(s.offsetMs - center)));
    const offsetMs = Math.max(
      -this.options.maxOffsetMs,
      Math.min(this.options.maxOffsetMs, center),
    );
    const calibrated =
      pool.length >= this.options.warmupSamples &&
      jitterMs <= this.options.maxJitterMs &&
      !stale;
    return {
      calibrated,
      stale,
      offsetMs: Math.round(offsetMs),
      latencyMs: Math.round(median(best.map((s) => s.latencyMs))),
      jitterMs: Math.round(jitterMs),
      confidence: Math.round(
        Math.min(1, pool.length / 10) * (stale ? 0.25 : 1) * 1000,
      ) / 1000,
      sampleCount: pool.length,
      lastSyncAtMs: last?.atMs ?? null,
      brokerNowMs: Math.round(now + offsetMs),
    };
  }

  public reset(): void {
    this.samples = [];
    this.lastBrokerNowMs = 0;
    this.pendingSentAtMs = null;
  }
}

export const clientClockSync = new ClientClockSync();
