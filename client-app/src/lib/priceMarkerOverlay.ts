/**
 * priceMarkerOverlay.ts — PHASE 4 chart execution layers & overlays.
 *
 * Pure geometry for the HIGH-CONTRAST DOM marker layer the operator reads on
 * top of the candle canvas:
 *
 *   • DEPART — the cyan DASHED departure ("Ligne du Départ") strike badge,
 *     labelled `DEPART | <price>`.
 *   • ENTRY  — the journal entry strike badge (`ENTRY | <price>`).
 *   • LIVE / FINAL — the real-time price badge; it flips green/red against the
 *     operator's OWN journal entry (CALL wins above the strike, PUT wins below
 *     it) and reads LIVE while the trade is open and FINAL once settled.
 *   • TRADE WINDOW — a shaded band between the entry and expiry timestamps for
 *     an ACTIVE trade, carrying a live expiry countdown.
 *
 * Nothing here touches the DOM or a lightweight-charts instance directly: it is
 * handed the two coordinate projections it needs (`priceToCoordinate` for the
 * y axis, `timeScale().timeToCoordinate` for the x axis) and returns pixel
 * geometry. That keeps it testable in the node "logic" project and keeps every
 * reflow out of the chart's per-tick paint loop (INVARIANT 1).
 */

/** Cyan departure strike — the DEPART marker is always cyan + dashed. */
export const DEPART_COLOR = "#22d3ee";
export const WIN_COLOR = "#26a69a";
export const LOSS_COLOR = "#ef5350";
export const NEUTRAL_MARKER_COLOR = "rgba(148,163,184,0.9)";

export type PriceMarkerId = "depart" | "entry" | "live";
export type PriceMarkerTone = "depart" | "win" | "loss" | "neutral";

export interface PriceMarker {
  id: PriceMarkerId;
  price: number;
  /** px from the top of the chart pane, straight from `priceToCoordinate`. */
  y: number;
  /** `DEPART | 1.08421` */
  text: string;
  tone: PriceMarkerTone;
  /** True for the dashed DEPART strike badge. */
  dashed?: boolean;
}

export type TradeWindowTone = "win" | "loss" | "neutral";

export interface TradeWindowOverlay {
  /** px on the time axis for the entry timestamp. */
  x0: number;
  /** px on the time axis for the expiry timestamp. */
  x1: number;
  tone: TradeWindowTone;
  /** Seconds left until expiry (0 once past). */
  countdownSec: number;
  /** mm:ss of `countdownSec`. */
  countdownLabel: string;
}

export interface PriceMarkerSet {
  markers: PriceMarker[];
  /** Shaded band for an ACTIVE (open) trade; null otherwise. */
  window: TradeWindowOverlay | null;
}

/** The journal-entry facts the overlay needs (never the whole entry row). */
export interface MarkerEntry {
  price: number;
  side: "CALL" | "PUT";
  /** True while the trade is still open (drives LIVE vs FINAL + the window). */
  open: boolean;
  entryTsMs: number;
  expiryTsMs: number;
}

/** Structural view of a lightweight-charts series, for y projection. */
export interface PriceCoordSource {
  priceToCoordinate: (price: number) => number | null;
}

/** Structural view of a lightweight-charts chart, for x projection. */
export interface TimeCoordSource {
  timeScale: () => { timeToCoordinate: (t: number) => number | null };
}

