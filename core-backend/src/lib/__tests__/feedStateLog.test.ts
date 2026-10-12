import { describe, it, expect, beforeEach } from "vitest";
import {
  categorizeFeedState,
  FeedStateReporter,
  FEED_STATE_SUMMARY_INTERVAL_MS,
} from "../feedStateLog";

const NOW = 1_700_000_000_000;

describe("categorizeFeedState — expected vs real (PART 44 [497])", () => {
  it("marks PO-offline conditions as expected (INFO)", () => {
    for (const detail of [
      "PO offline (proxy prices) feed restored via frankfurter",
      "all live spot rate sources exhausted, proxy prices fallback armed",
      "Pocket Option awaiting_ssid — live pair not covered",
      "PO session_expired: no ssid available",
    ]) {
      const cat = categorizeFeedState(detail);
      expect(cat.expected).toBe(true);
      expect(cat.label).toBe("po_offline");
    }
  });

  it("marks holding-last-known-good as expected holding_stale (INFO)", () => {
    const cat = categorizeFeedState(
      "Holding last known good price (age 42s) — live sources exhausted",
    );
    expect(cat).toEqual({ label: "holding_stale", expected: true });
  });

  it("marks market-closed conditions as expected market_closed (INFO)", () => {
    for (const detail of [
      "Market closed — pausing real-pair spot retries",
      "week closed, market reopens Monday",
    ]) {
      const cat = categorizeFeedState(detail);
      expect(cat.expected).toBe(true);
      expect(cat.label).toBe("market_closed");
    }
  });

  it("marks LINGER as a real failure state (ERROR)", () => {
    const cat = categorizeFeedState("Entering LINGER mode (stream stays alive)");
    expect(cat.expected).toBe(false);
    expect(cat.label).toBe("lingering");
  });

  it("defaults unknown diagnostics to feed_error (ERROR)", () => {
    for (const detail of [
      "Live feed returned null or invalid price rate",
      "connect ECONNREFUSED 127.0.0.1:443",
      "socket hang up",
      "",
      null,
    ]) {
      const cat = categorizeFeedState(detail as string);
      expect(cat.expected).toBe(false);
      expect(cat.label).toBe("feed_error");
    }
  });

  it("PO-offline / sources-exhausted is expected for OTC but ERROR for a REAL pair", () => {
    for (const detail of [
      "live sources exhausted",
      "all live spot rate sources exhausted",
      "PO offline (proxy prices)",
      "Pocket Option awaiting_ssid",
    ]) {
      expect(categorizeFeedState(detail, true)).toEqual({
        label: "po_offline",
        expected: true,
      });
      expect(categorizeFeedState(detail, false)).toEqual({
        label: "feed_error",
        expected: false,
      });
    }
    // market-closed / holding-stale stay expected for BOTH OTC and real pairs.
    for (const isOtc of [true, false]) {
      expect(categorizeFeedState("Market closed", isOtc).expected).toBe(true);
      expect(
        categorizeFeedState("Holding last known good price", isOtc).expected,
      ).toBe(true);
    }
  });
});

