/**
 * expiryMarker.test.ts — PART 37 [318] regression + architectural guard.
 *
 * THE DEFECT THIS LOCKS DOWN: an operator reading a vertical "EXPIRY" line
 * would take its X as the moment the prediction resolves. If that X came from
 * anything other than the projection's own slot arithmetic it would be a second
 * clock, and the two would disagree — exactly the defect class PART 9 / 19 / 21
 * exist to close on this chart (two price domains, a raw/Ha split, a tier read
 * from a second store copy). A marker one bucket to the LEFT of the last
 * projected candle claims an expiry while candles are still being drawn, which
 * is worse than no marker at all.
 *
 * So the contract is:
 *
 *   1. THE MARKER'S TIME IS THE PROJECTION'S LAST SLOT — derived through the
 *      SAME `targetSlots`/`targetIntervalsFor` pair that positions the candles,
 *      never re-derived in the drawing layer.
 *   2. FOR THE REAL LADDER THAT IS EXACTLY `liveTipBucketSec + expirationSeconds`
 *      — asserted below for every expiry (60/120/300/600 — well past the "at
 *      least 3 expiries" the spec asks for) across every sub-minute and M1 grid,
 *      because each ladder expiry divides each of those buckets.
 *   3. OFF-GRID EXPIRIES STAY GLUED TO THE PROJECTION rather than honouring the
 *      raw sum — pinned explicitly, because this is the one case where the two
 *      rules disagree and the projection must win.
 *   4. THE PRIMITIVE DRAWS NOTHING until it is given a time, and its X comes from
 *      `timeScale().timeToCoordinate()` so a scroll or zoom cannot desync it.
 *   5. THE HONESTY CLAUSE rides on the marker itself, because the existing legend
 *      badge only renders while target candles are drawn and this marker is
 *      deliberately visible at any tier, including HOLD.
 *
 * The canvas draw and the DOM attachment are asserted at the source level and
 * against a recording 2D context — the chart mounts a real <canvas> that does not
 * exist in this suite, but the geometry, the dash pattern and the label text are
 * all reachable without one.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expiryMarkerBucketSec,
  expiryMarkerClockLabel,
  targetIntervalsFor,
  targetSlots,
} from "@/lib/realtimeCandleAggregator";
import {
  ExpiryTimeMarker,
  EXPIRY_MARKER_DISCLAIMER,
  type ExpiryMarkerTheme,
} from "@/lib/verticalTimeMarker";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

/** The selector's real ladder — pro-expiry-bar.tsx / trading-panel.tsx. */
const LADDER: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "3m", seconds: 180 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
];

/** Buckets every ladder expiry divides, i.e. the grids actually charted. */
const SUB_MINUTE_AND_M1_GRIDS = [5, 10, 15, 30, 60];

const TIP_SEC = 1_700_000_040; // deliberately NOT on a 60s boundary

// ── the projection's own last slot, recomputed here as the reference ──
function projectionLastSlotSec(
  tipSec: number,
  expSec: number,
  tfSec: number,
): number {
  const slots = targetSlots(tipSec, tfSec, targetIntervalsFor(expSec, tfSec));
  const last = slots[slots.length - 1];
  if (!last) throw new Error("no slots");
  return last.timeSec;
}

describe("PART 37 [318] expiry marker X == liveTipBucketSec + expirationSeconds", () => {
  it("matches the raw sum for EVERY ladder expiry on every sub-minute/M1 grid", () => {
    // 5 expiries x 5 grids = 25 combinations, each asserted to be exact.
    let checked = 0;
    for (const opt of LADDER) {
      for (const tfSec of SUB_MINUTE_AND_M1_GRIDS) {
        expect(expiryMarkerBucketSec(TIP_SEC, opt.seconds, tfSec)).toBe(
          TIP_SEC + opt.seconds,
        );
        checked += 1;
      }
    }
    // The spec asks for at least 3 expiries; assert the sweep is real so a
    // future edit cannot quietly shrink the ladder to one option and pass.
    expect(checked).toBe(LADDER.length * SUB_MINUTE_AND_M1_GRIDS.length);
    expect(new Set(LADDER.map((o) => o.seconds)).size).toBeGreaterThanOrEqual(3);
  });

  it("tracks the live tip across buckets the operator actually sees", () => {
    // The chart always hands this function a tip that is ALREADY bucket-floored
    // (`Math.floor(tipGridMs / 1000)`, financial-chart.tsx), so the raw-sum
    // identity holds on every grid-aligned tip. Vary the tip to prove the marker
    // is anchored to the tip and not to wall-clock now.
    for (const tfSec of SUB_MINUTE_AND_M1_GRIDS) {
      for (const opt of LADDER) {
        for (const bucketIndex of [1, 2, 999, 100_001]) {
          const tipSec = tfSec * bucketIndex;
          expect(tipSec % tfSec).toBe(0);
          expect(expiryMarkerBucketSec(tipSec, opt.seconds, tfSec)).toBe(
            tipSec + opt.seconds,
          );
        }
      }
    }
  });
});

