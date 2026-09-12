import { describe, it, expect } from "vitest";
import {
  exponentialBackoffMs,
  FEED_BACKOFF_LADDER_MS,
  classifyFeedLog,
  shouldEmitSignal,
  MIN_REAL_PRICES_FOR_SIGNAL,
  renderFallbackChainLog,
} from "../feedResilience";
import { FeedMetricsRegistry } from "../feedMetrics";

/**
 * Byte-conform tests for the live-feed resilience policy (mission [6]).
 * Pure functions only — no timers, no network, no services touched.
 */

describe("exponentialBackoffMs (mission [2])", () => {
  it("grows 1s → 2s → 5s → 10s → 30s → 60s for attempts 1..6+", () => {
    const cap = FEED_BACKOFF_LADDER_MS[FEED_BACKOFF_LADDER_MS.length - 1];
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const ms = exponentialBackoffMs(attempt, 1_700_000_000_000);
      const expectBase = FEED_BACKOFF_LADDER_MS[Math.min(attempt - 1, 5)];
      // ±20% jitter window around the ladder base, capped at 60s.
      expect(ms).toBeGreaterThanOrEqual(Math.round(expectBase * 0.8));
      expect(ms).toBeLessThanOrEqual(Math.min(expectBase * 1.2, cap));
    }
  });

  it("clamps to the 60s cap once the ladder is exhausted", () => {
    const cap = FEED_BACKOFF_LADDER_MS[FEED_BACKOFF_LADDER_MS.length - 1];
    for (let attempt = 7; attempt <= 25; attempt += 1) {
      expect(exponentialBackoffMs(attempt, 42)).toBeLessThanOrEqual(cap);
    }
  });

  it("never returns a zero/frozen delay across jitter seeds", () => {
    for (let now = 0; now < 60_000; now += 1337) {
      expect(exponentialBackoffMs(1, now)).toBeGreaterThan(0);
      expect(exponentialBackoffMs(5, now)).toBeGreaterThan(0);
      expect(exponentialBackoffMs(9, now)).toBeGreaterThan(0);
    }
  });

  it("never exceeds 60s even with adversarial inputs", () => {
    const cap = FEED_BACKOFF_LADDER_MS[FEED_BACKOFF_LADDER_MS.length - 1];
    expect(exponentialBackoffMs(Number.NaN, Date.now())).toBeLessThanOrEqual(cap);
    expect(exponentialBackoffMs(-3, Date.now())).toBeLessThanOrEqual(cap);
    expect(exponentialBackoffMs(Number.POSITIVE_INFINITY, Date.now())).toBeLessThanOrEqual(cap);
  });
});

describe("classifyFeedLog — per-symbol log rate limit (mission [3])", () => {
  it("warns exactly on the first failure of an incident", () => {
    const cls = classifyFeedLog(1, false);
    expect(cls.level).toBe("warn");
    expect(cls.isFirst).toBe(true);
    expect(cls.isEveryTenth).toBe(false);
  });

  it("errors only on every 10th consecutive failure", () => {
    for (let n = 2; n <= 30; n += 1) {
      const cls = classifyFeedLog(n, false);
      if (n % 10 === 0) {
        expect(cls.level).toBe("error");
        expect(cls.isEveryTenth).toBe(true);
      } else {
        expect(cls.level).toBe("silent");
      }
    }
  });

  it("stays fully silent for the 9 retries between error log lines", () => {
    // failures 2..9 and 11..19 and 21..29 must be silent (no per-retry spam).
    const silentRuns = [[2, 9], [11, 19], [21, 29]];
    for (const [from, to] of silentRuns) {
      for (let n = from; n <= to; n += 1) {
        expect(classifyFeedLog(n, false).level).toBe("silent");
      }
    }
  });

  it("logs info exactly on recovery (tenth — a success after failures)", () => {
    const cls = classifyFeedLog(0, true);
    expect(cls.level).toBe("info");
    expect(cls.isRecovery).toBe(true);
  });

  it("never spams error/warn on a healthy zero-count stream", () => {
    const healthy = classifyFeedLog(0, false);
    expect(healthy.level).toBe("silent");
    expect(healthy.isRecovery).toBe(false);
  });
});

