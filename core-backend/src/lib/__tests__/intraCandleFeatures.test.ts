import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeBollinger,
  computeIntraCandleVelocity,
  computeWickMetrics,
  detectIntraCandlePullback,
  type IntraCandleInput,
  type IntraCandleOhlc,
  type IntraCandleTick,
} from "../intraCandleFeatures";
import { realtimeCandleAggregatorService } from "../../services/realtimeCandleAggregator.service";

const MIN = 60_000;
const BASE = Math.floor(1_800_000_000_000 / MIN) * MIN;

function flatM1Bars(count: number, high = 1.105): IntraCandleOhlc[] {
  const bars: IntraCandleOhlc[] = [];
  for (let index = 0; index < count; index += 1) {
    bars.push({
      open: 1.102,
      high,
      low: 1.1,
      close: 1.1025,
      volume: 10,
    });
  }
  return bars;
}

function microBars(): { forming: IntraCandleOhlc; closed: IntraCandleOhlc[] } {
  const closed: IntraCandleOhlc[] = [];
  for (let index = 0; index < 20; index += 1) {
    closed.push({
      open: 1.103,
      high: 1.1032,
      low: 1.103,
      close: 1.1031,
      volume: 2,
    });
  }
  return {
    closed,
    forming: {
      open: 1.104,
      high: 1.106,
      low: 1.103,
      close: 1.103,
      volume: 6,
    },
  };
}

function rejectionTape(): IntraCandleTick[] {
  return [
    { tsMs: 0, price: 1.1 },
    { tsMs: 5_000, price: 1.101 },
    { tsMs: 10_000, price: 1.1015 },
    { tsMs: 15_000, price: 1.104 },
    { tsMs: 16_000, price: 1.1048 },
    { tsMs: 17_000, price: 1.1056 },
    { tsMs: 18_000, price: 1.106 },
    { tsMs: 19_000, price: 1.1057 },
    { tsMs: 20_000, price: 1.1054 },
  ];
}

function upperRejectionInput(): IntraCandleInput {
  const micro = microBars();
  return {
    symbol: "EUR/USD",
    timeframe: "M1",
    nowMs: 20_000,
    forming: {
      open: 1.102,
      high: 1.106,
      low: 1.1015,
      close: 1.1025,
      volume: 9,
    },
    closed: flatM1Bars(20),
    microForming: micro.forming,
    microClosed: micro.closed,
    tape: rejectionTape(),
  };
}

describe("intra-candle wick geometry", () => {
  it("splits the range into upper wick, lower wick and body ratios", () => {
    const metrics = computeWickMetrics({
      open: 1.1,
      high: 1.12,
      low: 1.09,
      close: 1.11,
    });
    expect(metrics.range).toBeCloseTo(0.03, 8);
    expect(metrics.upperWickRatio).toBeCloseTo(0.01 / 0.03, 8);
    expect(metrics.lowerWickRatio).toBeCloseTo(0.01 / 0.03, 8);
    expect(metrics.bodyRatio).toBeCloseTo(0.01 / 0.03, 8);
    expect(metrics.direction).toBe("up");
  });

  it("computes Bollinger bands from closes", () => {
    const band = computeBollinger(
      Array.from({ length: 20 }, (_, index) => 1.1 + index * 0.0001),
    );
    expect(band).not.toBeNull();
    expect(band!.upper).toBeGreaterThan(band!.middle);
    expect(band!.lower).toBeLessThan(band!.middle);
    expect(band!.sampleCount).toBe(20);
  });
});

describe("intra-candle velocity and pullback", () => {
  it("measures a 5s spike that decelerates into a reversal", () => {
    const velocity = computeIntraCandleVelocity(rejectionTape(), 0.0002, 20_000);
    expect(velocity.available).toBe(true);
    expect(velocity.direction).toBe("up");
    expect(velocity.spike).toBe(true);
    expect(velocity.decelerating).toBe(true);
    expect(velocity.delta5).toBeCloseTo(0.0014, 8);
  });

  it("flags an upper-wick rejection as a PUT at a resistance boundary", () => {
    const features = detectIntraCandlePullback(upperRejectionInput());
    expect(features.wick.upperWickRatio).toBeGreaterThan(0.55);
    expect(features.wickRejection.alert).toBe(true);
    expect(features.wickRejection.side).toBe("upper");
    expect(features.boundaries.boundaryKind).toBe("resistance");
    expect(features.exhaustion.detected).toBe(true);
    expect(features.confluence.microValidated).toBe(true);
    expect(features.pullback.signal).toBe("PUT");
    expect(features.pullback.entryTiming).toBe("now");
    expect(features.pullback.tierEligible).toBe(true);
  });

  it("keeps the alert but withholds the signal without micro-tape validation", () => {
    const input = upperRejectionInput();
    input.microForming = {
      open: 1.102,
      high: 1.1023,
      low: 1.102,
      close: 1.1022,
      volume: 2,
    };
    const tape = rejectionTape();
    tape[6].price = 1.105;
    tape[7].price = 1.1052;
    tape[8].price = 1.1054;
    input.tape = tape;
    const features = detectIntraCandlePullback(input);
    expect(features.wickRejection.alert).toBe(true);
    expect(features.confluence.microValidated).toBe(false);
    expect(features.pullback.signal).toBeNull();
  });

  it("maps a validated lower-wick reversal to CALL", () => {
    const micro = microBars();
    micro.forming = {
      open: 1.102,
      high: 1.102,
      low: 1.095,
      close: 1.098,
      volume: 6,
    };
    const tape = rejectionTape().map((tick) => ({
      tsMs: tick.tsMs,
      price: 2.2 - tick.price,
    }));
    const features = detectIntraCandlePullback({
      symbol: "EUR/USD",
      timeframe: "M1",
      nowMs: 20_000,
      forming: {
        open: 1.103,
        high: 1.1045,
        low: 1.095,
        close: 1.102,
        volume: 9,
      },
      closed: flatM1Bars(20, 1.104).map((bar) => ({ ...bar, low: 1.096 })),
      microForming: micro.forming,
      microClosed: micro.closed,
      tape,
    });
    expect(features.wickRejection.side).toBe("lower");
    expect(features.pullback.signal).toBe("CALL");
  });
});

describe("realtimeCandleAggregator intra-candle surface", () => {
  beforeEach(() => realtimeCandleAggregatorService.destroy());
  afterEach(() => realtimeCandleAggregatorService.destroy());

  it("returns canonical M1 forming features with the S5 micro tape", () => {
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.1, BASE);
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.101, BASE + 20_000);
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.1005, BASE + MIN);
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.1015, BASE + 65_000);
    realtimeCandleAggregatorService.addTick("EUR/USD", 1.102, BASE + 70_000);

    const features = realtimeCandleAggregatorService.getIntraCandleFeatures(
      "EURUSD",
      "1m",
    );
    expect(features).not.toBeNull();
    expect(features!.symbol).toBe("EUR/USD");
    expect(features!.timeframe).toBe("M1");
    expect(features!.forming.close).toBe(1.102);
    expect(features!.velocity.sampleCount).toBeGreaterThanOrEqual(3);
    expect(features!.confluence.microTimeframe).toBe("S5");
  });

  it("returns null until a forming bucket exists", () => {
    expect(
      realtimeCandleAggregatorService.getIntraCandleFeatures("EUR/USD", "M1"),
    ).toBeNull();
  });
});
