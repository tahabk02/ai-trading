/**
 * PURE Prometheus text-format metrics registry for the live-feed pipeline.
 *
 * Dependency-free counter store emitting the standard Prometheus exposition
 * text format (mission [7].1/.2/.3/.4). Counter semantics are raw-increment
 * only — gauges hold a snapshot — so scrapes are monotonic for allow-alerts.
 *
 * Standard-formatted, byte-verifiable samples:
 *   # HELP feed_retry_total Total live-feed retries (after an error).
 *   # TYPE feed_retry_total counter
 *   feed_retry_total{symbol="EUR/USD",reason="timeout"} 3
 */
export type FeedMetricLabels = Record<string, string>;

interface FeedCounter {
  value: number;
  help: string;
}

interface FeedGauge {
  value: number;
  help: string;
}

interface FeedMetricsSnapshot {
  counters: Array<{ name: string; help: string; samples: string[] }>;
  gauges: Array<{ name: string; help: string; samples: string[] }>;
}

/** Order-stable label serialization for a deterministic sample key. */
function labelKey(labels: FeedMetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`)
    .join(",");
}

/** Parse a labelKey back into a FeedMetricLabels object. */
function parseLabels(labelsRaw: string): FeedMetricLabels {
  const labels: FeedMetricLabels = {};
  if (!labelsRaw) return labels;
  for (const part of labelsRaw.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) labels[part.slice(0, eq)] = JSON.parse(part.slice(eq + 1));
  }
  return labels;
}

/** Render `{k="v",...}` Prometheus label set (empty → no braces). */
function renderLabels(labels: FeedMetricLabels): string {
  const entries = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`);
  return entries.length === 0 ? "" : `{${entries.join(",")}}`;
}

export class FeedMetricsRegistry {
  private counters = new Map<string, FeedCounter>();
  private gauges = new Map<string, FeedGauge>();
  private counterOrder: string[] = [];
  private gaugeOrder: string[] = [];

