/**
 * tickLatencyProbe.ts — TEMPORARY high-precision tick-latency diagnostic.
 *
 * WEBSOCKET-FEED & SSID SYNCHRONIZATION AUDIT (deliverable 2).
 *
 * Measures the exact millisecond delta between the broker's server timestamp
 * (t_broker) and local receipt time (t_local) across 100 consecutive ticks,
 * plus the decomposed relay/backend legs when the pocket-bridge supplies its
 * decorated fields (`ts_utc`, `seq`, `received_utc_ms` — see the backend's
 * additive diagnostics on `live_tick`):
 *
 *   t_broker  tick.timestamp — Pocket Option server epoch-ms (carries the
 *             7200s platform clock offset; do NOT absolute-age against UTC).
 *   ts_utc    pocket-bridge relay emission wall-clock ms.
 *   t_backend core-backend receipt wall-clock ms (received_utc_ms).
 *   t_local   browser local receipt wall-clock ms (Date.now() at onLiveTick).
 *
 *   brokerToBrowserMs = t_local − t_broker   (requested delta)
 *   bridgeLegMs       = t_backend − ts_utc   (relay → backend, same-host)
 *   socketLegMs       = t_local − t_backend  (socket.io backend → browser)
 *   interArrivalMs    = t_local delta vs previous sample
 *   seqGap            = relay seq jump − 1 (missing frames / drops)
 *
 * On the 100th observation it prints a console.table summary (min/p50/p95/max)
 * and exposes a window.__tickLatencySummary() accessor so the latency audit can
 * be dumped at any time. Pure core (TickLatencyCollector) is unit-testable.
 */

export const PROBE_WINDOW = 100;

export interface TickLatencySample {
  index: number;
  symbol: string;
  /** Relay monotonic emit counter (drop detection). */
  seq?: number;
  /** Broker server epoch-ms (unadjusted PO clock). */
  tBroker: number;
  /** Relay emission wall-clock ms. */
  tsUtc?: number;
  /** Backend receipt wall-clock ms. */
  tBackend?: number;
  /** Browser local receipt wall-clock ms. */
  tLocal: number;
  brokerToBrowserMs: number;
  bridgeLegMs?: number;
  socketLegMs?: number;
  interArrivalMs: number;
  seqGap: number;
}

export interface TickLatencySummary {
  window: number;
  dropped: number;
  brokerToBrowserMs: { min: number; p50: number; p95: number; max: number };
  socketLegMs?: { min: number; p50: number; p95: number; max: number };
  interArrivalMs: { min: number; p50: number; p95: number; max: number };
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round((q / 100) * (sorted.length - 1))),
  );
  return sorted[idx];
}