/** mm:ss label for a non-negative second count. */
export function formatCountdownLabel(totalSec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Is `price` winning for `entry`? CALL wins strictly above the strike, PUT wins
 * strictly below it; an exact tie counts as NOT winning (never a fabricated
 * win). Returns null when `price` is not a usable number.
 */
export function isEntryWinning(
  entry: MarkerEntry,
  price: number,
): boolean | null {
  if (!Number.isFinite(price)) return null;
  return entry.side === "CALL" ? price > entry.price : price < entry.price;
}

function safeY(
  series: PriceCoordSource | null | undefined,
  price: number,
): number | null {
  if (!series || !Number.isFinite(price) || price <= 0) return null;
  try {
    const c = series.priceToCoordinate(price);
    return typeof c === "number" && Number.isFinite(c) ? c : null;
  } catch {
    return null;
  }
}

function safeX(
  chart: TimeCoordSource | null | undefined,
  tsMs: number,
): number | null {
  if (!chart || !Number.isFinite(tsMs) || tsMs <= 0) return null;
  try {
    const c = chart.timeScale().timeToCoordinate(Math.floor(tsMs / 1000));
    return typeof c === "number" && Number.isFinite(c) ? c : null;
  } catch {
    return null;
  }
}

export interface ComputePriceMarkersArgs {
  series?: PriceCoordSource | null;
  chart?: TimeCoordSource | null;
  /** Resolved departure strike, or null when the line must not be drawn. */
  departPrice?: number | null;
  livePrice?: number | null;
  digits?: number;
  entry?: MarkerEntry | null;
  nowMs: number;
}

/**
 * Project every marker from the chart's own coordinate space. A marker whose
 * price is off the visible price scale simply does not render (`priceToCoordinate`
 * returns null) — never a fabricated position.
 */
export function computePriceMarkers(
  args: ComputePriceMarkersArgs,
): PriceMarkerSet {
  const {
    series = null,
    chart = null,
    departPrice = null,
    livePrice = null,
    digits = 5,
    entry = null,
    nowMs,
  } = args;
  const markers: PriceMarker[] = [];

  // ── DEPART — cyan dashed strike badge ──
  const departY = safeY(series, departPrice as number);
  if (departY != null && (departPrice as number) > 0) {
    markers.push({
      id: "depart",
      price: departPrice as number,
      y: departY,
      text: `DEPART | ${(departPrice as number).toFixed(digits)}`,
      tone: "depart",
      dashed: true,
    });
  }

  // ── ENTRY — the journal strike anchor ──
  if (entry) {
    const entryY = safeY(series, entry.price);
    if (entryY != null) {
      markers.push({
        id: "entry",
        price: entry.price,
        y: entryY,
        text: `ENTRY | ${entry.price.toFixed(digits)}`,
        tone: "neutral",
      });
    }
  }

  // ── LIVE / FINAL — green/red flip against the entry ──
  let liveTone: PriceMarkerTone = "neutral";
  if (livePrice != null && Number.isFinite(livePrice) && livePrice > 0) {
    if (entry) {
      liveTone = isEntryWinning(entry, livePrice) ? "win" : "loss";
    }
    const liveY = safeY(series, livePrice);
    if (liveY != null) {
      const label = entry && !entry.open ? "FINAL" : "LIVE";
      markers.push({
        id: "live",
        price: livePrice,
        y: liveY,
        text: `${label} | ${livePrice.toFixed(digits)}`,
        tone: liveTone,
      });
    }
  }

  // ── TRADE WINDOW — shaded band for an ACTIVE trade ──
  let windowOverlay: TradeWindowOverlay | null = null;
  if (
    entry &&
    entry.open &&
    entry.entryTsMs > 0 &&
    entry.expiryTsMs > entry.entryTsMs
  ) {
    const x0 = safeX(chart, entry.entryTsMs);
    const x1 = safeX(chart, entry.expiryTsMs);
    if (x0 != null && x1 != null && x1 > x0) {
      const countdownSec = Math.max(0, (entry.expiryTsMs - nowMs) / 1000);
      let tone: TradeWindowTone = "neutral";
      if (livePrice != null && Number.isFinite(livePrice) && livePrice > 0 && entry) {
        tone = isEntryWinning(entry, livePrice) ? "win" : "loss";
      }
      windowOverlay = {
        x0,
        x1,
        tone,
        countdownSec,
        countdownLabel: formatCountdownLabel(countdownSec),
      };
    }
  }

  return { markers, window: windowOverlay };
}
