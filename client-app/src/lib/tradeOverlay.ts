/**
 * tradeOverlay.ts — PART 46 [518] pure geometry for the live-position overlay.
 *
 * The chart must answer two questions without owning trade state:
 *
 *   1. WHERE is the entry?  An active position uses the broker-confirmed
 *      `entry_price` (optimistically the click price while the request is in
 *      flight). With no position, the selected signal's anchor is shown instead,
 *      labelled "SIGNAL ENTRY" so a model price can never be mistaken for a fill.
 *   2. WHEN does the position expire?  Always the trade clock
 *      (`tradeExpiresAtMs`, or `entry + expirationSeconds` while the response is
 *      pending), never the chart's independent projection horizon. Aligning up
 *      to the chart bucket mirrors `targetSlots`: a boundary one bucket left of
 *      the expiry would claim the position closed while its candle is still open.
 *
 * Keeping this DOM-free makes the precedence rules testable; `financial-chart`
 * only renders the result.
 */

export type TradeDirection = "CALL" | "PUT";

export type SignalDirection = "BUY" | "SELL" | "CALL" | "PUT" | "HOLD" | null;

export interface EntryMarker {
  price: number;
  label: string;
  source: "trade" | "signal";
}

export interface TradeOverlayInput {
  isTradeActive: boolean;
  tradeEntryPrice?: number | null;
  tradeDirection?: TradeDirection | null;
  tradeEntryEpochMs?: number | null;
  tradeExpiresAtMs?: number | null;
  expirationSeconds?: number | null;
  signalDirection?: SignalDirection;
  signalAnchorPrice?: number | null;
  timeframeSeconds?: number | null;
}

export interface TradeOverlay {
  entry: EntryMarker | null;
  expiryMs: number | null;
  /** Bucket the boundary is drawn on; 0 means hide the marker. */
  expiryBucketSec: number;
  /** UTC HH:MM:SS of the exact expiry, for the marker label. */
  expiryClock: string;
}

function positive(value: number | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Resolve the horizontal ENTRY line. */
export function resolveEntryMarker(input: TradeOverlayInput): EntryMarker | null {
  const tradePrice = positive(input.tradeEntryPrice);
  if (input.isTradeActive && tradePrice !== null) {
    return {
      price: tradePrice,
      label: input.tradeDirection ? `ENTRY ${input.tradeDirection}` : "ENTRY",
      source: "trade",
    };
  }

  const anchor = positive(input.signalAnchorPrice);
  const direction = input.signalDirection;
  if (anchor !== null && (direction === "BUY" || direction === "SELL")) {
    return { price: anchor, label: "SIGNAL ENTRY", source: "signal" };
  }

  return null;
}

/** Resolve the live position's expiry instant, or null when flat. */
export function resolveTradeExpiryMs(input: TradeOverlayInput): number | null {
  if (!input.isTradeActive) return null;

  const explicit = positive(input.tradeExpiresAtMs);
  if (explicit !== null) return explicit;

  const entry = positive(input.tradeEntryEpochMs);
  const seconds = positive(input.expirationSeconds);
  if (entry !== null && seconds !== null) return entry + seconds * 1000;

  return null;
}

/**
 * Ceil an instant onto the chart's bucket grid. `0` means "cannot draw":
 * an invalid timeframe would otherwise fabricate a boundary at epoch zero.
 */
export function alignExpiryToTimeframe(
  expiresAtMs: number | null,
  timeframeSeconds: number | null,
): number {
  const ms = positive(expiresAtMs);
  const tf = positive(timeframeSeconds);
  if (ms === null || tf === null) return 0;
  return Math.ceil(ms / (tf * 1000)) * tf;
}

/** UTC HH:MM:SS — same clock as the chart axis and the projection marker. */
export function expiryClockLabel(expiresAtMs: number | null): string {
  const ms = positive(expiresAtMs);
  if (ms === null) return "";
  const d = new Date(Math.round(ms / 1000) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function resolveTradeOverlay(input: TradeOverlayInput): TradeOverlay {
  const expiryMs = resolveTradeExpiryMs(input);
  return {
    entry: resolveEntryMarker(input),
    expiryMs,
    expiryBucketSec: alignExpiryToTimeframe(
      expiryMs,
      input.timeframeSeconds ?? null,
    ),
    expiryClock: expiryClockLabel(expiryMs),
  };
}

/**
 * True when two price lines would overlap visually. Relative tolerance keeps
 * the comparison meaningful across FX digits and high-priced instruments.
 */
export function samePrice(a: number | null | undefined, b: number | null | undefined): boolean {
  const x = positive(a);
  const y = positive(b);
  if (x === null || y === null) return false;
  const scale = Math.max(Math.abs(x), Math.abs(y), Number.EPSILON);
  return Math.abs(x - y) / scale <= 1e-6;
}