describe("PART 37 marker and projection can never be two clocks", () => {
  it("equals the projection's last slot for EVERY expiry/grid pair, aligned or not", () => {
    const grids = [5, 10, 15, 30, 60, 120, 180, 300, 600, 3600];
    const exps = [1, 7, 45, 60, 90, 120, 137, 180, 300, 599, 600, 3600];
    for (const tfSec of grids) {
      for (const expSec of exps) {
        const marker = expiryMarkerBucketSec(TIP_SEC, expSec, tfSec);
        // The real contract: ONE clock.
        expect(marker).toBe(projectionLastSlotSec(TIP_SEC, expSec, tfSec));
        // Always in the future of the live tip...
        expect(marker).toBeGreaterThan(TIP_SEC);
        // ...and always ON the projection's bucket grid.
        expect(marker % tfSec).toBe(0);
      }
    }
  });

  it("honours the PROJECTION, not the raw sum, on an off-grid expiry", () => {
    // 90s on a 20s grid (tip is 20-aligned): the projection draws
    // ceil(90/20)=5 candles ending at tip+100. A marker at tip+90 would sit
    // INSIDE the zone with a projected candle still to its right — the exact
    // lie this module exists to prevent.
    expect(expiryMarkerBucketSec(TIP_SEC, 90, 20)).toBe(TIP_SEC + 100);
    expect(expiryMarkerBucketSec(TIP_SEC, 90, 20)).not.toBe(TIP_SEC + 90);

    // 60s on the M3 (180s) grid. Measured against a 180-ALIGNED tip, because
    // an off-grid tip is floored by targetSlots first and the two rules can then
    // coincide by accident (TIP_SEC is 120s off the 180 grid, so its single
    // projected slot lands on TIP_SEC+60 and the raw sum agrees for the wrong
    // reason). Pin the divergence where it is unambiguous.
    const tip180 = Math.floor(TIP_SEC / 180) * 180;
    expect(tip180 % 180).toBe(0);
    expect(expiryMarkerBucketSec(tip180, 60, 180)).toBe(tip180 + 180);
    expect(expiryMarkerBucketSec(tip180, 60, 180)).not.toBe(tip180 + 60);

    // 300s on the M2 (120s) grid: three candles at +360, not at +300.
    expect(expiryMarkerBucketSec(TIP_SEC, 300, 120)).toBe(TIP_SEC + 360);
    expect(expiryMarkerBucketSec(TIP_SEC, 300, 120)).not.toBe(TIP_SEC + 300);
  });

  it("bucket-floors a tip that is not already on the grid, as targetSlots does", () => {
    const offGridTip = TIP_SEC + 7;
    expect(expiryMarkerBucketSec(offGridTip, 60, 20)).toBe(
      projectionLastSlotSec(offGridTip, 60, 20),
    );
  });

  it("returns 0 (hide) rather than a fabricated time for unusable input", () => {
    expect(expiryMarkerBucketSec(0, 60, 60)).toBe(0);
    expect(expiryMarkerBucketSec(-1, 60, 60)).toBe(0);
    expect(expiryMarkerBucketSec(Number.NaN, 60, 60)).toBe(0);
    expect(expiryMarkerBucketSec(TIP_SEC, 0, 60)).toBe(0);
    expect(expiryMarkerBucketSec(TIP_SEC, -60, 60)).toBe(0);
    expect(expiryMarkerBucketSec(TIP_SEC, Number.NaN, 60)).toBe(0);
    expect(expiryMarkerBucketSec(TIP_SEC, 60, 0)).toBe(0);
    expect(expiryMarkerBucketSec(TIP_SEC, 60, -20)).toBe(0);
    expect(expiryMarkerBucketSec(TIP_SEC, 60, Number.NaN)).toBe(0);
    expect(expiryMarkerBucketSec(TIP_SEC, Number.POSITIVE_INFINITY, 60)).toBe(0);
  });
});

