/**
 * assetHistoryAudit.test.ts — PART 44 [495] DATA PROVENANCE AUDIT (PURE).
 *
 * Pins the three-class provenance separation (PO / non-PO / unstamped) and the
 * OTC-integrity verdicts the CLI acts on. Pure analysis — no DB.
 */

import { describe, expect, it } from "vitest";
import {
  classifySource,
  isFlatBar,
  summarizeAssetHistory,
  AssetHistoryBarRow,
} from "../assetHistoryAudit";

function row(partial: Partial<AssetHistoryBarRow> & Pick<AssetHistoryBarRow, "symbol">): AssetHistoryBarRow {
  return {
    symbol: partial.symbol,
    timeframe: partial.timeframe ?? "1m",
    bucketStartMs: partial.bucketStartMs ?? 1000,
    open: partial.open ?? 1.1,
    high: partial.high ?? 1.1,
    low: partial.low ?? 1.1,
    close: partial.close ?? 1.1,
    volume: partial.volume ?? null,
    tickCount: partial.tickCount ?? 1,
    source: partial.source ?? null,
  };
}

describe("classifySource", () => {
  it("names Pocket Option feeds as po", () => {
    expect(classifySource("pocket_option")).toBe("po");
    expect(classifySource("pocket_option:ssid")).toBe("po");
    expect(classifySource("pocket_option_ssot")).toBe("po");
    expect(classifySource("POCKET_OPTION")).toBe("po");
  });

  it("names every other feed nonPo", () => {
    for (const src of ["frankfurter", "open_er_api", "coingecko", "github_data_provider", "ai_engine", "held_stale_real"]) {
      expect(classifySource(src)).toBe("nonPo");
    }
  });

  it("treats absent/blank stamps as unstamped", () => {
    expect(classifySource(null)).toBe("unstamped");
    expect(classifySource(undefined)).toBe("unstamped");
    expect(classifySource("")).toBe("unstamped");
    expect(classifySource("  ")).toBe("unstamped");
  });
});

describe("isFlatBar", () => {
  it("flags verbatim O===H===L===C monotony", () => {
    expect(isFlatBar({ open: 1.085, high: 1.085, low: 1.085, close: 1.085 })).toBe(true);
  });
  it("does not flag a real OHLC bar", () => {
    expect(isFlatBar({ open: 1.08, high: 1.09, low: 1.07, close: 1.085 })).toBe(false);
  });
});

describe("summarizeAssetHistory — provenance verdicts", () => {
  it("applauds a fully PO-sourced OTC universe", () => {
    const summary = summarizeAssetHistory([
      row({ symbol: "EURUSD", source: "pocket_option", tickCount: 60 }),
      row({ symbol: "EURUSD", source: "pocket_option:ssid", tickCount: 58 }),
      row({ symbol: "GBPUSD", source: "pocket_option" }),
    ]);
    expect(summary.otcProxyBarCount).toBe(0);
    expect(summary.otcUnstampedBarCount).toBe(0);
    expect(summary.totalPoSourcedBars).toBe(3);
    expect(summary.verdicts.some((v) => v.includes("All 3 OTC bar(s) are PO-sourced"))).toBe(true);
  });

  it("flags OTC bars authored by a non-PO feed as proxy faults", () => {
    const summary = summarizeAssetHistory([
      row({ symbol: "EURUSD", source: "pocket_option" }),
      row({ symbol: "EURUSD", source: "frankfurter", bucketStartMs: 2000, close: 1.09 }),
    ]);
    expect(summary.otcProxyBarCount).toBe(1);
    const report = summary.perSymbol.find((s) => s.symbol === "EURUSD")!;
    expect(report.otcProxyBarCount).toBe(1);
    expect(report.otcProxyBars[0].source).toBe("frankfurter");
    expect(report.otcProxyBars[0].reason).toMatch(/non-PO feed/);
    expect(summary.otcUnstampedBarCount).toBe(0);
    expect(summary.verdicts.some((v) => v.includes("DATA-INTEGRITY FAULT"))).toBe(true);
  });

  it("reports unstamped OTC bars as legacy, never as PO — and never auto-deletes", () => {
    const summary = summarizeAssetHistory([row({ symbol: "EURUSD", source: null })]);
    expect(summary.otcUnstampedBarCount).toBe(1);
    expect(summary.otcProxyBarCount).toBe(0);
    const report = summary.perSymbol[0];
    expect(report.otcUnstampedBars).toHaveLength(1);
    expect(report.otcProxyBars).toHaveLength(0);
    expect(summary.verdicts.some((v) => v.includes("no provenance stamp"))).toBe(true);
  });

  it("AU: proxy tape for NON-OTC symbols is honest, not a fault", () => {
    const summary = summarizeAssetHistory([
      row({ symbol: "BTC/USD", source: "coingecko" }),
      row({ symbol: "BTC/USD", source: "frankfurter" }),
    ]);
    expect(summary.otcProxyBarCount).toBe(0);
    expect(summary.otcUnstampedBarCount).toBe(0);
    expect(summary.totalNonPoSourcedBars).toBe(2);
  });

  it("per-symbol counters aggregate tick + flat stats", () => {
    const summary = summarizeAssetHistory([
      row({ symbol: "EURUSD", source: "pocket_option", tickCount: 50, close: 1.11 }),
      row({ symbol: "EURUSD", source: "pocket_option", tickCount: 30, close: 1.2, high: 1.3, low: 1.0 }),
      row({ symbol: "EURUSD", source: "pocket_option", tickCount: 20, close: 1.09 }),
    ]);
    const report = summary.perSymbol[0];
    expect(report.bars).toBe(3);
    expect(report.flatBars).toBe(0);
    expect(report.tickCountSum).toBe(100);
    expect(report.tickCountMin).toBe(20);
    expect(report.tickCountMax).toBe(50);
    // bucketStartMs unique for each in this fixture → min/max present
    expect(report.minBucketMs).toBe(1000);
    expect(report.maxBucketMs).toBe(1000);
  });

  it("flags a wholly-flat symbol with the monotony verdict", () => {
    const summary = summarizeAssetHistory([
      row({ symbol: "EURUSD", source: "pocket_option", open: 1.085, high: 1.085, low: 1.085, close: 1.085, tickCount: 60 }),
      row({ symbol: "EURUSD", source: "pocket_option", open: 1.085, high: 1.085, low: 1.085, close: 1.085, tickCount: 60 }),
    ]);
    expect(summary.totalFlatBars).toBe(2);
    expect(summary.verdicts.some((v) => v.includes("MONOTONY"))).toBe(true);
  });

  it("handles an empty store with an honest 'nothing to audit' verdict", () => {
    const summary = summarizeAssetHistory([]);
    expect(summary.totalBars).toBe(0);
    expect(summary.perSymbol).toEqual([]);
    expect(summary.verdicts[0]).toMatch(/No persisted AssetHistory rows/);
  });
});