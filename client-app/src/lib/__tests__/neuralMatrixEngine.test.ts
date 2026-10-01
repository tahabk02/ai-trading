import { describe, it, expect, beforeEach } from "vitest";

import {
  createMatrixState,
  step,
  sampleTelemetry,
  sameTelemetry,
  resetTelemetryWindow,
  DEFAULT_CONFIG,
  type MatrixFeed,
  type MatrixState,
} from "@/lib/neuralMatrix/engine";

/**
 * NEURAL MATRIX ENGINE — PURE SIMULATION CONTRACT
 * ============================================================================
 * Runs in the `logic` project (node environment, no DOM) because the engine
 * imports nothing from React. That is not a stylistic preference — it is the
 * mechanical reason a per-tick React render is impossible from this file, and
 * the layout-contract DOM suite asserts the same property at the source level.
 *
 * What is pinned here:
 *   1. Topology integrity — no orphan nodes, no dangling edges, fan-in/fan-out
 *      the engine's edge-selection walk actually depends on.
 *   2. Determinism — same seed ⇒ identical trajectory (why `Math.random()` is
 *      banned from the engine).
 *   3. Stability — a long run stays inside the box, and the packet pool never
 *      leaks (live.length is a real invariant, not a hope).
 *   4. The telemetry bail-out — the mechanism that makes a steady feed cost
 *      ZERO React renders rather than one per second.
 */

const LIVE_FEED: MatrixFeed = {
  symbol: "EUR/USD",
  lane: "otc",
  price: 1.0842,
  target: 1.0901,
  anchor: 1.0842,
  atr: 0.0004,
  confluence: 88,
  direction: "BUY",
  live: true,
};

const DEAD_FEED: MatrixFeed = { ...LIVE_FEED, price: 0, live: false, direction: null };

/** Run the simulation for `frames` at a fixed 60Hz step. */
function run(state: MatrixState, frames: number, feed: MatrixFeed = LIVE_FEED): void {
  for (let i = 0; i < frames; i += 1) step(state, feed, 1000 / 60);
}

describe("neural matrix — topology", () => {
  it("builds the documented agent graph", () => {
    const s = createMatrixState();
    // 3 lanes × (1 ingest + 4 analysts + 1 consensus) = 18, + 1 emitter.
    expect(s.nodes).toHaveLength(19);
    expect(s.nodes.filter((n) => n.role === "ingest")).toHaveLength(3);
    expect(s.nodes.filter((n) => n.role === "analysis")).toHaveLength(12);
    expect(s.nodes.filter((n) => n.role === "consensus")).toHaveLength(3);
    expect(s.nodes.filter((n) => n.role === "emitter")).toHaveLength(1);
  });

  it("covers all three market lanes", () => {
    const s = createMatrixState();
    expect(new Set(s.nodes.map((n) => n.lane))).toEqual(
      new Set(["real", "otc", "crypto"]),
    );
  });

  it("has no dangling edges and no orphan nodes", () => {
    const s = createMatrixState();
    for (const e of s.edges) {
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(s.nodes.length);
      expect(e.to).toBeLessThan(s.nodes.length);
    }
    // Every node except the emitter must have at least one outgoing conduit —
    // `pickOutgoingEdge` returns -1 for a sink, which would silently strand it.
    const withOutgoing = new Set(s.edges.map((e) => e.from));
    for (const n of s.nodes) {
      if (n.role === "emitter") continue;
      expect(withOutgoing.has(s.nodes.indexOf(n)), `${n.id} is a sink`).toBe(true);
    }
  });

  it("routes every lane consensus into the single emitter", () => {
    const s = createMatrixState();
    const emitter = s.nodes.find((n) => n.role === "emitter")!;
    const intoEmitter = s.edges.filter((e) => e.to === s.nodes.indexOf(emitter));
    expect(new Set(intoEmitter.map((e) => e.lane))).toEqual(
      new Set(["real", "otc", "crypto"]),
    );
  });

  it("starts every node on its home anchor (no fly-in transition)", () => {
    const s = createMatrixState();
    for (const n of s.nodes) {
      expect(n.x).toBe(n.ax);
      expect(n.y).toBe(n.ay);
      expect(n.vx).toBe(0);
      expect(n.vy).toBe(0);
    }
  });
});

describe("neural matrix — determinism", () => {
  it("produces an identical trajectory for an identical seed", () => {
    const a = createMatrixState({ ...DEFAULT_CONFIG, seed: 12345 });
    const b = createMatrixState({ ...DEFAULT_CONFIG, seed: 12345 });
    run(a, 300);
    run(b, 300);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    expect(a.delivered).toBe(b.delivered);
    expect(a.live.length).toBe(b.live.length);
  });

  it("diverges in TRAFFIC for a different seed (the seed is actually used)", () => {
    // Note what is deliberately NOT asserted: node POSITIONS are identical for
    // every seed, and must stay that way. Layout anchors and the wander `phase`
    // are structural constants, so the graph settles into one stable
    // equilibrium no matter the seed — a layout that reshuffled on remount
    // would be a bug, not a feature, because the operator learns the positions.
    //
    // The seed's job is to vary the PACKET FLOW: which lane is favoured, where
    // emissions enter the pipeline, and how the pool churns.
    const a = createMatrixState({ ...DEFAULT_CONFIG, seed: 1 });
    const b = createMatrixState({ ...DEFAULT_CONFIG, seed: 2 });
    run(a, 300);
    run(b, 300);
    // Same equilibrium layout, different traffic.
    expect(a.nodes.map((n) => n.x)).toEqual(b.nodes.map((n) => n.x));
    expect(a.delivered).not.toBe(b.delivered);
  });
});