  /** Increment a counter for a labelled series; lazily creates it. */
  public incrementCounter(
    name: string,
    labels: FeedMetricLabels,
    help: string,
    by = 1,
  ): void {
    const key = `${name}#${labelKey(labels)}`;
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += by;
    } else {
      this.counters.set(key, { value: by, help });
      this.counterOrder.push(`${name}#${labelKey(labels)}`);
    }
  }

  /** Set an absolute gauge value (snapshot, not monotonic). */
  public setGauge(name: string, labels: FeedMetricLabels, help: string, value: number): void {
    const key = `${name}#${labelKey(labels)}`;
    const existing = this.gauges.get(key);
    if (existing) {
      existing.value = value;
    } else {
      this.gauges.set(key, { value, help });
      this.gaugeOrder.push(`${name}#${labelKey(labels)}`);
    }
  }

  /** Monotonic retry counter — feed_retry_total{...}. */
  public countRetry(symbol: string, reason: string): void {
    this.incrementCounter("feed_retry_total", { symbol, reason }, "Total live-feed retries after an error.");
  }

  /** Monotonic consecutive-error counter — feed_error_total{...}. */
  public countError(symbol: string, reason: string): void {
    this.incrementCounter("feed_error_total", { symbol, reason }, "Total live-feed consecutive errors observed.");
  }

  /** Monotonic recovery counter — feed_recovery_total{symbol}. */
  public countRecovery(symbol: string): void {
    this.incrementCounter("feed_recovery_total", { symbol }, "Total live-feed recovery transitions to ONLINE.");
  }

  /** Gauge of the current exponential backoff for a symbol — feed_backoff_ms. */
  public setBackoffMs(symbol: string, ms: number): void {
    this.setGauge("feed_backoff_ms", { symbol }, "Current exponential retry backoff (ms) for a symbol.", ms);
  }

  /** Mono-blocked high watermark — feed_lingering_max_errors{symbol}. */
  public setMaxConsecutiveErrors(symbol: string, value: number): void {
    this.setGauge("feed_lingering_max_errors", { symbol }, "Highest consecutive-error count for the incident.", value);
  }

  /** Snapshot in Prometheus text exposition format (HELP + TYPE + samples). */
  public scrape(): string {
    const sections: string[] = [];
    const byCounterName = new Map<string, Map<string, FeedCounter>>();
    for (const key of this.counterOrder) {
      const entry = this.counters.get(key)!;
      const sep = key.indexOf("#");
      const name = key.slice(0, sep);
      const labelsRaw = key.slice(sep + 1);
      if (!byCounterName.has(name)) byCounterName.set(name, new Map());
      byCounterName.get(name)!.set(labelsRaw, entry);
    }
    for (const [name, series] of byCounterName) {
      let help = "";
      const samples: string[] = [];
      for (const [labelsRaw, entry] of series) {
        help = entry.help;
        samples.push(`${name}${renderLabels(parseLabels(labelsRaw))} ${entry.value}`);
      }
      sections.push(`# HELP ${name} ${help}`);
      sections.push(`# TYPE ${name} counter`);
      sections.push(...samples);
    }
    const byGaugeName = new Map<string, Map<string, FeedGauge>>();
    for (const key of this.gaugeOrder) {
      const entry = this.gauges.get(key)!;
      const sep = key.indexOf("#");
      const name = key.slice(0, sep);
      const labelsRaw = key.slice(sep + 1);
      if (!byGaugeName.has(name)) byGaugeName.set(name, new Map());
      byGaugeName.get(name)!.set(labelsRaw, entry);
    }
    for (const [name, series] of byGaugeName) {
      let help = "";
      const samples: string[] = [];
      for (const [labelsRaw, entry] of series) {
        help = entry.help;
        samples.push(`${name}${renderLabels(parseLabels(labelsRaw))} ${entry.value}`);
      }
      sections.push(`# HELP ${name} ${help}`);
      sections.push(`# TYPE ${name} gauge`);
      sections.push(...samples);
    }
    return sections.length === 0 ? "" : `${sections.join("\n")}\n`;
  }

  /** Raw (typed) snapshot for unit tests. */
  public snapshot(): FeedMetricsSnapshot {
    const counters: FeedMetricsSnapshot["counters"] = [];
    const byCounterName = new Map<string, string[]>();
    for (const key of this.counterOrder) {
      const sep = key.indexOf("#");
      const name = key.slice(0, sep);
      if (!byCounterName.has(name)) byCounterName.set(name, []);
      byCounterName.get(name)!.push(key.slice(sep + 1));
    }
    for (const [name, keys] of byCounterName) {
      const samples: string[] = [];
      let help = "";
      for (const labelsRaw of keys) {
        const entry = this.counters.get(`${name}#${labelsRaw}`)!;
        help = entry.help;
        samples.push(`${name}${renderLabels(parseLabels(labelsRaw))} ${entry.value}`);
      }
      counters.push({ name, help, samples });
    }
    const gauges: FeedMetricsSnapshot["gauges"] = [];
    const byGaugeName = new Map<string, string[]>();
    for (const key of this.gaugeOrder) {
      const sep = key.indexOf("#");
      const name = key.slice(0, sep);
      if (!byGaugeName.has(name)) byGaugeName.set(name, []);
      byGaugeName.get(name)!.push(key.slice(sep + 1));
    }
    for (const [name, keys] of byGaugeName) {
      const samples: string[] = [];
      let help = "";
      for (const labelsRaw of keys) {
        const entry = this.gauges.get(`${name}#${labelsRaw}`)!;
        help = entry.help;
        samples.push(`${name}${renderLabels(parseLabels(labelsRaw))} ${entry.value}`);
      }
      gauges.push({ name, help, samples });
    }
    return { counters, gauges };
  }
}

/** Singleton bound to the live-feed ingestion + forex cascades. */
export const feedMetrics = new FeedMetricsRegistry();