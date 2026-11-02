import { describe, expect, it } from "vitest";

import { forexDataService } from "../../services/forexData.service";

const BASE = 1_700_000_000_000;

describe("forexData M20 (20-second) builders", () => {
  it("builds 20s buckets from the PO tick timestamp, not the host clock", () => {
    const symbol = "TST/20S";
    forexDataService.appendTick(symbol, 1.1, { tsMs: BASE });
    forexDataService.appendTick(symbol, 1.2, { tsMs: BASE + 10_000 });
    forexDataService.appendTick(symbol, 1.3, { tsMs: BASE + 20_000 });
    forexDataService.appendTick(symbol, 1.4, { tsMs: BASE + 30_000 });

    const bars = forexDataService.getLiveCandles(symbol, "20s");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({
      timestamp: BASE,
      open: 1.1,
      close: 1.2,
    });
    expect(bars[1]).toMatchObject({
      timestamp: BASE + 20_000,
      close: 1.4,
    });
  });

  it("stores a bridge M20 candle verbatim on the S20 series", () => {
    const symbol = "PO20/USD";
    const candle = forexDataService.ingestPoCandle(
      symbol,
      BASE,
      { open: 1.1, high: 1.25, low: 1.08, close: 1.2 },
      true,
      "otc",
    );

    expect(candle).not.toBeNull();
    expect(forexDataService.getLiveCandle(symbol, "20s")).toMatchObject({
      timestamp: BASE,
      open: 1.1,
      high: 1.25,
      low: 1.08,
      close: 1.2,
    });
  });
});