describe("DEGRADED ⇒ NO SIGNAL gate (mission [5])", () => {
  it("never emits a signal while a feed is degraded", () => {
    expect(shouldEmitSignal(10, true)).toBe(false);
    expect(shouldEmitSignal(5, true)).toBe(false);
    expect(shouldEmitSignal(2, true)).toBe(false);
    expect(shouldEmitSignal(0, true)).toBe(false);
  });

  it("requires at least N real prices before any emission when healthy", () => {
    expect(MIN_REAL_PRICES_FOR_SIGNAL).toBe(2);
    expect(shouldEmitSignal(0, false)).toBe(false);
    expect(shouldEmitSignal(1, false)).toBe(false);
    expect(shouldEmitSignal(2, false)).toBe(true);
    expect(shouldEmitSignal(8, false)).toBe(true);
  });

  it("treats missing/fabricated price counts as NO signal", () => {
    expect(shouldEmitSignal(Number.NaN, false)).toBe(false);
    expect(shouldEmitSignal(-1, false)).toBe(false);
  });
});

describe("renderFallbackChainLog — chain audit with source + reason (mission [4])", () => {
  it("renders OK and FAIL(reason) per source in order", () => {
    const log = renderFallbackChainLog([
      { source: "frankfurter", ok: true },
      { source: "open_er_api", ok: false, reason: "timeout" },
      { source: "coingecko", ok: false, reason: "429" },
    ]);
    expect(log).toBe("frankfurter=OK → open_er_api=FAIL(timeout) → coingecko=FAIL(429)");
  });

  it("handles an empty chain and a bare reason-less failure", () => {
    expect(renderFallbackChainLog([])).toBe("fallback chain empty");
    expect(renderFallbackChainLog([{ source: "x", ok: false }])).toBe("x=FAIL");
  });
});

describe("FeedMetricsRegistry — Prometheus counters/gauges (mission [7])", () => {
  it("emits monotonic feed_retry_total with symbol+reason labels", () => {
    const reg = new FeedMetricsRegistry();
    reg.countRetry("EUR/USD", "timeout");
    reg.countRetry("EUR/USD", "timeout");
    reg.countRetry("BTC/USD", "429");
    const snap = reg.snapshot();
    const retry = snap.counters.find((c) => c.name === "feed_retry_total")!;
    expect(retry.samples).toContain('feed_retry_total{reason="timeout",symbol="EUR/USD"} 2');
    expect(retry.samples).toContain('feed_retry_total{reason="429",symbol="BTC/USD"} 1');
  });

  it("counts errors and recoveries on their own series", () => {
    const reg = new FeedMetricsRegistry();
    reg.countError("GBP/USD", "500");
    reg.countRecovery("GBP/USD");
    const snap = reg.snapshot();
    expect(snap.counters.map((c) => c.name).sort()).toEqual(
      ["feed_error_total", "feed_recovery_total"].sort(),
    );
    expect(snap.counters.find((c) => c.name === "feed_error_total")!.samples[0]).toBe(
      'feed_error_total{reason="500",symbol="GBP/USD"} 1',
    );
    expect(snap.counters.find((c) => c.name === "feed_recovery_total")!.samples[0]).toBe(
      'feed_recovery_total{symbol="GBP/USD"} 1',
    );
  });

  it("records backoff + error-watermark gauges and renders Prometheus text format", () => {
    const reg = new FeedMetricsRegistry();
    reg.setBackoffMs("EUR/USD", 2000);
    reg.setMaxConsecutiveErrors("EUR/USD", 6);
    reg.countRetry("EUR/USD", "timeout");

    const scrape = reg.scrape();
    expect(scrape).toContain("# TYPE feed_retry_total counter");
    expect(scrape).toContain('feed_retry_total{reason="timeout",symbol="EUR/USD"} 1');
    expect(scrape).toContain("# TYPE feed_backoff_ms gauge");
    expect(scrape).toContain('feed_backoff_ms{symbol="EUR/USD"} 2000');
    expect(scrape).toContain("# TYPE feed_lingering_max_errors gauge");
    expect(scrape).toContain('feed_lingering_max_errors{symbol="EUR/USD"} 6');
    expect(scrape.endsWith("\n")).toBe(true);
  });

  it("scrapes empty to an empty string and never throws on unknown label sets", () => {
    const reg = new FeedMetricsRegistry();
    expect(reg.scrape()).toBe("");
    reg.incrementCounter("x_total", { a: "b", c: "d" }, "help");
    expect(reg.scrape()).toContain('x_total{a="b",c="d"} 1');
    reg.incrementCounter("x_total", { a: "b", c: "d" }, "help", 7);
    expect(reg.scrape()).toContain('x_total{a="b",c="d"} 8');
  });
});