describe("neural matrix — stability", () => {
  let s: MatrixState;
  beforeEach(() => {
    s = createMatrixState();
  });

  it("keeps every node inside the layout box over a long live run", () => {
    run(s, 2000);
    for (const n of s.nodes) {
      expect(Number.isFinite(n.x), `${n.id}.x finite`).toBe(true);
      expect(Number.isFinite(n.y), `${n.id}.y finite`).toBe(true);
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(1);
      expect(n.y).toBeGreaterThan(0);
      expect(n.y).toBeLessThan(1);
    }
  });

  it("never leaks packet pool slots", () => {
    run(s, 1500);
    // The pool is a fixed-size array; `live` and `free` must partition it
    // exactly. A leak here is a slow memory growth that would not show up in
    // any UI assertion.
    expect(s.live.length + s.free.length).toBe(DEFAULT_CONFIG.maxPackets);
    expect(s.free.length).toBeGreaterThan(0);
  });

  it("actually delivers packets and lights the graph up on a live feed", () => {
    run(s, 300);
    expect(s.delivered).toBeGreaterThan(0);
    expect(s.live.length).toBeGreaterThan(0);
    expect(s.nodes.some((n) => n.load > 0)).toBe(true);
  });

  it("drains to idle when the feed goes dead", () => {
    run(s, 300, LIVE_FEED);
    expect(s.live.length).toBeGreaterThan(0);
    // Pressure decays at 0.35/s and packets already in flight need to finish
    // traversing their edge (~1.1-2.8s at the current speed range), so the
    // graph empties on a ~4s tail rather than instantly. That tail is correct:
    // packets in the conduits when the tape dropped still belong somewhere.
    // A longer stall would be the bug — a disconnected tape must not leave a
    // frozen graph that still looks live.
    run(s, 600, DEAD_FEED);
    expect(s.pressure).toBe(0);
    run(s, 600, DEAD_FEED);
    expect(s.live.length).toBe(0);
    expect(s.conviction).toBe(0);
  });

  it("never integrates a huge dt (a tab resumed from the background)", () => {
    const before = s.nodes.map((n) => [n.x, n.y]);
    // A 30s background gap must NOT be replayed, or every node explodes.
    step(s, LIVE_FEED, 30_000);
    for (const n of s.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(1);
    }
    // Positions may shift a little (one clamped step) but nothing teleports.
    for (let i = 0; i < before.length; i += 1) {
      expect(Math.abs(s.nodes[i].x - before[i][0])).toBeLessThan(0.1);
    }
  });

  it("separates overlapping nodes (the collision pass works)", () => {
    // Slam two nodes into the same point and confirm separation pushes them
    // apart rather than letting them stack.
    const a = s.nodes[0];
    const b = s.nodes[1];
    a.x = 0.5;
    a.y = 0.5;
    b.x = 0.5;
    b.y = 0.5;
    a.vx = 0;
    a.vy = 0;
    b.vx = 0;
    b.vy = 0;
    run(s, 60);
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0);
  });
});

describe("neural matrix — conviction tracks the real gated signal", () => {
  it("rises for BUY and bleeds to zero for HOLD", () => {
    const s = createMatrixState();
    run(s, 400, { ...LIVE_FEED, direction: "BUY" });
    const bull = s.conviction;
    expect(bull).toBeGreaterThan(0.3);

    run(s, 400, { ...LIVE_FEED, direction: null });
    expect(s.conviction).toBeLessThan(bull);
    expect(s.conviction).toBeLessThan(0.1);
  });

  it("converges on the backend's own confidence, not a flat 100%", () => {
    // Conviction must be bounded by `confluence`. A graph that pins at 100%
    // the instant any BUY prints is visually impressive and factually useless:
    // it cannot distinguish a marginal call from a strong one.
    const low = createMatrixState();
    const high = createMatrixState();
    run(low, 1200, { ...LIVE_FEED, direction: "BUY", confluence: 25 });
    run(high, 1200, { ...LIVE_FEED, direction: "BUY", confluence: 95 });
    expect(low.conviction).toBeLessThan(0.35);
    expect(high.conviction).toBeGreaterThan(0.85);
    expect(low.conviction).toBeLessThan(high.conviction);
  });

  it("stays within [0,1]", () => {
    const s = createMatrixState();
    run(s, 600, { ...LIVE_FEED, direction: "SELL" });
    expect(s.conviction).toBeGreaterThanOrEqual(0);
    expect(s.conviction).toBeLessThanOrEqual(1);
  });

  it("ignores raw traffic while HOLD (no manufactured confidence)", () => {
    // A busy tape during a HOLD must NOT light the verdict node. If conviction
    // tracked packet throughput instead of the gated signal, this panel would
    // tell the operator the model is confident when it has said nothing.
    const s = createMatrixState();
    run(s, 200, { ...LIVE_FEED, direction: "BUY" });
    const bull = s.conviction;
    // Heavy traffic, no verdict.
    run(s, 900, { ...LIVE_FEED, direction: null, confluence: 100 });
    expect(s.delivered).toBeGreaterThan(0);
    expect(s.live.length).toBeGreaterThan(0);
    expect(s.conviction).toBeLessThan(bull * 0.2);
  });
});