describe("FeedStateReporter — one line per state transition", () => {
  let reporter: FeedStateReporter;

  beforeEach(() => {
    reporter = new FeedStateReporter();
  });

  it("emits a transition OUTCOME on the first-ever report of a symbol", () => {
    const report = reporter.inspect("EUR/USD", "PO offline (proxy prices)", NOW);
    expect(report.outcome).not.toBeNull();
    expect(report.outcome!.symbol).toBe("EUR/USD");
    expect(report.outcome!.transitioned).toBe(true);
    expect(report.outcome!.from).toBeNull();
    expect(report.outcome!.to).toBe("po_offline");
    expect(report.outcome!.expected).toBe(true);
    expect(report.outcome!.logLevel).toBe("info");
    expect(report.outcome!.detail).toBe("PO offline (proxy prices)");
  });

  it("is SILENT on repeated reports of the same state (no per-retry spam)", () => {
    reporter.inspect("EUR/USD", "PO offline (proxy prices)", NOW);
    for (let i = 1; i <= 100; i += 1) {
      const again = reporter.inspect("EUR/USD", "PO offline (proxy prices)", NOW + i);
      expect(again.outcome).toBeNull();
    }
  });

  it("logs ERROR for a real failure state and INFO on recovery to online", () => {
    const fail = reporter.inspect("EUR/USD", "connect ECONNREFUSED 127.0.0.1:443", NOW);
    expect(fail.outcome!.to).toBe("feed_error");
    expect(fail.outcome!.logLevel).toBe("error");

    const online = reporter.markOnline("EUR/USD", "live feed restored via pocket_option_ssot", NOW + 1);
    expect(online.outcome!.to).toBe("online");
    expect(online.outcome!.from).toBe("feed_error");
    expect(online.outcome!.logLevel).toBe("info");
  });

  it("reports a LINGER transition at error level", () => {
    const report = reporter.inspect("EUR/USD", "Entering LINGER mode", NOW);
    expect(report.outcome!.to).toBe("lingering");
    expect(report.outcome!.logLevel).toBe("error");
  });

  it("tracks a proxy recovery as po_offline (expected INFO), not ONLINE", () => {
    const proxy = reporter.inspect(
      "GBP/USD",
      "PO offline (proxy prices) — feed restored via frankfurter",
      NOW,
    );
    expect(proxy.outcome!.to).toBe("po_offline");
    expect(proxy.outcome!.logLevel).toBe("info");

    const stillProxy = reporter.inspect("GBP/USD", "PO offline (proxy prices)", NOW + 5);
    expect(stillProxy.outcome).toBeNull();

    const genuinePo = reporter.markOnline(
      "GBP/USD",
      "live feed restored via pocket_option_ssot",
      NOW + 6,
    );
    expect(genuinePo.outcome!.to).toBe("online");
    expect(genuinePo.outcome!.logLevel).toBe("info");
  });

  it("normalizes symbols to uppercase and exposes stateOf/size", () => {
    reporter.inspect("eur/usd", "PO offline", NOW);
    expect(reporter.stateOf("EUR/USD")).toBe("po_offline");
    expect(reporter.stateOf("eur/usd")).toBe("po_offline");
    expect(reporter.size).toBe(1);
  });

  it("reset() clears all tracked state", () => {
    reporter.inspect("EUR/USD", "PO offline", NOW);
    reporter.reset();
    expect(reporter.stateOf("EUR/USD")).toBeNull();
    expect(reporter.size).toBe(0);
  });
});

describe("FeedStateReporter — the 60s summary", () => {
  it("does NOT summarize on the first report (the transition line is enough)", () => {
    const reporter = new FeedStateReporter();
    const report = reporter.inspect("EUR/USD", "PO offline", NOW);
    expect(report.summary).toBeNull();
  });

  it("emits a compact per-symbol summary once per 60s", () => {
    const reporter = new FeedStateReporter();
    expect(FEED_STATE_SUMMARY_INTERVAL_MS).toBe(60_000);

    reporter.inspect("EUR/USD", "PO offline", NOW);
    reporter.inspect("GBP/USD", "connect ECONNREFUSED", NOW + 1);

    // 30s in — too soon.
    const early = reporter.inspect("EUR/USD", "PO offline", NOW + 30_000);
    expect(early.summary).toBeNull();

    // 60s in — summary due, includes both symbols with elapsed durations.
    const due = reporter.markOnline("EUR/USD", "live feed restored", NOW + 60_000);
    expect(due.summary).not.toBeNull();
    expect(due.summary!.intervalMs).toBe(60_000);
    const rows = due.summary!.per_symbol;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.symbol === "EUR/USD")).toEqual({
      symbol: "EUR/USD",
      state: "online",
      // It just transitioned to online at this same instant → 0s in this state.
      forSec: 0,
    });
    expect(rows.find((r) => r.symbol === "GBP/USD")!.state).toBe("feed_error");
  });

  it("rate-limits the summary to once per interval even with many reports", () => {
    const reporter = new FeedStateReporter({ summaryIntervalMs: 1_000 });
    reporter.inspect("EUR/USD", "PO offline", NOW);
    // 1s later summary 1.
    reporter.inspect("EUR/USD", "PO offline", NOW + 1_000);
    // 199ms later: no second summary.
    const noDup = reporter.inspect("EUR/USD", "PO offline", NOW + 1_199);
    expect(noDup.summary).toBeNull();
    // Full second later: summary 2.
    const dup = reporter.inspect("EUR/USD", "PO offline", NOW + 2_199);
    expect(dup.summary).not.toBeNull();
  });
});