import { describe, expect, it } from "vitest";

import {
  SIGNAL_SCHEMA_VERSION,
  TradingSignalSchema,
  buildTradingSignal,
  deriveSignalEventId,
  deriveSignalRequestId,
} from "../../messaging/signalContract";

const base = (over: Record<string, unknown> = {}) => ({
  symbol: "EUR/USD",
  signal_type: "BUY",
  confidence: 98,
  confidence_unit: "percent",
  current_price: 1.1042,
  target_price: 1.1048,
  horizon_minutes: 1,
  timeframe: "1m",
  timestamp: "2026-11-06T12:00:30.000Z",
  executable: true,
  dispatchable: true,
  market_waiting: false,
  ...over,
});

describe("TradingSignalSchema", () => {
  it("adds the version and a derived event id", () => {
    const signal = buildTradingSignal(base());
    expect(signal).not.toBeNull();
    expect(signal?.schema_version).toBe(SIGNAL_SCHEMA_VERSION);
    expect(signal?.event_id).toHaveLength(32);
  });

  it("keeps unknown diagnostic fields", () => {
    const signal = buildTradingSignal(base({ custom_diagnostic: { x: 1 } }));
    expect((signal as Record<string, unknown>).custom_diagnostic).toEqual({ x: 1 });
  });

  it("refuses an executable signal with no AI target", () => {
    expect(buildTradingSignal(base({ target_price: null }))).toBeNull();
  });

  it("does not accept take_profit as a substitute for AI target_price", () => {
    expect(
      buildTradingSignal(
        base({ target_price: null, take_profit: 1.1048 }),
      ),
    ).toBeNull();
  });

  it("refuses a signal without an explicit confidence unit", () => {
    const payload = base();
    delete (payload as Record<string, unknown>).confidence_unit;
    expect(buildTradingSignal(payload)).toBeNull();
  });

  it("refuses conflicting confidence aliases", () => {
    expect(
      buildTradingSignal(base({ confidence_score: 97.0 })),
    ).toBeNull();
  });

  it("refuses conflicting signal direction aliases", () => {
    expect(
      buildTradingSignal(base({ signal: "SELL" })),
    ).toBeNull();
  });

  it("refuses an unsupported explicit schema version", () => {
    expect(buildTradingSignal(base({ schema_version: "2.0.0" }))).toBeNull();
  });

  it("refuses an executable signal with no AI horizon", () => {
    expect(buildTradingSignal(base({ horizon_minutes: null }))).toBeNull();
  });

  it("refuses a BUY target at or below the live price", () => {
    expect(buildTradingSignal(base({ target_price: 1.1042 }))).toBeNull();
  });

  it("refuses a SELL target at or above the live price", () => {
    expect(
      buildTradingSignal(
        base({ signal_type: "SELL", target_price: 1.1048 }),
      ),
    ).toBeNull();
  });

  it("allows a waiting rider without direction/target", () => {
    const signal = buildTradingSignal({
      symbol: "EUR/USD",
      signal_type: null,
      confidence: 40,
      confidence_unit: "percent",
      current_price: 1.1042,
      target_price: null,
      horizon_minutes: null,
      timestamp: "2026-11-06T12:00:30.000Z",
      market_waiting: true,
      executable: false,
      dispatchable: false,
    });
    expect(signal).not.toBeNull();
    expect(signal?.market_waiting).toBe(true);
  });

  it("refuses a waiting rider stamped executable", () => {
    expect(
      buildTradingSignal(
        base({
          signal_type: null,
          target_price: null,
          horizon_minutes: null,
          market_waiting: true,
          executable: true,
        }),
      ),
    ).toBeNull();
  });
});

describe("event and request identity", () => {
  it("is stable for the same verdict inside the same minute", () => {
    const a = deriveSignalEventId(base());
    const b = deriveSignalEventId(base({ timestamp: "2026-11-06T12:00:59.000Z" }));
    expect(a).toBe(b);
  });

  it("changes for the same verdict in the next minute", () => {
    const a = deriveSignalEventId(base());
    const b = deriveSignalEventId(base({ timestamp: "2026-11-06T12:01:00.000Z" }));
    expect(a).not.toBe(b);
  });

  it("changes when the AI target changes", () => {
    const a = deriveSignalEventId(base());
    const b = deriveSignalEventId(base({ target_price: 1.1050 }));
    expect(a).not.toBe(b);
  });

  it("derives a request id independent of the verdict fields", () => {
    const a = deriveSignalRequestId(base());
    const b = deriveSignalRequestId({
      symbol: "EUR/USD",
      timeframe: "1m",
      horizon_minutes: 1,
      timestamp: "2026-11-06T12:00:30.000Z",
    });
    expect(a).toBe(b);
  });

  it("exposes the schema to consumers", () => {
    expect(TradingSignalSchema.safeParse(buildTradingSignal(base())).success).toBe(
      true,
    );
  });
});
