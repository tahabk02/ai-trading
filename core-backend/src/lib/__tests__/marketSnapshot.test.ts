import { describe, expect, it } from "vitest";

import {
  MarketSnapshotService,
  marketCandleKey,
  marketTickKey,
  type MarketTickSnapshot,
} from "../../services/marketSnapshot.service";

type Write = { key: string; value: unknown; ttlSeconds: number };

function serviceWithWrites(writes: Write[]): MarketSnapshotService {
  return new MarketSnapshotService(async (key, value, ttlSeconds) => {
    writes.push({ key, value, ttlSeconds });
  });
}

describe("MarketSnapshotService", () => {
  it("coalesces a burst of ticks into the latest bid/ask/volume snapshot", async () => {
    const writes: Write[] = [];
    const service = serviceWithWrites(writes);

    service.recordTick({
      symbol: "eur/usd",
      price: 1.1001,
      bid: 1.1,
      ask: 1.1002,
      volume: 10,
      tsMs: 1_000,
      source: "pocket_option",
      assetType: "otc",
    });
    service.recordTick({
      symbol: "EUR/USD",
      price: 1.1002,
      bid: 1.1001,
      ask: 1.1003,
      volume: 5,
      tsMs: 1_500,
      source: "pocket_option",
      assetType: "otc",
    });

    expect(writes).toHaveLength(0);
    await service.flushNow();

    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe(marketTickKey("EUR/USD"));
    const payload = writes[0].value as MarketTickSnapshot;
    expect(payload).toMatchObject({
      symbol: "EUR/USD",
      price: 1.1002,
      bid: 1.1001,
      ask: 1.1003,
      volume: 5,
      volumeTotal: 15,
      tickCount: 2,
      source: "pocket_option",
      assetType: "otc",
      tsMs: 1_500,
    });
    expect(payload.spread).toBeCloseTo(0.0002);
    expect(payload.tickRate).toBeGreaterThan(0);
    expect(service.getMetrics().pendingTickWrites).toBe(0);
  });

  it("rejects crossed or invalid books without inventing a spread", async () => {
    const writes: Write[] = [];
    const service = serviceWithWrites(writes);

    service.recordTick({
      symbol: "GBP/USD",
      price: 1.25,
      bid: 1.26,
      ask: 1.24,
      volume: 1,
      tsMs: 1_000,
      source: "pocket_option",
    });
    service.recordTick({
      symbol: "GBP/USD",
      price: Number.NaN,
      bid: 1.2,
      ask: 1.3,
      tsMs: 1_100,
      source: "pocket_option",
    });

    await service.flushNow();
    const payload = writes[0].value as MarketTickSnapshot;
    expect(payload.bid).toBeNull();
    expect(payload.ask).toBeNull();
    expect(payload.spread).toBeNull();
    expect(payload.tickCount).toBe(1);
  });

  it("writes the latest closed candle per symbol/timeframe", async () => {
    const writes: Write[] = [];
    const service = serviceWithWrites(writes);

    service.recordCandle({
      symbol: "EUR/USD",
      timeframe: "s20",
      timestamp: 1_700_000_000_000,
      open: 1.1,
      high: 1.2,
      low: 1.09,
      close: 1.15,
      volume: 42,
      closed: true,
    });
    service.recordCandle({
      symbol: "EUR/USD",
      timeframe: "S20",
      timestamp: 1_700_000_020_000,
      open: 1.15,
      high: 1.18,
      low: 1.14,
      close: 1.17,
      volume: 7,
      closed: true,
    });

    await service.flushNow();

    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe(marketCandleKey("EUR/USD", "S20"));
    expect(writes[0].value).toMatchObject({
      symbol: "EUR/USD",
      timeframe: "S20",
      timestamp: 1_700_000_020_000,
      close: 1.17,
      volume: 7,
      closed: true,
      isFinal: true,
    });
  });

  it("keeps failed writes pending for the next flush", async () => {
    let fail = true;
    const writes: Write[] = [];
    const service = new MarketSnapshotService(async (key, value, ttlSeconds) => {
      if (fail) throw new Error("redis down");
      writes.push({ key, value, ttlSeconds });
    });

    service.recordTick({
      symbol: "USD/JPY",
      price: 150,
      tsMs: 1_000,
      source: "pocket_option",
    });
    await service.flushNow();

    expect(writes).toHaveLength(0);
    expect(service.getMetrics().pendingTickWrites).toBe(1);
    expect(service.getMetrics().errorCount).toBe(1);

    fail = false;
    await service.flushNow();
    expect(writes).toHaveLength(1);
    expect(service.getMetrics().pendingTickWrites).toBe(0);
  });
});
