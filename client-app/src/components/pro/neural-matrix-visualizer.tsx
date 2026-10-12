"use client";

import React, { useCallback, useRef } from "react";

import { useNeuralMatrix, type MatrixNodeInfo } from "@/hooks/useNeuralMatrix";
import { useTradingStore } from "@/store/useTradingStore";
import { useSignalViewStore, selectSignalView } from "@/lib/signalViewStore";
import { getAssetSubType } from "@/constants/symbols";
import type { MarketLane, MatrixFeed } from "@/lib/neuralMatrix/engine";

/**
 * SIGNAL CONFLUENCE MAP VISUALIZER
 * ============================================================================
 * Renders the three market channels (REAL / OTC / CRYPTO) as an ingest →
 * analysis → consensus convergence trace resolving to a single fused VERDICT.
 * Signals are real packets travelling real conduits; conviction is the actual
 * gated BUY/SELL from the ONE coherent signal view the chart already publishes.
 *
 * The visible header reads "Signal Confluence Map" (PART 32[237]) — this panel
 * shows where market channels AGREE, and must not imply autonomous agency.
 * The file name, `useNeuralMatrix` hook, and `neuralMatrix/engine` module are
 * internal implementation detail and are intentionally left unchanged.
 *
 * ── WHY THE FEED IS A `getState()` CALL, NOT A SUBSCRIPTION ──────────────
 * The obvious implementation reads `useTradingStore(s => s.currentPrice)`.
 * That is the exact failure INVARIANT 1 exists to prevent: `currentPrice` is
 * written on EVERY tick, so that subscription re-renders this component — and
 * therefore the whole Pro page — once per packet. On a 200 Hz tape that is 200
 * renders/second of a component whose canvas is repainting at 60.
 *
 * Instead, `readFeed` below is a NON-REACTIVE snapshot read. It is called
 * inside the render loop, costs a map lookup, and cannot schedule a render.
 * The simulation therefore advances at the display refresh rate while React
 * stays completely idle. See `useNeuralMatrix` for the full contract.
 *
 * ── WHAT THIS COMPONENT RENDERS ──────────────────────────────────────────
 *   • canvas          — the graph (painted imperatively, never via React)
 *   • lane rail       — the three market channels + their live agent counts
 *   • telemetry strip — throughput / in-flight / conviction, change-gated 1 Hz
 *   • inspector       — the hovered or pinned agent's details
 *
 * All numerals use `.num-fig` (tabular + lining figures) so a value that
 * updates never reflows the strip — a hard requirement for a read that
 * repaints once a second in a column the operator is watching.
 */

interface NeuralMatrixVisualizerProps {
  /** Canonical symbol for the pair-aware price formatting. */
  symbol?: string;
  /** Socket liveness. Drives the status ping and the feed's traffic pressure. */
  live?: boolean;
  /** Render a compact height for stacked/mobile layouts. */
  compact?: boolean;
}

/**
 * Asset-subtype → matrix-lane bridge.
 *
 * `getAssetSubType` classifies into `"forex" | "otc" | "crypto"`, but the
 * matrix names the wholesale channel "real" (REAL MARKET), matching the
 * `term-gold` = real-market convention the rest of the terminal uses. The two
 * vocabularies are bridged HERE and only here, so the rest of the component
 * never has to know both names exist.
 */
function laneOf(symbol: string): MarketLane {
  if (!symbol) return "otc";
  const sub = getAssetSubType(symbol);
  if (sub === "crypto") return "crypto";
  if (sub === "otc") return "otc";
  return "real";
}

/**
 * Lane hue per channel, expressed as the SAME CSS variables the canvas palette
 * reads. Real = gold, Crypto = cyan, OTC = the terminal accent teal — matching
 * the `term-gold` / `term-crypto` classification already used by the Order Book
 * and signal cards, so a colour never means two different things on one screen.
 */
const LANE_TOKEN: Record<MarketLane, string> = {
  real: "var(--term-gold)",
  otc: "var(--tp-accent)",
  crypto: "var(--term-crypto)",
};

