"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createMatrixState,
  resetTelemetryWindow,
  buildTopology,
  sampleTelemetry,
  sameTelemetry,
  step,
  LANE_META,
  EMITTER_POSITION,
  type MatrixFeed,
  type MatrixState,
  type MatrixTelemetry,
} from "@/lib/neuralMatrix/engine";
import type { MarketLane, MatrixNode } from "@/lib/neuralMatrix/types";

/**
 * NEURAL MATRIX ENGINE HOOK
 * ============================================================================
 * The performance contract, stated once, so the component body can be read for
 * design rather than for defensive plumbing.
 *
 * INVARIANT 1 — ZERO-HOP TICK PATH
 * --------------------------------
 * There is NO `useEffect` in this file that depends on a live price, and NO
 * `useState` written from the render loop. Concretely:
 *
 *   ticks ──► [caller-supplied readFeed(), a getState() call] ──► ref
 *        └─► ONE rAF loop: step() + paint() + 1 Hz telemetry sample
 *
 * The store is read through `readFeed`, which callers implement with
 * `useTradingStore.getState()` — a non-reactive snapshot read. It costs a map
 * lookup and cannot schedule a render, so a 200 Hz tape produces 200 physics
 * steps and ZERO React renders.
 *
 * DECOUPLING FROM THE CHART'S TICK LOOP
 * -------------------------------------
 * This loop is INDEPENDENT of `financial-chart.tsx`'s painter: separate rAF
 * handle, separate state object, separate canvas. The chart coalesces ticks
 * into one paint per frame; this engine coalesces them into one physics step
 * per frame. Neither waits on the other, so a slow graph frame can never
 * back-pressure the candle paint (and vice versa) — which is exactly the
 * render-storm coupling this was asked to avoid.
 *
 * THE SINGLE REACT BRIDGE
 * -----------------------
 * `telemetry` is the only value that crosses into React, and it is published
 * under THREE independent gates:
 *
 *   1. At most once per second (never per frame).
 *   2. Only when a DISPLAYED field changed (`sameTelemetry` reference bail-out).
 *   3. Never while the document is hidden or the canvas is off-screen.
 *
 * A steady feed therefore costs 0 renders/sec, not 1. The canvas itself never
 * round-trips through React at all.
 */

const TELEMETRY_INTERVAL_MS = 1_000;
/** Cap on catch-up after a hidden tab resumes. Mirrors the engine's own clamp. */
const MAX_FRAME_MS = 50;

export interface MatrixNodeInfo {
  readonly id: string;
  readonly label: string;
  readonly lane: MarketLane;
  readonly role: string;
  /** Cached screen position of the node's centre, in CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly radiusPx: number;
  readonly load: number;
  readonly arrivals: number;
}

export interface UseNeuralMatrixOptions {
  /**
   * Reads the live terminal state NON-REACTIVELY. Must be implemented with
   * `store.getState()` (or an equivalent ref read) — a reactive read here
   * would re-subscribe and reintroduce a render per tick.
   */
  readFeed: () => MatrixFeed;
  /** Whether the socket is live. Only affects chrome, never the physics rate. */
  live: boolean;
  /** Disable the rAF loop entirely (e.g. focus mode, reduced motion). */
  paused?: boolean;
}

export interface UseNeuralMatrixResult {
  /** Attach to the `<canvas>` element. */
  canvasRef: React.RefObject<HTMLCanvasElement>;
  /** Change-gated, 1 Hz snapshot for the DOM chrome. */
  telemetry: MatrixTelemetry;
  /** Node currently under the pointer, or null. Set by pointer events only. */
  hovered: MatrixNodeInfo | null;
  /** Node clicked by the operator (a real user gesture, so React-owned). */
  pinned: MatrixNodeInfo | null;
  /** Lane rail metadata for the left-hand legend. */
  lanes: typeof LANE_META;
  /** Emitter anchor in normalized space, for the verdict badge overlay. */
  emitter: typeof EMITTER_POSITION;
  /** Hit-test a normalized position. Returns the node info or null. */
  probe: (nx: number, ny: number) => MatrixNodeInfo | null;
  setHovered: (info: MatrixNodeInfo | null) => void;
  setPinned: (info: MatrixNodeInfo | null) => void;
}