function stats(values: number[]): { min: number; p50: number; p95: number; max: number } {
  if (values.length === 0) return { min: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

export class TickLatencyCollector {
  readonly window: number;
  private samples: TickLatencySample[] = [];
  private prevLocal = 0;
  private prevSeq = 0;
  private completedWindows = 0;
  onComplete: ((summary: TickLatencySummary, samples: TickLatencySample[]) => void) | null = null;

  constructor(window = PROBE_WINDOW) {
    this.window = window;
  }

  /** Derive a broker epoch-ms from either a numeric or ISO-string timestamp. */
  public static brokerMs(timestamp: unknown): number | null {
    if (typeof timestamp === "number") {
      let ms = timestamp;
      if (ms < 1e12) ms *= 1000;
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    if (typeof timestamp === "string") {
      const n = Number(timestamp);
      if (Number.isFinite(n)) {
        let ms = n;
        if (ms < 1e12) ms *= 1000;
        return Number.isFinite(ms) && ms > 0 ? ms : null;
      }
      const parsed = Date.parse(timestamp);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  }

  private static asFinite(v: unknown): number | undefined {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  /** Record one observed live tick. Returns the sample, or null when the tick
   *  lacks a parseable broker timestamp. */
  public record(tick: unknown): TickLatencySample | null {
    if (!tick || typeof tick !== "object") return null;
    const t = tick as Record<string, unknown>;
    const tBroker = TickLatencyCollector.brokerMs(t.timestamp);
    if (tBroker == null) return null;
    const symbol = typeof t.symbol === "string" ? t.symbol.trim().toUpperCase() : "";
    const tLocal = Date.now();
    const tBackend = TickLatencyCollector.asFinite(t.received_utc_ms);
    const tsUtc = TickLatencyCollector.asFinite(t.ts_utc);
    const seq = TickLatencyCollector.asFinite(t.seq);

    const sample: TickLatencySample = {
      index: this.samples.length + 1,
      symbol,
      ...(seq != null ? { seq } : {}),
      tBroker,
      ...(tsUtc != null ? { tsUtc } : {}),
      ...(tBackend != null ? { tBackend } : {}),
      tLocal,
      // RAW delta, deliberately NOT clamped: Pocket Option's broker clock runs
      // ~7200s ahead of UTC, so a negative value here is the expected platform
      // offset — documenting why broker timestamps must never be absolute-aged.
      brokerToBrowserMs: tLocal - tBroker,
      ...(tBackend != null && tsUtc != null
        ? { bridgeLegMs: Math.max(0, tBackend - tsUtc) }
        : {}),
      ...(tBackend != null ? { socketLegMs: Math.max(0, tLocal - tBackend) } : {}),
      interArrivalMs: this.prevLocal > 0 ? Math.max(0, tLocal - this.prevLocal) : 0,
      seqGap: seq != null && this.prevSeq > 0 ? Math.max(0, seq - this.prevSeq - 1) : 0,
    };
    this.prevLocal = tLocal;
    if (seq != null) this.prevSeq = seq;

    this.samples.push(sample);
    if (this.samples.length >= this.window) {
      const summary = this.summary();
      if (this.onComplete) this.onComplete(summary, this.samples);
      this.samples = [];
      this.prevSeq = 0;
      this.completedWindows += 1;
    }
    return sample;
  }

  public summary(): TickLatencySummary {
    const broker = this.samples.map((s) => s.brokerToBrowserMs);
    const socketLeg = this.samples
      .map((s) => s.socketLegMs)
      .filter((v): v is number => v != null);
    const inter = this.samples.map((s) => s.interArrivalMs);
    return {
      window: this.windowsCompleted,
      dropped:
        this.samples.length > 0 ? this.samples.reduce((a, s) => a + s.seqGap, 0) : 0,
      brokerToBrowserMs: stats(broker),
      ...(socketLeg.length > 0 ? { socketLegMs: stats(socketLeg) } : {}),
      interArrivalMs: stats(inter),
    };
  }

  /** Number of samples currently buffered (resets each completed 100-window). */
  public get size(): number {
    return this.samples.length;
  }

  public get windowsCompleted(): number {
    return this.completedWindows;
  }
}

/** Print a latency summary to the console (the deliverable's logging hook).
 *  Double-guarded: never prints in production, never prints without the
 *  explicit `window.__ENABLE_TICK_LATENCY_PROBE === true` opt-in. */
export function logTickLatencySummary(
  summary: TickLatencySummary,
  samples: TickLatencySample[],
): void {
  if (!isTickLatencyProbeEnabled()) return;
  // eslint-disable-next-line no-console
  console.info(
    `[TICK LATENCY PROBE] window #${summary.window + 1} (${samples.length} ticks)`,
  );
  // eslint-disable-next-line no-console
  console.table(samples);
  // eslint-disable-next-line no-console
  console.info("[TICK LATENCY PROBE] summary", summary);
}

/** Module-level singleton wired into the live_tick handler. */
export const tickLatencyProbe = new TickLatencyCollector();

// Global accessor so the audit summary can be read at any time from the console
// ('' if the current window has not completed; use it mid-window to peek).
declare global {
  interface Window {
    __tickLatencySummary?: () => { buffered: number; partial: TickLatencySummary };
    /**
     * Opt-in kill switch for the probe's console output. The probe is fully
     * SILENT by default: it only prints when this flag is `true` AND not in
     * production (mirrors tiered-diagnostics best practice).
     */
    __ENABLE_TICK_LATENCY_PROBE?: boolean;
  }
}

/**
 * Whether the probe is allowed to PRINT. Two gates, both required:
 *   1. not a production build (NODE_ENV !== "production"), and
 *   2. an explicit `window.__ENABLE_TICK_LATENCY_PROBE === true` opt-in.
 * By default the probe is silent — no logs, no tables, no spam.
 */
export function isTickLatencyProbeEnabled(): boolean {
  if (
    typeof process !== "undefined" &&
    process.env?.NODE_ENV === "production"
  ) {
    return false;
  }
  if (typeof window === "undefined") return false;
  return window.__ENABLE_TICK_LATENCY_PROBE === true;
}

if (typeof window !== "undefined") {
  window.__tickLatencySummary = () => ({
    buffered: tickLatencyProbe.size,
    partial: tickLatencyProbe.summary(),
  });
}

if (typeof window !== "undefined" && isTickLatencyProbeEnabled()) {
  tickLatencyProbe.onComplete = logTickLatencySummary;
}