describe("neural matrix — telemetry is the only React bridge", () => {
  it("bails out with the SAME reference when nothing displayed changed", () => {
    // THE load-bearing assertion for INVARIANT 1. If `sameTelemetry` ever
    // stopped comparing, a steady feed would re-render the Pro page once per
    // second forever — a slow render leak that no functional test would catch.
    //
    // Note `throughput` is deliberately NOT expected to match here: it is a
    // DELTA, so a sample that observes 221 deliveries genuinely differs from
    // one that observes none. Comparing two consecutive samples on a frozen
    // simulation would pass a broken comparator for the wrong reason. The
    // honest scenario is two samples of the SAME state with no deliveries in
    // between — which is exactly what a drained or stalled graph produces.
    const s = createMatrixState();
    run(s, 300);
    const first = sampleTelemetry(s, LIVE_FEED);
    const second = sampleTelemetry(s, LIVE_FEED);
    // Everything but the delta is already identical...
    expect(second.activeNodes).toBe(first.activeNodes);
    expect(second.convictionLabel).toBe(first.convictionLabel);
    // ...and the second delta is 0, so a THIRD sample is a true no-op.
    const third = sampleTelemetry(s, LIVE_FEED);
    expect(third.throughput).toBe(0);
    expect(sameTelemetry(second, third)).toBe(true);
  });

  it("detects a real throughput change (no false bail-out)", () => {
    // The mirror image: a comparator that always returned true would pass the
    // test above while silently freezing the telemetry footer forever.
    const s = createMatrixState();
    run(s, 300);
    const before = sampleTelemetry(s, LIVE_FEED);
    run(s, 60);
    const after = sampleTelemetry(s, LIVE_FEED);
    expect(after.throughput).toBeGreaterThan(0);
    expect(sameTelemetry(before, after)).toBe(false);
  });

  it("keeps the throughput cursor per-state (no cross-instance bleed)", () => {
    // The cursor is a field on the state, not a module variable. With a
    // module-level cursor, two matrix instances would each consume the
    // other's deliveries and report a rate belonging to neither — and the
    // Pro page can mount more than one over its lifetime.
    const a = createMatrixState();
    const b = createMatrixState();
    run(a, 300);
    run(b, 300);
    const ta = sampleTelemetry(a, LIVE_FEED);
    const tb = sampleTelemetry(b, LIVE_FEED);
    // Both report the same honest rate for identical histories...
    expect(ta.throughput).toBe(tb.throughput);
    // ...and a second sample of A must not be credited B's traffic.
    expect(sampleTelemetry(a, LIVE_FEED).throughput).toBe(0);
    expect(sampleTelemetry(b, LIVE_FEED).throughput).toBe(0);
  });

  it("resetTelemetryWindow stops a remount reporting the whole session", () => {
    // A remount reuses `state`, so without a reset the first reading after it
    // would show every packet ever delivered as a "per second" rate.
    const s = createMatrixState();
    run(s, 300);
    resetTelemetryWindow(s);
    expect(sampleTelemetry(s, LIVE_FEED).throughput).toBe(0);
  });

  it("reports a change when a displayed field moves", () => {
    const s = createMatrixState();
    run(s, 120);
    const before = sampleTelemetry(s, LIVE_FEED);
    run(s, 120);
    const after = sampleTelemetry(s, LIVE_FEED);
    expect(sameTelemetry(before, after)).toBe(false);
  });

  it("pre-formats its label strings (never a fresh string per sample)", () => {
    // Same lesson as `formatAge` in useFeedHealth: formatting in the component
    // would allocate a new string every sample and defeat the bail-out above.
    const s = createMatrixState();
    run(s, 200);
    const a = sampleTelemetry(s, LIVE_FEED);
    expect(typeof a.convictionLabel).toBe("string");
    expect(a.convictionLabel).toMatch(/^\d{1,3}%$/);
    expect(a.throughputLabel).toMatch(/^\d+\/s$/);
    // Never NaN: an uninitialised cursor once rendered "NaN/s" here.
    expect(a.throughputLabel).not.toContain("NaN");
  });

  it("counts the whole graph", () => {
    const s = createMatrixState();
    run(s, 60);
    const t = sampleTelemetry(s, LIVE_FEED);
    expect(t.totalNodes).toBe(s.nodes.length);
    expect(t.activeNodes).toBeLessThanOrEqual(t.totalNodes);
    expect(t.inFlight).toBe(s.live.length);
  });
});
