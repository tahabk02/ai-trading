import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  alignExpiryToTimeframe,
  expiryClockLabel,
  resolveEntryMarker,
  resolveTradeExpiryMs,
  resolveTradeOverlay,
  samePrice,
} from "@/lib/tradeOverlay";

const ENTRY_MS = 1_700_000_040_000; // 2023-11-14T22:14:00Z
const BASE = {
  isTradeActive: false,
  tradeEntryPrice: null,
  tradeDirection: null,
  tradeEntryEpochMs: null,
  tradeExpiresAtMs: null,
  expirationSeconds: 60,
  signalDirection: null,
  signalAnchorPrice: null,
  timeframeSeconds: 60,
} as const;

describe("resolveEntryMarker — trade fill wins over signal anchor", () => {
  it("labels an active position from its broker entry and direction", () => {
    expect(
      resolveEntryMarker({
        ...BASE,
        isTradeActive: true,
        tradeEntryPrice: 1.0842,
        tradeDirection: "CALL",
        signalDirection: "BUY",
        signalAnchorPrice: 1.0839,
      }),
    ).toEqual({ price: 1.0842, label: "ENTRY CALL", source: "trade" });
  });

  it("falls back to the selected signal when no position is open", () => {
    expect(
      resolveEntryMarker({
        ...BASE,
        signalDirection: "BUY",
        signalAnchorPrice: 1.0839,
      }),
    ).toEqual({ price: 1.0839, label: "SIGNAL ENTRY", source: "signal" });
  });

  it("does not invent an entry for HOLD / missing / non-positive anchors", () => {
    expect(resolveEntryMarker(BASE)).toBeNull();
    expect(
      resolveEntryMarker({ ...BASE, signalDirection: "HOLD", signalAnchorPrice: 1.1 }),
    ).toBeNull();
    expect(
      resolveEntryMarker({ ...BASE, signalDirection: "SELL", signalAnchorPrice: 0 }),
    ).toBeNull();
    expect(
      resolveEntryMarker({ ...BASE, signalDirection: "SELL", signalAnchorPrice: Number.NaN }),
    ).toBeNull();
  });
});

describe("resolveTradeExpiryMs — trade clock beats projection horizon", () => {
  it("uses the broker expiry when present", () => {
    expect(
      resolveTradeExpiryMs({
        ...BASE,
        isTradeActive: true,
        tradeEntryEpochMs: ENTRY_MS,
        tradeExpiresAtMs: ENTRY_MS + 120_000,
        expirationSeconds: 300,
      }),
    ).toBe(ENTRY_MS + 120_000);
  });

  it("falls back to entry + execution expiration while the response is pending", () => {
    expect(
      resolveTradeExpiryMs({
        ...BASE,
        isTradeActive: true,
        tradeEntryEpochMs: ENTRY_MS,
        expirationSeconds: 60,
      }),
    ).toBe(ENTRY_MS + 60_000);
  });

  it("is null when flat, even if stale expiry fields remain", () => {
    expect(
      resolveTradeExpiryMs({
        ...BASE,
        isTradeActive: false,
        tradeExpiresAtMs: ENTRY_MS + 60_000,
      }),
    ).toBeNull();
  });

  it("is null when no usable clock exists", () => {
    expect(resolveTradeExpiryMs({ ...BASE, isTradeActive: true })).toBeNull();
  });
});

describe("alignExpiryToTimeframe — ceil onto the candle grid", () => {
  it("ceil-aligns an off-grid expiry", () => {
    // 90s on a 20s grid => 100s, matching targetSlots' projection end.
    expect(alignExpiryToTimeframe(90_000, 20)).toBe(100);
    // 60s on M3 => one full bucket.
    expect(alignExpiryToTimeframe(60_000, 180)).toBe(180);
  });

  it("keeps on-grid expiries exact", () => {
    expect(alignExpiryToTimeframe(ENTRY_MS, 60)).toBe(ENTRY_MS / 1000);
    expect(alignExpiryToTimeframe(ENTRY_MS + 60_000, 300)).toBe(
      (ENTRY_MS + 60_000) / 1000,
    );
  });

  it("returns 0 (hide) for unusable input", () => {
    expect(alignExpiryToTimeframe(null, 60)).toBe(0);
    expect(alignExpiryToTimeframe(ENTRY_MS, 0)).toBe(0);
    expect(alignExpiryToTimeframe(ENTRY_MS, Number.NaN)).toBe(0);
    expect(alignExpiryToTimeframe(-1, 60)).toBe(0);
  });
});

describe("expiryClockLabel", () => {
  it("renders UTC HH:MM:SS like the chart axis", () => {
    expect(expiryClockLabel(ENTRY_MS)).toBe("22:14:00");
    expect(expiryClockLabel(ENTRY_MS + 61_000)).toBe("22:15:01");
  });

  it("is empty for a hidden expiry", () => {
    expect(expiryClockLabel(null)).toBe("");
    expect(expiryClockLabel(0)).toBe("");
    expect(expiryClockLabel(Number.NaN)).toBe("");
  });
});

