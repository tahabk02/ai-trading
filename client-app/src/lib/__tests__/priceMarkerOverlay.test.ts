import { describe, expect, it } from "vitest";
import {
  computePriceMarkers,
  formatCountdownLabel,
  isEntryWinning,
  type MarkerEntry,
  type PriceCoordSource,
  type TimeCoordSource,
} from "@/lib/priceMarkerOverlay";

/** Deterministic y = price * 10, or null for an off-scale price. */
function fakeSeries(nullPrices: number[] = []): PriceCoordSource {
  return {
    priceToCoordinate: (p: number) =>
      nullPrices.includes(p) ? null : p * 10,
  };
}

/** Deterministic x from a lookup of epoch-SECONDS → px. */
function fakeChart(coords: Record<number, number>): TimeCoordSource {
  return {
    timeScale: () => ({
      timeToCoordinate: (t: number) =>
        Object.prototype.hasOwnProperty.call(coords, t) ? coords[t] : null,
    }),
  };
}

function entry(patch: Partial<MarkerEntry> = {}): MarkerEntry {
  return {
    price: 1.085,
    side: "CALL",
    open: true,
    entryTsMs: 1_700_000_000_000,
    expiryTsMs: 1_700_000_300_000,
    ...patch,
  };
}

const ENTRY_SEC = 1_700_000_000;
const EXPIRY_SEC = 1_700_000_300;

describe("computePriceMarkers — DEPART badge", () => {
  it("emits a cyan dashed DEPART | price badge at the projected y", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      departPrice: 1.0842,
      digits: 4,
      nowMs: 0,
    });
    const depart = set.markers.find((m) => m.id === "depart");
    expect(depart).toBeDefined();
    expect(depart?.text).toBe("DEPART | 1.0842");
    expect(depart?.tone).toBe("depart");
    expect(depart?.dashed).toBe(true);
    expect(depart?.y).toBe(1.0842 * 10);
  });

  it("omits DEPART when the strike is withheld (null / non-positive)", () => {
    expect(
      computePriceMarkers({ series: fakeSeries(), departPrice: null, nowMs: 0 })
        .markers.some((m) => m.id === "depart"),
    ).toBe(false);
    expect(
      computePriceMarkers({ series: fakeSeries(), departPrice: 0, nowMs: 0 })
        .markers.some((m) => m.id === "depart"),
    ).toBe(false);
  });

  it("omits DEPART when its price is off the visible price scale", () => {
    const set = computePriceMarkers({
      series: fakeSeries([1.0842]),
      departPrice: 1.0842,
      nowMs: 0,
    });
    expect(set.markers.some((m) => m.id === "depart")).toBe(false);
  });
});

describe("computePriceMarkers — LIVE / FINAL flip", () => {
  it("is neutral with no entry", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      livePrice: 1.086,
      entry: null,
      nowMs: 0,
    });
    const live = set.markers.find((m) => m.id === "live");
    expect(live?.tone).toBe("neutral");
    expect(live?.text).toBe("LIVE | 1.08600");
  });

  it("CALL wins above the strike → green / win", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      livePrice: 1.09,
      entry: entry({ side: "CALL", price: 1.085 }),
      nowMs: 0,
    });
    const live = set.markers.find((m) => m.id === "live");
    expect(live?.tone).toBe("win");
    expect(live?.text.startsWith("LIVE")).toBe(true);
  });

  it("CALL loses below the strike → red / loss", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      livePrice: 1.08,
      entry: entry({ side: "CALL", price: 1.085 }),
      nowMs: 0,
    });
    expect(set.markers.find((m) => m.id === "live")?.tone).toBe("loss");
  });

  it("PUT wins below the strike and loses above it", () => {
    const base = { series: fakeSeries(), entry: entry({ side: "PUT" as const }) };
    expect(
      computePriceMarkers({ ...base, livePrice: 1.08, nowMs: 0 }).markers.find(
        (m) => m.id === "live",
      )?.tone,
    ).toBe("win");
    expect(
      computePriceMarkers({ ...base, livePrice: 1.09, nowMs: 0 }).markers.find(
        (m) => m.id === "live",
      )?.tone,
    ).toBe("loss");
  });

  it("an exact tie is never a fabricated win", () => {
    expect(
      isEntryWinning(entry({ side: "CALL", price: 1.085 }), 1.085),
    ).toBe(false);
  });

  it("reads FINAL (not LIVE) once the entry has settled", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      livePrice: 1.09,
      entry: entry({ open: false, side: "CALL" }),
      nowMs: 0,
    });
    expect(set.markers.find((m) => m.id === "live")?.text).toContain("FINAL");
  });
});

describe("computePriceMarkers — ENTRY badge", () => {
  it("anchors the entry strike as a neutral badge", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      entry: entry({ price: 1.085 }),
      digits: 3,
      nowMs: 0,
    });
    const e = set.markers.find((m) => m.id === "entry");
    expect(e?.text).toBe("ENTRY | 1.085");
    expect(e?.tone).toBe("neutral");
    expect(e?.y).toBe(10.85);
  });
});

describe("computePriceMarkers — trade window", () => {
  const chart = fakeChart({ [ENTRY_SEC]: 40, [EXPIRY_SEC]: 240 });

  it("shades entry→expiry with a live countdown for an OPEN trade", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      chart,
      livePrice: 1.09,
      entry: entry({ side: "CALL", open: true }),
      nowMs: EXPIRY_SEC * 1000 - 65_000,
    });
    expect(set.window).not.toBeNull();
    expect(set.window?.x0).toBe(40);
    expect(set.window?.x1).toBe(240);
    expect(set.window?.tone).toBe("win");
    expect(set.window?.countdownSec).toBe(65);
    expect(set.window?.countdownLabel).toBe("01:05");
  });

  it("flips the window to loss when the open trade is underwater", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      chart,
      livePrice: 1.08,
      entry: entry({ side: "CALL", open: true }),
      nowMs: EXPIRY_SEC * 1000,
    });
    expect(set.window?.tone).toBe("loss");
  });

  it("draws NO window for a settled (closed) trade", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      chart,
      entry: entry({ open: false }),
      nowMs: EXPIRY_SEC * 1000,
    });
    expect(set.window).toBeNull();
  });

  it("draws NO window when either edge is off the time axis", () => {
    const set = computePriceMarkers({
      series: fakeSeries(),
      chart: fakeChart({ [ENTRY_SEC]: 40 }),
      entry: entry({ open: true }),
      nowMs: EXPIRY_SEC * 1000,
    });
    expect(set.window).toBeNull();
  });
});

describe("formatCountdownLabel", () => {
  it("renders mm:ss and floors negative / non-finite input to 00:00", () => {
    expect(formatCountdownLabel(0)).toBe("00:00");
    expect(formatCountdownLabel(59)).toBe("00:59");
    expect(formatCountdownLabel(60)).toBe("01:00");
    expect(formatCountdownLabel(3599.9)).toBe("59:59");
    expect(formatCountdownLabel(-5)).toBe("00:00");
    expect(formatCountdownLabel(Number.NaN)).toBe("00:00");
  });
});
