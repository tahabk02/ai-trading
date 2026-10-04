import {
  type IChartApiBase,
  type ISeriesPrimitive,
  type ISeriesPrimitivePaneRenderer,
  type ISeriesPrimitivePaneView,
  type SeriesAttachedParameter,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

/**
 * verticalTimeMarker.ts — PART 37 [313]-[318]: the vertical EXPIRY boundary.
 *
 * A lightweight-charts SERIES PRIMITIVE, not a DOM overlay and not a second
 * price scale. `createPriceLine` only draws HORIZONTAL lines, and a vertical
 * line cannot be faked with candle data (it would inject synthetic OHLC into the
 * price domain that PART 32 just finished de-correlating from the tape). A pane
 * view on the candle series is the native mechanism for "something at this
 * time, spanning the pane", so that is what this is.
 *
 * WHY Z-ORDER "bottom":
 * the marker is a full-height boundary. Painted above the series it would cut
 * through candle bodies and wicks and obscure the OHLC read, which is the one
 * thing this chart exists to show. Below the series it reads as what it is — a
 * time boundary in the same visual layer as `grid.vertLines` — while the
 * horizontal price lines (TGT / ANC / STOP / LIVE) keep the layer above and the
 * price axis to themselves. Time information sits in the grid layer; price
 * information sits in the line layer.
 *
 * WHERE THE X COMES FROM: `ExpiryTimeMarker.set()` receives an absolute bucket
 * in seconds, computed by `expiryMarkerBucketSec` (realtimeCandleAggregator) —
 * the SAME `targetSlots`/`targetIntervalsFor` pair that positions the target
 * candles. This file never computes a time itself; if it did, the marker and the
 * projection would be two clocks, which is the exact defect class PART 9/19/21
 * exist to close.
 */

/** Fonts mirror the chart's own `layout.fontFamily` so glyph metrics match. */
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * PART 37 [317] — the honesty clause. The marker states when a PROJECTION is
 * claimed to expire; it is not a confirmed event, and a bare `EXPIRY HH:MM:SS`
 * on a chart of predictions reads as a scheduled fact. Carried ON the marker
 * itself because the existing legend badge (`Target = projection, not a
 * confirmed price`) only renders while target candles are drawn, and this
 * marker is deliberately visible outside that gate (any tier, BUY/SELL/HOLD).
 */
export const EXPIRY_MARKER_DISCLAIMER = "PROJECTION, NOT A CONFIRMED PRICE";

export interface ExpiryMarkerTheme {
  line: string;
  labelBg: string;
  labelInk: string;
  labelMuted: string;
}

/**
 * Structural stand-in for fancy-canvas's `CanvasRenderingTarget2D`.
 * `lightweight-charts` re-exports the type only from its own (non-exported)
 * module graph, so naming it here would mean importing a TRANSITIVE package's
 * typings; this is the same shape, declared locally, with no dependency on
 * fancy-canvas being hoisted.
 */
interface MediaTarget {
  useMediaCoordinateSpace<T>(
    scope: (s: {
      context: CanvasRenderingContext2D;
      mediaSize: { width: number; height: number };
    }) => T,
  ): T;
}

export class ExpiryTimeMarker implements ISeriesPrimitive<Time> {
  private _chart: IChartApiBase<Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _bucketSec = 0;
  private _label = "";
  private _theme: ExpiryMarkerTheme;
  private readonly _paneView: ISeriesPrimitivePaneView;

  constructor(theme: ExpiryMarkerTheme) {
    this._theme = { ...theme };
    this._paneView = new ExpiryPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._chart = null;
    this._requestUpdate = null;
  }

  updateAllViews(): void {
    /* Nothing cached: x is resolved per draw from the live time scale, so a
       scroll/zoom invalidates itself and cannot go stale. */
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  /**
   * Reposition the marker. `bucketSec <= 0` HIDES it — the one honest way to
   * express "there is no expiry boundary to draw" (no live tip to anchor to, or
   * a non-positive expiry). Callers pass `expiryMarkerBucketSec`'s output, never
   * a locally-derived time.
   *
   * No-ops when nothing changed: this runs on every animation frame of the live
   * tape, and an unconditional requestUpdate here would redraw the whole chart
   * at tick rate.
   */
  set(bucketSec: number, label: string, theme?: ExpiryMarkerTheme): void {
    const raw = Number(bucketSec);
    const nextBucket = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
    const nextTheme = theme ?? this._theme;
    if (
      nextBucket === this._bucketSec &&
      label === this._label &&
      nextTheme.line === this._theme.line &&
      nextTheme.labelBg === this._theme.labelBg &&
      nextTheme.labelInk === this._theme.labelInk &&
      nextTheme.labelMuted === this._theme.labelMuted
    ) {
      return;
    }
    this._bucketSec = nextBucket;
    this._label = nextBucket > 0 ? label : "";
    this._theme = nextTheme;
    this._requestUpdate?.();
  }

  get markerBucketSec(): number {
    return this._bucketSec;
  }

  get markerLabel(): string {
    return this._label;
  }

  get markerTheme(): ExpiryMarkerTheme {
    return this._theme;
  }

  /** Media (CSS px) x of the boundary, or null when off-scale / not drawn. */
  markerX(): number | null {
    if (this._bucketSec <= 0 || !this._chart) return null;
    const x = this._chart
      .timeScale()
      .timeToCoordinate(this._bucketSec as UTCTimestamp);
    if (x === null) return null;
    const px = x as number;
    return Number.isFinite(px) ? px : null;
  }
}

class ExpiryPaneView implements ISeriesPrimitivePaneView {
  private readonly _renderer: ISeriesPrimitivePaneRenderer;

  constructor(marker: ExpiryTimeMarker) {
    this._renderer = new ExpiryRenderer(marker);
  }

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): ISeriesPrimitivePaneRenderer | null {
    return this._renderer;
  }
}

class ExpiryRenderer implements ISeriesPrimitivePaneRenderer {
  private readonly _marker: ExpiryTimeMarker;

  constructor(marker: ExpiryTimeMarker) {
    this._marker = marker;
  }

  draw(target: MediaTarget): void {
    const marker = this._marker;
    if (marker.markerBucketSec <= 0) return;
    const label = marker.markerLabel;
    if (!label) return;
    const x = marker.markerX();
    if (x === null) return;
    const theme = marker.markerTheme;

    target.useMediaCoordinateSpace((scope) => {
      const ctx = scope.context;
      const width = scope.mediaSize.width;
      const height = scope.mediaSize.height;
      if (width <= 0 || height <= 0) return;
      // Half-pixel offset keeps a 1px stroke on one device pixel instead of
      // smearing across two.
      const px = Math.round(x) + 0.5;
      // Off-pane: nothing to draw, and text metrics would be measured for a
      // label the user cannot see.
      if (px < -1 || px > width + 1) return;

      ctx.save();

      // ── the boundary itself ──
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.line;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── label block: EXPIRY HH:MM:SS over the honesty clause ──
      const title = `EXPIRY ${label}`;
      ctx.font = `700 10px ${MONO}`;
      const titleW = ctx.measureText(title).width;
      ctx.font = `600 7px ${MONO}`;
      const noteW = ctx.measureText(EXPIRY_MARKER_DISCLAIMER).width;
      const boxW = Math.ceil(Math.max(titleW, noteW)) + 8;
      const boxH = 22;
      const gap = 3;
      // Prefer the right of the line; flip left when that would overflow the
      // pane (the marker usually sits near the right edge, next to the future
      // zone), then clamp so it can never leave the pane entirely.
      let bx = px + gap;
      if (bx + boxW > width - 2) bx = px - gap - boxW;
      bx = Math.min(Math.max(bx, 2), Math.max(2, width - boxW - 2));
      const by = 4;

      ctx.fillStyle = theme.labelBg;
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.strokeStyle = theme.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);

      ctx.textBaseline = "top";
      ctx.font = `700 10px ${MONO}`;
      ctx.fillStyle = theme.labelInk;
      ctx.fillText(title, bx + 4, by + 3);
      ctx.font = `600 7px ${MONO}`;
      ctx.fillStyle = theme.labelMuted;
      ctx.fillText(EXPIRY_MARKER_DISCLAIMER, bx + 4, by + 14);

      ctx.restore();
    });
  }
}