/**
 * Placeholder shown before the first real sample.
 *
 * `totalNodes` is derived from the actual topology rather than hardcoded, so
 * the pre-mount frame can never disagree with the graph it precedes. The
 * labels match the real formatter's output shape exactly: no zero-padding, or
 * the first render would flicker from "00%" to "0%".
 */
const EMPTY_TELEMETRY: MatrixTelemetry = {
  throughput: 0,
  activeNodes: 0,
  totalNodes: buildTopology().nodes.length,
  inFlight: 0,
  conviction: 0,
  convictionLabel: "0%",
  live: false,
  totalDelivered: 0,
  throughputLabel: "0/s",
};

function nodeInfo(
  state: MatrixState,
  index: number,
  width: number,
  height: number,
): MatrixNodeInfo {
  const n: MatrixNode = state.nodes[index];
  return {
    id: n.id,
    label: n.label,
    lane: n.lane,
    role: n.role,
    x: n.x * width,
    y: n.y * height,
    radiusPx: n.r * Math.min(width, height),
    load: n.load,
    arrivals: n.arrivals,
  };
}

export function useNeuralMatrix({
  readFeed,
  live,
  paused = false,
}: UseNeuralMatrixOptions): UseNeuralMatrixResult {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The simulation lives in a ref: it is mutated ~60x/second and must never
  // appear in a dependency array or a render.
  const stateRef = useRef<MatrixState | null>(null);
  // Latest metrics (canvas box) live in a ref too — the rAF loop reads them
  // every frame and they must not trigger a re-bind of the loop.
  const metricsRef = useRef({ width: 0, height: 0, dpr: 1 });
  // Palette lives in a ref; re-read on theme change, never per frame.
  const paletteRef = useRef<CanvasPalette | null>(null);
  // The feed reader is held in a ref so a caller passing an inline arrow
  // (the common case) does not tear down and rebuild the rAF loop each render.
  const readFeedRef = useRef(readFeed);
  readFeedRef.current = readFeed;
  const liveRef = useRef(live);
  liveRef.current = live;

  const [telemetry, setTelemetry] = useState<MatrixTelemetry>(EMPTY_TELEMETRY);
  const [hovered, setHovered] = useState<MatrixNodeInfo | null>(null);
  const [pinned, setPinned] = useState<MatrixNodeInfo | null>(null);
  const telemetryRef = useRef<MatrixTelemetry>(EMPTY_TELEMETRY);

  // ── 1. ALLOCATE ONCE ────────────────────────────────────────────────────
  useEffect(() => {
    stateRef.current = createMatrixState();
    resetTelemetryWindow(stateRef.current);
    return () => {
      // Drop the simulation on unmount. The packet pool is a few hundred small
      // objects; letting them go with the ref is correct and keeps a remount
      // (e.g. focus-mode toggle) from inheriting stale pressure.
      stateRef.current = null;
    };
  }, []);

  // ── 2. CANVAS METRICS (DPR-aware) ───────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const parent = canvas.parentElement;
      const rect = parent
        ? parent.getBoundingClientRect()
        : { width: 0, height: 0 };
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      if (w === 0 || h === 0) return;
      // Cap DPR at 2. Beyond that the extra pixels cost real fill rate on a
      // 4K/retina panel for no perceptible gain on a 1px hairline grid, and
      // this canvas repaints every frame.
      const dpr = Math.min(
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
        2,
      );
      metricsRef.current = { width: w, height: h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };

    measure();
    const ro = new ResizeObserver(measure);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // ── 3. PALETTE (theme-aware, re-read on class flip) ─────────────────────
  useEffect(() => {
    const read = () => {
      paletteRef.current = readCanvasPalette();
    };
    read();
    // The design system themes via the `<html class="dark|light">` class, so a
    // MutationObserver on `class` is the correct signal — not a media query.
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  // ── 4. THE SINGLE rAF LOOP ──────────────────────────────────────────────
  useEffect(() => {
    if (paused) return;
    if (typeof window === "undefined") return;

    // Captured once for the IntersectionObserver below; the loop itself reads
    // the live ref, so re-binding the canvas element never happens here.
    const observed = canvasRef.current;

    let raf = 0;
    let last = performance.now();
    let lastSample = last;
    let visible = true;
    // The 2D context is bound to this canvas element for its whole lifetime, so
    // it is resolved once here rather than 60 times a second. Local (not a ref)
    // because it dies with this effect: a remount gets a NEW canvas element, and
    // reusing a context across elements would draw into the wrong bitmap.
    const ctxRef: { current: CanvasRenderingContext2D | null } = { current: null };
    // Off-screen culling. The Pro terminal is a SCROLLPORT: the graph lives
    // below the fold on a laptop, and a 60fps canvas nobody is looking at is
    // pure battery burn. IntersectionObserver is the cheap, exact signal.
    let onScreen = true;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);

      const state = stateRef.current;
      const canvas = canvasRef.current;
      if (!state || !canvas) return;

      // Skip physics + paint entirely while hidden or off-screen. The loop
      // keeps ticking (so `last` stays fresh and we don't accumulate a huge dt),
      // but costs nothing.
      if (!visible || !onScreen) {
        last = now;
        return;
      }

      const dt = Math.min(now - last, MAX_FRAME_MS);
      last = now;
      if (dt <= 0) return;

      // ── 4a. PHYSICS (one step per frame, whatever the tick rate) ─────────
      const feed = readFeedRef.current();
      step(state, feed, dt);

      // ── 4b. PAINT (imperative; React is not involved) ────────────────────
      // The context is acquired ONCE per element, not per frame. It is
      // immutable for the lifetime of a canvas, and re-querying it 60×/s is
      // pure overhead. Guarded anyway because jsdom's `getContext` returns
      // null, and a thrown TypeError inside a rAF callback would tear down the
      // whole loop.
      if (!ctxRef.current) ctxRef.current = canvas.getContext("2d", { alpha: true });
      const ctx = ctxRef.current;
      const { width, height, dpr } = metricsRef.current;
      if (ctx && width > 0 && height > 0) {
        paintMatrix(ctx, state, width, height, dpr, paletteRef.current, feed);
      }

      // ── 4c. TELEMETRY (1 Hz, change-gated) ──────────────────────────────
      if (now - lastSample >= TELEMETRY_INTERVAL_MS) {
        lastSample = now;
        const next = sampleTelemetry(state, feed);
        // Bail out with the SAME reference when nothing displayed changed —
        // React skips the render entirely instead of reconciling an identical
        // object. This is what turns "1 sample/sec" into "0 renders/sec".
        if (!sameTelemetry(telemetryRef.current, next)) {
          telemetryRef.current = next;
          setTelemetry(next);
        }
      }
    };

    raf = requestAnimationFrame(frame);

    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      // Reset the clock on resume so the first frame back is not a huge dt.
      if (visible) last = performance.now();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined" && observed) {
      io = new IntersectionObserver(
        (entries) => {
          onScreen = entries[entries.length - 1]?.isIntersecting ?? true;
        },
        { threshold: 0 },
      );
      io.observe(observed);
    }

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      io?.disconnect();
    };
  }, [paused]);

  // ── 5. HIT-TEST ─────────────────────────────────────────────────────────
  const probe = useCallback((nx: number, ny: number): MatrixNodeInfo | null => {
    const state = stateRef.current;
    const { width, height } = metricsRef.current;
    if (!state || width === 0 || height === 0) return null;
    // Nearest node within its own radius wins; ties break to the lower index so
    // overlapping nodes resolve deterministically.
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < state.nodes.length; i += 1) {
      const n = state.nodes[i];
      const dx = n.x - nx;
      const dy = n.y - ny;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= n.r * 1.6 && d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return best < 0 ? null : nodeInfo(state, best, width, height);
  }, []);

  return {
    canvasRef,
    telemetry,
    hovered,
    pinned,
    lanes: LANE_META,
    emitter: EMITTER_POSITION,
    probe,
    setHovered,
    setPinned,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CANVAS PALETTE — resolved from the design-system CSS variables
// ═══════════════════════════════════════════════════════════════════════════

interface CanvasPalette {
  grid: string;
  laneBand: string;
  edge: string;
  edgeActive: string;
  node: Record<MarketLane, string>;
  nodeRole: Record<string, string>;
  packet: Record<MarketLane, string>;
  buy: string;
  sell: string;
  text: string;
  textDim: string;
}

function cssColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Channel-triplet tokens (`--term-gold: 216 160 72`) need `rgb(...)` wrapping;
 * hex tokens (`--tp-accent: #22ab94`) do not. Detect and normalize so one
 * token vocabulary serves both — exactly what tailwind.config.js does with
 * `rgb(var(--x) / <alpha-value>)`.
 */
function channel(name: string, fallback: string): string {
  const raw = cssColor(name, "");
  if (!raw) return fallback;
  if (/^\d+\s+\d+\s+\d+$/.test(raw)) return `rgb(${raw})`;
  return raw;
}

function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    const hex = c.length === 4 ? c.slice(1) : c.slice(1, 7);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((ch) => ch + ch)
            .join("")
        : hex;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return c;
  }
  // CSS Color 4 allows both comma and space syntax, plus a slash-alpha. The
  // space form is what OUR `channel()` helper emits (`rgb(216 160 72)`), so a
  // comma-only split would silently fall through and return the colour
  // UNCHANGED — every lane and edge would render fully opaque. Slash-alpha is
  // parsed and discarded: the caller supplies its own alpha, and a stale one
  // baked into the token would defeat that.
  const m = c.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1]
      .replace(/\//g, " ")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length >= 3) {
      const [r, g, b] = parts;
      // Guard against non-numeric junk producing `rgba(nan, ...)`.
      if (/^[\d.]+$/.test(r) && /^[\d.]+$/.test(g) && /^[\d.]+$/.test(b)) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
  }
  return c;
}