describe("resolveTradeOverlay — one object for the chart", () => {
  it("returns the active entry and its aligned expiry", () => {
    expect(
      resolveTradeOverlay({
        ...BASE,
        isTradeActive: true,
        tradeEntryPrice: 1.0842,
        tradeDirection: "PUT",
        tradeEntryEpochMs: ENTRY_MS,
        expirationSeconds: 60,
        timeframeSeconds: 20,
      }),
    ).toEqual({
      entry: { price: 1.0842, label: "ENTRY PUT", source: "trade" },
      expiryMs: ENTRY_MS + 60_000,
      expiryBucketSec: (ENTRY_MS + 60_000) / 1000,
      expiryClock: "22:15:00",
    });
  });

  it("still exposes the selected signal entry while flat", () => {
    const overlay = resolveTradeOverlay({
      ...BASE,
      signalDirection: "SELL",
      signalAnchorPrice: 1.0912,
    });
    expect(overlay.entry).toEqual({
      price: 1.0912,
      label: "SIGNAL ENTRY",
      source: "signal",
    });
    expect(overlay.expiryBucketSec).toBe(0);
  });
});

describe("samePrice", () => {
  it("matches within relative tolerance only", () => {
    expect(samePrice(1.0842, 1.08420001)).toBe(true);
    expect(samePrice(1.0842, 1.085)).toBe(false);
    expect(samePrice(null, 1.0842)).toBe(false);
    expect(samePrice(0, 0)).toBe(false);
  });
});

describe("PART 46 chart wiring (source-level)", () => {
  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), "utf8");
  const chart = read("src/components/trading/financial-chart.tsx");
  const store = read("src/store/useTradingStore.ts");

  it("declares a dedicated ENTRY price line and draws it outside the target gate", () => {
    expect(chart).toMatch(/entry\?:\s*IPriceLine/);
    expect(chart).toMatch(/const ENTRY_LINE/);
    const fn = chart.slice(
      chart.indexOf("const syncMarkers = useCallback"),
      chart.indexOf("const syncExpiryMarker = useCallback"),
    );
    expect(fn).toMatch(/"entry",/);
    // Drawn BEFORE the `if (zoneActive)` projection branch.
    expect(fn.indexOf('"entry",')).toBeLessThan(fn.indexOf("if (zoneActive)"));
  });

  it("resolves the fill/signal entry through the pure helper", () => {
    expect(chart).toMatch(/resolveTradeOverlay\(\{/);
    expect(chart).toMatch(/const entryPrice = tradeOverlay\.entry\?\.price/);
    expect(chart).toMatch(/const entryLabel = tradeOverlay\.entry\?\.label/);
    expect(chart).toMatch(/entryPrice,\s*entryLabel/);
  });

  it("repaints the entry when trade state changes without a projection rebuild", () => {
    const fn = chart.slice(
      chart.indexOf("const updateTargetLayer = useCallback"),
      chart.indexOf("[reanchor, syncMarkers, syncChartDebug, syncExpiryMarker"),
    );
    const afterSnapChange = fn.slice(fn.indexOf("if (snap.changed)"));
    expect(afterSnapChange).toMatch(/syncMarkers\(/);
    expect(chart).toMatch(/isTradeActive,\s*tradeEntryPrice/);
    expect(chart).toMatch(/tradeExpiresAtMs,\s*storeExpirationSeconds/);
  });

  it("draws a second, dashed TRADE EXPIRY boundary and hides the projection marker", () => {
    expect(chart).toMatch(/new ExpiryTimeMarker\(tradeExpiryMarkerTheme\(\)\)/);
    expect(chart).toMatch(/attachPrimitive\(tradeExpiryMarker\)/);
    expect(chart).toMatch(/"TRADE EXPIRY"/);
    expect(chart).toMatch(/"ACTIVE TRADE - LIVE POSITION"/);
    const fn = chart.slice(
      chart.indexOf("const syncExpiryMarker = useCallback"),
      chart.indexOf("const syncChartDebug = useCallback"),
    );
    expect(fn).toMatch(/marker\.set\(0, ""/);
    expect(fn).toMatch(/overlay\.expiryBucketSec > 0/);
  });

  it("stores the execution clock and entry price for the renderer", () => {
    expect(store).toMatch(/tradeEntryPrice: number \| null/);
    expect(store).toMatch(/tradeDirection: "CALL" \| "PUT" \| null/);
    expect(store).toMatch(/tradeExpiresAtMs: number \| null/);
    expect(store).toMatch(/tradeEntryPrice: currentPrice/);
    expect(store).toMatch(/tradeDirection: direction/);
    expect(store).toMatch(
      /tradeExpiresAtMs: entryEpochMs \+ expirationSeconds \* 1000/,
    );
    // Broker response reconciliation, then cleared on every teardown path.
    expect(store).toMatch(/backendEntryPrice/);
    expect(store).toMatch(/backendExpiresAtMs/);
    const clears = store.match(/tradeEntryPrice: null/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3);
  });
});