describe("PART 37 marker clock label", () => {
  it("renders UTC HH:MM:SS, matching the chart's own axis formatter", () => {
    // 1_700_000_040 = 2023-11-14T22:14:00Z
    expect(expiryMarkerClockLabel(TIP_SEC + 60)).toBe("22:15:00");
    expect(expiryMarkerClockLabel(TIP_SEC + 3600)).toBe("23:14:00");
    expect(expiryMarkerClockLabel(1_700_000_040)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("pads every field to two digits", () => {
    // 2023-11-14T22:05:03Z + 1s
    const sec = 1_700_000_040 + 4;
    const label = expiryMarkerClockLabel(sec);
    for (const part of label.split(":")) expect(part).toHaveLength(2);
  });

  it("is empty for a hidden marker", () => {
    expect(expiryMarkerClockLabel(0)).toBe("");
    expect(expiryMarkerClockLabel(-1)).toBe("");
    expect(expiryMarkerClockLabel(Number.NaN)).toBe("");
  });
});

// ── the primitive itself, driven against a recording context ──

interface Recorded {
  dashes: number[][];
  lines: Array<{ x: number; y0: number; y1: number; stroke: string }>;
  texts: string[];
  rects: Array<{ x: number; y: number; w: number; h: number; fill: string }>;
  fonts: string[];
}

function recordingTarget(width: number, height: number): {
  target: unknown;
  rec: Recorded;
} {
  const rec: Recorded = { dashes: [], lines: [], texts: [], rects: [], fonts: [] };
  const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "" };
  let x = 0;
  let y0 = 0;
  const ctx = {
    get fillStyle() {
      return state.fillStyle as string;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get strokeStyle() {
      return state.strokeStyle as string;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    lineWidth: 1,
    textBaseline: "top",
    font: "10px monospace",
    save() {},
    restore() {},
    beginPath() {},
    setLineDash(d: number[]) {
      rec.dashes.push([...d]);
    },
    moveTo(mx: number, my: number) {
      x = mx;
      y0 = my;
    },
    lineTo(mx: number, my: number) {
      rec.lines.push({
        x,
        y0,
        y1: my,
        stroke: state.strokeStyle as string,
      });
    },
    stroke() {},
    measureText(t: string) {
      return { width: t.length * 6 };
    },
    fillText(t: string) {
      rec.texts.push(t);
    },
    fillRect(rx: number, ry: number, w: number, h: number) {
      rec.rects.push({
        x: rx,
        y: ry,
        w,
        h,
        fill: state.fillStyle as string,
      });
    },
    strokeRect() {},
  };
  return {
    rec,
    target: {
      useMediaCoordinateSpace: <T,>(
        fn: (s: {
          context: unknown;
          mediaSize: { width: number; height: number };
        }) => T,
      ) =>
        fn({
          context: ctx,
          mediaSize: { width, height },
        }),
    },
  };
}

const THEME: ExpiryMarkerTheme = {
  line: "rgba(148,163,184,0.72)",
  labelBg: "#171c28",
  labelInk: "#f8fafc",
  labelMuted: "#94a3b8",
};

function attachedMarker(coordinateFor: (sec: number) => number | null): {
  marker: ExpiryTimeMarker;
  updates: () => number;
} {
  let updates = 0;
  const marker = new ExpiryTimeMarker(THEME);
  marker.attached({
    chart: {
      timeScale: () => ({ timeToCoordinate: (t: number) => coordinateFor(t) }),
    },
    series: {},
    requestUpdate: () => {
      updates += 1;
    },
  } as never);
  return { marker, updates: () => updates };
}

describe("PART 37 expiry marker primitive", () => {
  it("draws nothing until it is given a resolvable time", () => {
    const { marker } = attachedMarker(() => 100);
    const { target, rec } = recordingTarget(600, 400);
    const renderer = marker.paneViews()[0].renderer();
    renderer?.draw(target as never);
    expect(rec.lines).toHaveLength(0);
    expect(rec.texts).toHaveLength(0);
    expect(marker.markerBucketSec).toBe(0);
    expect(marker.markerX()).toBeNull();
  });

  it("positions X at exactly the bucket it was given, via the time scale", () => {
    const bucket = expiryMarkerBucketSec(TIP_SEC, 300, 60);
    const { marker } = attachedMarker((sec) => (sec === bucket ? 412 : null));
    marker.set(bucket, expiryMarkerClockLabel(bucket), THEME);
    expect(marker.markerBucketSec).toBe(bucket);
    expect(marker.markerX()).toBe(412);

    const { target, rec } = recordingTarget(600, 400);
    marker.paneViews()[0].renderer()?.draw(target as never);
    expect(rec.lines).toHaveLength(1);
    // Half-pixel offset lands the 1px stroke on one device pixel.
    expect(rec.lines[0].x).toBe(412.5);
    expect(rec.lines[0].stroke).toBe(THEME.line);
  });

  it("hides on a non-positive bucket and clears its label", () => {
    const bucket = expiryMarkerBucketSec(TIP_SEC, 60, 60);
    const { marker } = attachedMarker(() => 300);
    marker.set(bucket, expiryMarkerClockLabel(bucket), THEME);
    expect(marker.markerX()).toBe(300);
    marker.set(0, "", THEME);
    expect(marker.markerX()).toBeNull();
    expect(marker.markerLabel).toBe("");
    const { target, rec } = recordingTarget(600, 400);
    marker.paneViews()[0].renderer()?.draw(target as never);
    expect(rec.lines).toHaveLength(0);
    expect(rec.texts).toHaveLength(0);
  });

  it("draws no geometry when the bucket is off the visible time scale", () => {
    const { marker } = attachedMarker(() => null);
    marker.set(expiryMarkerBucketSec(TIP_SEC, 60, 60), "22:15:00", THEME);
    expect(marker.markerX()).toBeNull();
    const { target, rec } = recordingTarget(600, 400);
    marker.paneViews()[0].renderer()?.draw(target as never);
    expect(rec.lines).toHaveLength(0);
  });

  it("spans the FULL pane height, dashed, and skips off-pane coordinates", () => {
    const { marker } = attachedMarker(() => 300);
    marker.set(expiryMarkerBucketSec(TIP_SEC, 600, 60), "22:24:00", THEME);
    const full = recordingTarget(900, 480);
    marker.paneViews()[0].renderer()?.draw(full.target as never);
    expect(full.rec.lines[0].y0).toBe(0);
    expect(full.rec.lines[0].y1).toBe(480);
    expect(full.rec.dashes[0].length).toBeGreaterThan(0);

    const offscreen = attachedMarker(() => 5000);
    offscreen.marker.set(
      expiryMarkerBucketSec(TIP_SEC, 600, 60),
      "22:24:00",
      THEME,
    );
    const out = recordingTarget(900, 480);
    offscreen.marker.paneViews()[0].renderer()?.draw(out.target as never);
    expect(out.rec.lines).toHaveLength(0);
    expect(out.rec.texts).toHaveLength(0);
  });

  it("labels the boundary with EXPIRY HH:MM:SS and the honesty clause", () => {
    const bucket = expiryMarkerBucketSec(TIP_SEC, 120, 60);
    const { marker } = attachedMarker(() => 500);
    marker.set(bucket, expiryMarkerClockLabel(bucket), THEME);
    const { target, rec } = recordingTarget(900, 480);
    marker.paneViews()[0].renderer()?.draw(target as never);
    expect(rec.texts[0]).toBe(`EXPIRY ${expiryMarkerClockLabel(bucket)}`);
    expect(rec.texts[0]).toMatch(/^EXPIRY \d{2}:\d{2}:\d{2}$/);
    // [317] the marker must not read as a guaranteed event.
    expect(rec.texts).toContain(EXPIRY_MARKER_DISCLAIMER);
    expect(EXPIRY_MARKER_DISCLAIMER).toBe(
      "PROJECTION, NOT A CONFIRMED PRICE",
    );
    expect(rec.rects.length).toBeGreaterThan(0);
  });

  it("keeps the label inside the pane when the marker sits at the right edge", () => {
    const { marker } = attachedMarker(() => 898);
    marker.set(expiryMarkerBucketSec(TIP_SEC, 60, 60), "22:15:00", THEME);
    const { target, rec } = recordingTarget(900, 480);
    marker.paneViews()[0].renderer()?.draw(target as never);
    const box = rec.rects[0];
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(900);
  });

  it("paints in the grid layer, under the price lines", () => {
    const { marker } = attachedMarker(() => 100);
    // A full-height boundary drawn OVER the candles would cut through bodies
    // and wicks and obscure the OHLC read.
    expect(marker.paneViews()[0].zOrder?.()).toBe("bottom");
  });

  it("requests a redraw only when something actually changed", () => {
    const { marker, updates } = attachedMarker(() => 100);
    const bucket = expiryMarkerBucketSec(TIP_SEC, 60, 60);
    const label = expiryMarkerClockLabel(bucket);
    marker.set(bucket, label, THEME);
    const afterFirst = updates();
    expect(afterFirst).toBeGreaterThan(0);
    // The paint loop calls this every frame; an unconditional requestUpdate
    // would redraw the whole chart at tick rate.
    for (let i = 0; i < 25; i += 1) marker.set(bucket, label, THEME);
    expect(updates()).toBe(afterFirst);
    marker.set(bucket + 60, label, THEME);
    expect(updates()).toBe(afterFirst + 1);
  });

  it("survives detaching and stops drawing", () => {
    const { marker } = attachedMarker(() => 100);
    marker.set(expiryMarkerBucketSec(TIP_SEC, 60, 60), "22:15:00", THEME);
    marker.detached();
    expect(marker.markerX()).toBeNull();
    const { target, rec } = recordingTarget(600, 400);
    marker.paneViews()[0].renderer()?.draw(target as never);
    expect(rec.lines).toHaveLength(0);
  });
});

describe("PART 37 chart wiring (source-level)", () => {
  const chart = read("src/components/trading/financial-chart.tsx");

  it("attaches the marker to the CANDLE series, below the target overlay", () => {
    expect(chart).toMatch(/candleSeries\.attachPrimitive\(expiryMarker\)/);
    // It must NOT hang off the target series: that would paint the boundary
    // over the very projection it terminates.
    expect(chart).not.toMatch(/targetSeries\.attachPrimitive/);
  });

  it("positions the marker through expiryMarkerBucketSec, never a local sum", () => {
    expect(chart).toMatch(
      /expiryMarkerBucketSec\(tipSec, expSec, tfSec\)/,
    );
    // The drawing layer must not compute `tip + expiry` itself — that would be
    // the second clock this whole module forbids.
    expect(chart).not.toMatch(/tipSec\s*\+\s*expSec/);
    expect(chart).not.toMatch(/tipSec\s*\+\s*expSeconds/);
  });

  it("keeps the marker visible for any tier and direction (no tier gate)", () => {
    const fn = chart.slice(
      chart.indexOf("const syncExpiryMarker = useCallback"),
      chart.indexOf("const syncChartDebug = useCallback"),
    );
    expect(fn).not.toMatch(/targetCandlesEnabled/);
    expect(fn).not.toMatch(/tier/);
    expect(fn).not.toMatch(/gatedSignal/);
    expect(fn).not.toMatch(/actionReady|regimeBlocked|tooLate/);
  });

  it("positions the marker from the live tip, before projection suppression", () => {
    const start = chart.indexOf("const updateTargetLayer = useCallback");
    const end = chart.indexOf(
      "[reanchor, syncMarkers, syncChartDebug, syncExpiryMarker, currentSignalView]",
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = chart.slice(start, end);
    const markerAt = fn.indexOf("syncExpiryMarker(tipSec, tfSec, expSec)");
    // PART 40 [394] — the suppression branch now ALSO carries the regime-gate
    // condition (`!showTarget`); the marker must still be positioned above it.
    const suppressAt = fn.indexOf(
      "if (!showTarget || tipGridMs <= 0 || targetPrice <= 0)",
    );
    expect(markerAt).toBeGreaterThan(-1);
    expect(suppressAt).toBeGreaterThan(-1);
    // A time marker must not vanish because a price is missing.
    expect(markerAt).toBeLessThan(suppressAt);
  });
});

describe("PART 37 expiry marker theme tokens", () => {
  const css = read("src/styles/globals.css");

  it("defines --tp-expiry-line in BOTH themes", () => {
    const defs = css.match(/--tp-expiry-line:[^;]+;/g) ?? [];
    expect(defs.length).toBe(2);
    expect(defs[0]).toMatch(/rgba/);
    expect(defs[1]).toMatch(/rgba/);
  });

  it("reads the token through the chart's own token reader", () => {
    const chart = read("src/components/trading/financial-chart.tsx");
    expect(chart).toMatch(/cssVar\("--tp-expiry-line"/);
    expect(chart).toMatch(/cssVar\("--tp-elevated"/);
  });
});