function readCanvasPalette(): CanvasPalette {
  // Every colour comes from the design system. No raw hex literals here, so the
  // graph re-themes with the rest of the terminal when `html.light` flips.
  const gold = channel("--term-gold", "#d8a048");
  const crypto = channel("--term-crypto", "#00b3c9");
  const accent = cssColor("--tp-accent", "#22ab94");
  const bull = channel("--bull", "#22ab94");
  const bear = channel("--bear", "#f23645");
  const line = cssColor("--tp-border", "rgba(148,163,184,0.14)");
  return {
    grid: cssColor("--tp-grid", "rgba(148,163,184,0.14)"),
    laneBand: line,
    edge: line,
    edgeActive: accent,
    node: { real: gold, otc: accent, crypto },
    nodeRole: {
      ingest: gold,
      analysis: accent,
      consensus: crypto,
      emitter: accent,
    },
    packet: { real: gold, otc: accent, crypto },
    buy: bull,
    sell: bear,
    text: cssColor("--tp-text", "#f8fafc"),
    textDim: cssColor("--tp-text-3", "#64748b"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PAINTER — one full repaint per frame, zero React
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Draw the whole graph.
 *
 * Draw order is deliberate and reads back-to-front like a real instrument:
 * lane bands → conduits → packets → nodes → labels. Packets sit UNDER nodes so
 * a signal appears to enter a node rather than paint over it.
 *
 * PERFORMANCE NOTES
 *  - `shadowBlur` is deliberately NEVER used. Canvas shadow blur is a per-draw
 *    Gaussian on the CPU and would dominate the frame at 22 nodes + hundreds of
 *    packets. Glow is faked with two concentric `arc` fills at rising alpha,
 *    which is ~20x cheaper and visually equivalent at these radii.
 *  - All path state is set once per style group; no per-node `save/restore`.
 *  - The background is cleared with a single `clearRect`, not a repaint of the
 *    card gradient (the CSS already draws the surface behind the canvas).
 */
function paintMatrix(
  ctx: CanvasRenderingContext2D,
  state: MatrixState,
  width: number,
  height: number,
  dpr: number,
  palette: CanvasPalette | null,
  feed: MatrixFeed,
): void {
  const p = palette ?? readCanvasPalette();
  const nodes = state.nodes;
  const edges = state.edges;
  const min = Math.min(width, height);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // ── LANE BANDS ──────────────────────────────────────────────────────────
  ctx.lineWidth = 1;
  for (const lane of LANE_META) {
    const y = lane.y * height;
    const active = feed.lane === lane.lane;
    ctx.strokeStyle = withAlpha(
      p.node[lane.lane],
      active ? 0.28 : 0.1,
    );
    ctx.setLineDash(active ? [] : [2, 6]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // ── CONDUITS ────────────────────────────────────────────────────────────
  // Two passes: a dim base for every conduit, then a brighter overlay for the
  // ones carrying load. Alpha encodes conductance, not identity.
  ctx.lineWidth = 1;
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i];
    const a = nodes[e.from];
    const b = nodes[e.to];
    const heat = Math.min(1, (a.load + b.load) * 0.5);
    ctx.strokeStyle = withAlpha(p.edge, 0.1 + heat * 0.5);
    ctx.beginPath();
    ctx.moveTo(a.x * width, a.y * height);
    // Quadratic control point bowed toward the vertical midpoint gives the
    // bundled-cable look a plain polyline cannot.
    const mx = (a.x + b.x) * 0.5 * width;
    const my = (a.y + b.y) * 0.5 * height;
    ctx.quadraticCurveTo(
      mx,
      my + (a.y < b.y ? 1 : -1) * min * 0.03,
      b.x * width,
      b.y * height,
    );
    ctx.stroke();
  }

  // ── PACKETS ─────────────────────────────────────────────────────────────
  for (let i = 0; i < state.live.length; i += 1) {
    const packet = state.packets[state.live[i]];
    const e = edges[packet.edge];
    const a = nodes[e.from];
    const b = nodes[e.to];
    const t = packet.t;
    // Quadratic Bézier evaluation — matches the conduit's own curvature, so a
    // packet rides exactly along the drawn cable instead of cutting the corner.
    const inv = 1 - t;
    const cx = (a.x + b.x) * 0.5;
    const cy = (a.y + b.y) * 0.5 + (a.y < b.y ? 1 : -1) * 0.03;
    const x = inv * inv * a.x + 2 * inv * t * cx + t * t * b.x;
    const y = inv * inv * a.y + 2 * inv * t * cy + t * t * b.y;

    // Direction wins over lane for colour: a BUY consensus pulse must read
    // green even while it is still inside the crypto lane.
    const color =
      packet.direction === "BUY"
        ? p.buy
        : packet.direction === "SELL"
          ? p.sell
          : p.packet[e.lane];
    const px = x * width;
    const py = y * height;
    const r = (packet.kind === "signal" ? 2.6 : 1.7) * packet.strength;

    ctx.fillStyle = withAlpha(color, 0.16);
    ctx.beginPath();
    ctx.arc(px, py, r * 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = withAlpha(color, 0.95);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── NODES ───────────────────────────────────────────────────────────────
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    const x = n.x * width;
    const y = n.y * height;
    const r = Math.max(3, n.r * min);
    const isEmitter = n.role === "emitter";
    const color = p.nodeRole[n.role] ?? p.node[n.lane];

    // Fake glow: two rings at rising alpha. Cheap, and it reads as bloom.
    ctx.fillStyle = withAlpha(color, 0.05 + n.load * 0.12);
    ctx.beginPath();
    ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = withAlpha(color, 0.1 + n.load * 0.22);
    ctx.beginPath();
    ctx.arc(x, y, r * 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Core. The emitter's radius breathes with conviction — the single
    // strongest signal in the whole panel, readable at a glance.
    const pulse = isEmitter ? 1 + state.conviction * 0.28 : 1;
    ctx.fillStyle = withAlpha(
      isEmitter && state.conviction > 0.05
        ? state.conviction > 0.5
          ? p.buy
          : p.sell
        : color,
      isEmitter ? 0.95 : 0.55 + n.load * 0.45,
    );
    ctx.beginPath();
    ctx.arc(x, y, r * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Hairline ring — the "sharp border" that keeps the graph institutional
    // rather than glowy-blob.
    ctx.strokeStyle = withAlpha(color, 0.85);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r * pulse + 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ── LABELS (only for the agents that earn one) ──────────────────────────
  // Labelling all 19 nodes is noise. Ingest, consensus and the emitter carry
  // the semantic weight; the twelve analysts stay anonymous by design.
  ctx.font = `600 ${Math.round(9)}px ui-monospace, "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (n.role === "analysis") continue;
    const x = n.x * width;
    const y = n.y * height;
    const r = Math.max(3, n.r * min);
    const right = n.role !== "ingest";
    const lx = x + (right ? r + 6 : -(r + 6));
    ctx.textAlign = right ? "left" : "right";
    ctx.fillStyle = withAlpha(n.role === "emitter" ? p.text : p.textDim, 0.9);
    ctx.fillText(n.label, lx, y);
  }
}
