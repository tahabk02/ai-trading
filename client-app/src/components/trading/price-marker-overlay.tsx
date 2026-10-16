"use client";

import React from "react";
import {
  DEPART_COLOR,
  LOSS_COLOR,
  NEUTRAL_MARKER_COLOR,
  WIN_COLOR,
  type PriceMarkerSet,
  type PriceMarkerTone,
  type TradeWindowTone,
} from "@/lib/priceMarkerOverlay";

/**
 * PHASE 4 — PriceMarkerOverlay.
 *
 * A high-contrast DOM layer pinned over the candle canvas that renders the
 * DEPART strike, the journal ENTRY strike and the LIVE/FINAL price badge as
 * real text (not canvas pixels), so they stay crisp at any devicePixelRatio,
 * remain readable over any tape, and can be asserted in the DOM.
 *
 * It is purely presentational: every coordinate is already projected to pixels
 * by `computePriceMarkers`, so this component never reads the chart at render
 * time. `pointer-events-none` keeps it from ever stealing a click from the
 * controls below it.
 */

function textColor(tone: PriceMarkerTone | TradeWindowTone): string {
  switch (tone) {
    case "depart":
      return "text-cyan-300";
    case "win":
      return "text-emerald-300";
    case "loss":
      return "text-rose-300";
    default:
      return "text-slate-200";
  }
}

function borderColor(tone: PriceMarkerTone | TradeWindowTone): string {
  switch (tone) {
    case "depart":
      return DEPART_COLOR;
    case "win":
      return WIN_COLOR;
    case "loss":
      return LOSS_COLOR;
    default:
      return NEUTRAL_MARKER_COLOR;
  }
}

function windowFill(tone: TradeWindowTone): string {
  if (tone === "win") return "rgba(34,197,94,0.10)";
  if (tone === "loss") return "rgba(239,68,68,0.10)";
  return "rgba(148,163,184,0.08)";
}

export const PriceMarkerOverlay: React.FC<PriceMarkerSet> = ({
  markers,
  window: windowOverlay,
}) => {
  return (
    <div
      data-testid="price-marker-overlay"
      className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
    >
      {/* ── TRADE-WINDOW SHADING ── the active-trade band, entry → expiry. */}
      {windowOverlay ? (
        <div
          data-testid="trade-window"
          data-tone={windowOverlay.tone}
          data-x0={windowOverlay.x0}
          data-x1={windowOverlay.x1}
          className="absolute inset-y-0"
          style={{
            left: windowOverlay.x0,
            width: Math.max(0, windowOverlay.x1 - windowOverlay.x0),
            background: windowFill(windowOverlay.tone),
            borderLeft: `1px dashed ${NEUTRAL_MARKER_COLOR}`,
            borderRight: `1px dashed ${NEUTRAL_MARKER_COLOR}`,
          }}
        >
          <span
            data-testid="trade-window-countdown"
            data-seconds={windowOverlay.countdownSec}
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border bg-obsidian/85 px-1.5 py-0.5 font-mono text-[9px] font-black uppercase tabular-nums tracking-widest ${textColor(
              windowOverlay.tone,
            )}`}
            style={{ borderColor: borderColor(windowOverlay.tone) }}
          >
            {windowOverlay.countdownLabel}
          </span>
        </div>
      ) : null}

      {/* ── PRICE MARKERS — DEPART (left) / ENTRY + LIVE·FINAL (right) ── */}
      {markers.map((m) => (
        <div
          key={m.id}
          data-testid={`price-marker-${m.id}`}
          data-tone={m.tone}
          data-price={m.price}
          data-y={m.y}
          data-dashed={m.dashed ? "true" : "false"}
          className={`absolute -translate-y-1/2 whitespace-nowrap rounded border bg-obsidian/85 px-1.5 py-0.5 font-mono text-[9px] font-black uppercase tabular-nums tracking-widest ${textColor(
            m.tone,
          )}`}
          style={{
            top: m.y,
            ...(m.id === "depart" ? { left: 8 } : { right: 8 }),
            borderColor: borderColor(m.tone),
            borderStyle: m.dashed ? "dashed" : "solid",
          }}
        >
          {m.text}
        </div>
      ))}
    </div>
  );
};

export default PriceMarkerOverlay;