export const NeuralMatrixVisualizer: React.FC<NeuralMatrixVisualizerProps> = ({
  symbol,
  live = false,
  compact = false,
}) => {
  // ── THE ONE COHERENT SIGNAL VIEW ───────────────────────────────────────
  // Subscribing to the *view* is safe: `signalViewStore` publishes at most once
  // per broker bucket and is change-gated on all four fields, so this re-renders
  // on genuine signal transitions only — not per tick. Reading the raw
  // `predictionData.signal` here instead would reintroduce the exact drift the
  // store was built to eliminate.
  const coherentView = useSignalViewStore(selectSignalView);

  // ── NON-REACTIVE FEED READER ────────────────────────────────────────────
  // Built once from the refs, so its identity is stable and the rAF loop never
  // restarts. Everything it touches is a `getState()` snapshot.
  const feedRef = useRef<MatrixFeed>({
    symbol: "",
    lane: "otc",
    price: 0,
    target: 0,
    anchor: 0,
    atr: 0,
    confluence: 0,
    direction: null,
    live: false,
  });

  const readFeed = useCallback((): MatrixFeed => {
    const state = useTradingStore.getState();
    const view = useSignalViewStore.getState().view;
    const feed = feedRef.current;

    feed.symbol = state.activeSymbol;
    feed.lane = laneOf(state.activeSymbol);
    feed.price = state.currentPrice;
    feed.target = Number(state.predictionData?.target_price) || 0;
    feed.anchor = Number(state.predictionData?.current_price) || 0;
    feed.atr =
      Number(state.predictionData?.atr) ||
      Number(state.predictionData?.scalping_indicators?.atr_14) ||
      0;
    // Book agreement is the honest confluence number here (see PART 19.2 in
    // services/api.ts); `confidence` is a pipeline identifier, not a
    // probability, so it is deliberately NOT used as a "confidence" readout.
    feed.confluence = Number(state.predictionData?.book_agreement) || 0;
    // The GATED direction — the same buffer the chart HUD renders, so the
    // emitter's colour can never contradict the label a few pixels away.
    feed.direction = view ? view.gatedSignal : null;
    feed.live = live;
    return feed;
  }, [live]);

  const { canvasRef, telemetry, hovered, pinned, lanes, probe, setHovered, setPinned } =
    useNeuralMatrix({ readFeed, live });
  // ── POINTER HANDLERS ────────────────────────────────────────────────────
  // These are the ONLY things that set React state from the canvas, and both
  // are genuine user gestures — never a tick, never a frame.
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      setHovered(
        probe((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height),
      );
    },
    [canvasRef, probe, setHovered],
  );

  const handlePointerLeave = useCallback(() => setHovered(null), [setHovered]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const hit = probe(
        (e.clientX - rect.left) / rect.width,
        (e.clientY - rect.top) / rect.height,
      );
      // Click-to-pin, click-again-to-release. Pinned state survives the pointer
      // leaving the canvas so an operator can read a node's stats and move on.
      setPinned(pinned && hit && pinned.id === hit.id ? null : hit);
    },
    [canvasRef, pinned, probe, setPinned],
  );

  // ── INSPECTOR SOURCE: pinned wins, hovered is the transient fallback ────
  const inspected: MatrixNodeInfo | null = pinned ?? hovered;

  // The display symbol is the terminal's canonical symbol, uppercased to match
  // every other symbol prop on the Pro page.
  const displaySymbol = (symbol || "").trim().toUpperCase() || "--";

  const activeLane = laneOf(displaySymbol === "--" ? "" : displaySymbol);
  const verdict = coherentView ? coherentView.gatedSignal : null;

  return (
    <section
      data-testid="neural-matrix"
      aria-label="Signal confluence map — multi-market agreement"
      className="tp-card relative flex w-full min-w-0 flex-col overflow-hidden"
    >
      {/* ═══ HEADER — identity + live status ═══ */}
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--tp-border)] bg-[var(--tp-elevated)]/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              live ? "animate-pulse-glow bg-st-pos" : "bg-st-neg"
            }`}
          />
          <h3 className="truncate text-[10px] font-black uppercase tracking-[0.2em] text-ink">
            Signal Confluence Map
          </h3>
        </div>

        <span className="num-fig ml-1 shrink-0 rounded-[4px] border border-[var(--tp-border)] px-1.5 py-0.5 text-[9px] font-bold text-ink-muted">
          {displaySymbol}
        </span>

        <span
          className={`num-fig shrink-0 rounded-[4px] border px-1.5 py-0.5 text-[9px] font-bold tracking-widest ${
            verdict === "BUY"
              ? "border-st-pos/40 bg-st-pos/10 text-st-pos"
              : verdict === "SELL"
                ? "border-st-neg/40 bg-st-neg/10 text-st-neg"
                : "border-[var(--tp-border)] bg-[var(--tp-well)] text-ink-faint"
          }`}
          title="Gated consensus direction — the same view the chart HUD renders"
        >
          {verdict ?? "HOLD"}
        </span>

        <div className="ml-auto flex items-center gap-3 text-[9px] font-mono uppercase tracking-widest text-ink-faint">
          <span className="hidden xs:inline">AGENTS</span>
          <span className="num-fig text-ink-muted">
            {telemetry.activeNodes}
            <span className="text-ink-faint">/{telemetry.totalNodes}</span>
          </span>
        </div>
      </header>

      {/* ═══ BODY — canvas + lane rail ═══ */}
      {/*
        Height budget. Deliberately smaller than the chart's
        `clamp(280px,42vh,520px)` because this panel carries a header AND a
        telemetry strip BELOW the canvas, and because the chart is
        `position:sticky` with an opaque background: anything taller than the
        free space beneath the pinned chart has to scroll, and a scrolled
        matrix slides UNDER the chart (measured: header at y=398 vs chart
        bottom y=587 at 1280x720).

        24vh keeps header + graph + footer fully on screen at 1920x1080 and
        above with zero scrolling, so the graph is never occluded. On short
        viewports the column still scrolls, which is the correct trade: the
        operator keeps price action pinned while reading telemetry.
      */}
      <div
        className={`relative flex w-full min-w-0 ${
          compact ? "h-[200px]" : "h-[clamp(200px,24vh,300px)]"
        }`}
      >
        <div className="absolute inset-0">
          <canvas
            ref={canvasRef}
            data-testid="neural-matrix-canvas"
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onClick={handleClick}
            role="img"
            aria-label={`Agent network consensus graph. ${telemetry.activeNodes} of ${telemetry.totalNodes} agents active, ${telemetry.inFlight} signals in flight, consensus ${telemetry.convictionLabel}.`}
            className="absolute inset-0 cursor-crosshair"
          />
        </div>

        {/* ── LANE RAIL — the three market channels ── */}
        <ul className="pointer-events-none absolute left-0 top-0 z-10 flex h-full w-[74px] flex-col justify-around py-2 pl-2">
          {lanes.map((lane) => {
            const active = activeLane === lane.lane;
            return (
              <li key={lane.lane} className="leading-none">
                <div
                  className={`h-px w-3 transition-opacity duration-150 ${
                    active ? "opacity-100" : "opacity-30"
                  }`}
                  style={{ backgroundColor: LANE_TOKEN[lane.lane] }}
                />
                <div
                  className={`mt-1 text-[8px] font-black uppercase tracking-[0.12em] ${
                    active ? "text-ink" : "text-ink-faint"
                  }`}
                >
                  {lane.badge}
                </div>
                <div className="text-[7px] font-mono uppercase tracking-wider text-ink-faint">
                  {lane.title}
                </div>
              </li>
            );
          })}
        </ul>

        {/* ── INSPECTOR — hovered or pinned agent ── */}
        {inspected && (
          <aside
            data-testid="neural-matrix-inspector"
            className="pointer-events-none absolute right-2 top-2 z-20 min-w-[150px] rounded-[6px] border border-[var(--tp-border-strong)] bg-[var(--tp-surface)]/95 px-2.5 py-2 shadow-lg backdrop-blur-sm"
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[10px] font-black tracking-wider text-ink">
                {inspected.label}
              </span>
              {pinned && (
                <span className="num-fig ml-auto text-[8px] uppercase tracking-widest text-st-info">
                  PINNED
                </span>
              )}
            </div>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] font-mono">
              <dt className="text-ink-faint">ROLE</dt>
              <dd className="num-fig text-right uppercase text-ink-muted">
                {inspected.role}
              </dd>
              <dt className="text-ink-faint">LANE</dt>
              <dd className="num-fig text-right uppercase text-ink-muted">
                {inspected.lane}
              </dd>
              <dt className="text-ink-faint">LOAD</dt>
              <dd className="num-fig text-right text-ink-muted">
                {(inspected.load * 100).toFixed(0)}%
              </dd>
              <dt className="text-ink-faint">RX</dt>
              <dd className="num-fig text-right text-ink-muted">
                {inspected.arrivals}
              </dd>
            </dl>
          </aside>
        )}

        {/* ── OFFLINE PLATE — never leave a frozen graph looking live ── */}
        {!live && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="rounded-[6px] border border-st-warn/40 bg-[var(--tp-surface)]/90 px-3 py-1.5 text-[9px] font-mono uppercase tracking-widest text-st-warn">
              Feed offline — matrix idle
            </div>
          </div>
        )}
      </div>

      {/* ═══ TELEMETRY STRIP — the only React-rendered numbers ═══ */}
      <footer
        data-testid="neural-matrix-telemetry"
        className="grid shrink-0 grid-cols-2 divide-x divide-[var(--tp-border)] border-t border-[var(--tp-border)] sm:grid-cols-4"
      >
        <Stat label="THROUGHPUT" value={telemetry.throughputLabel} />
        <Stat label="IN FLIGHT" value={String(telemetry.inFlight)} />
        <Stat
          label="CONVICTION"
          value={telemetry.convictionLabel}
          tone={verdict === "BUY" ? "pos" : verdict === "SELL" ? "neg" : "muted"}
        />
        <Stat
          label="DELIVERED"
          value={telemetry.totalDelivered.toLocaleString("en-US")}
        />
      </footer>
    </section>
  );
};

const Stat: React.FC<{
  label: string;
  value: string;
  tone?: "pos" | "neg" | "muted";
}> = ({ label, value, tone = "muted" }) => (
  <div className="px-3 py-1.5">
    <div className="text-[8px] font-mono uppercase tracking-[0.16em] text-ink-faint">
      {label}
    </div>
    <div
      className={`num-fig text-[11px] font-bold leading-tight ${
        tone === "pos"
          ? "text-st-pos"
          : tone === "neg"
            ? "text-st-neg"
            : "text-ink"
      }`}
    >
      {value}
    </div>
  </div>
);

export default NeuralMatrixVisualizer;
