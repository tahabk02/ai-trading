/**
 * NEURAL MATRIX — DETERMINISTIC SIMULATION RUNTIME
 * ============================================================================
 * A fixed-topology agent network: three market channels (REAL / OTC / CRYPTO)
 * each run a small pipeline of ingest → analysis agents that converge on a
 * per-lane consensus node, and all three consensus nodes feed a single emitter
 * that publishes the fused verdict.
 *
 * WHY THIS LIVES OUTSIDE REACT
 * ----------------------------
 * The simulation is a pure value-transform. `step(state, feed, dtMs)` mutates a
 * plain object and returns nothing. There is no `useState`, no store write, and
 * no React import anywhere in this file, which is precisely what makes
 * INVARIANT 1 (zero-hop tick path) structurally enforceable rather than a
 * promise: a per-tick React render is not merely avoided, it is *impossible*
 * from here, because there is no React here to render through.
 *
 * The renderer reads this state directly inside a `requestAnimationFrame`
 * callback and paints it. The telemetry sampler publishes at most one small,
 * change-gated object per second to React for the DOM chrome.
 *
 * DETERMINISM
 * -----------
 * Every pseudo-random quantity comes from an integer LCG seeded once, so the
 * same seed always produces the same layout and the same idle shimmer. That
 * makes the engine testable with exact assertions and means two clients with
 * the same config see the same topology. `Math.random()` appears nowhere.
 *
 * COST BOUND (why O(n²) repulsion is fine here)
 * --------------------------------------------
 * The topology is FIXED at 19 nodes. Full pairwise separation is 171 distance
 * checks per step — well under a tenth of a millisecond, and it buys exact,
 * artefact-free node separation. A spatial hash would cost more in bookkeeping
 * than it saves at this node count. Revisit only if the topology ever becomes
 * data-driven; the comment marks the boundary deliberately.
 */

import type {
  MarketLane,
  MatrixConfig,
  MatrixDirection,
  MatrixEdge,
  MatrixFeed,
  MatrixNode,
  MatrixPacket,
  MatrixState,
  MatrixTelemetry,
  NodeRole,
  PacketKind,
} from "./types";
import { MARKET_LANES } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC PRNG (mulberry32) — integer cursor, no global state
// ═══════════════════════════════════════════════════════════════════════════

/** Advance a uint32 LCG and return a float in [0, 1). */
function random(state: MatrixState): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform float in [lo, hi). */
function range(state: MatrixState, lo: number, hi: number): number {
  return lo + random(state) * (hi - lo);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHYSICS CONSTANTS
//
// Units are NORMALIZED layout space (0..1 of the canvas box), so the whole
// simulation is resolution-independent: a 900px canvas and a 400px canvas run
// the identical force solve. Only the final projection multiplies by width.
// ═══════════════════════════════════════════════════════════════════════════

/** Pull toward the node's home anchor. Higher = tighter to the grid. */
const SPRING_K = 5.5;
/** Velocity retained per second. ~0.86 ⇒ critically-ish damped, no ringing. */
const DAMPING = 0.86;
/** Idle drift amplitude — keeps the graph alive without looking random. */
const WANDER = 0.012;
/** Strength of the pairwise separation impulse. */
const REPULSION = 0.9;
/** Extra gap enforced between two node surfaces, in normalized units. */
const COLLISION_PAD = 0.006;
/** Load decay per second — a cooling node visibly relaxes. */
const LOAD_DECAY = 0.55;
/** Max packets emitted per single step, regardless of feed pressure. */
const MAX_SPAWN_PER_STEP = 3;
/** Conviction rise per second toward a live verdict — earned deliberately. */
const CONVICTION_RISE = 0.55;
/** Conviction fall per second — lost quickly, so a stale verdict never lingers. */
const CONVICTION_FALL = 2.2;
/**
 * Soft ceiling on CONCURRENT packets in flight.
 *
 * Emission is metered by `state.pressure`, not by pool capacity. If the ceiling
 * sat at `maxPackets`, the pool would be the binding constraint and `spawnPacket`
 * would start dropping — turning a visual tuning parameter into a silent,
 * non-deterministic throughput cap. Keeping a wide margin means pressure alone
 * decides the traffic density, and `free` never runs dry in normal operation.
 *
 * Sized from the design: `MAX_SPAWN_PER_STEP` emissions per frame, each taking
 * ~1/speed seconds to traverse an edge, are the inflow; the bound only has to
 * exceed the steady-state count, not the peak.
 */
const MAX_IN_FLIGHT = 120;
/** Nodes at or above this load count as "active" in telemetry. */
const ACTIVE_LOAD_THRESHOLD = 0.12;

/** Collision radius per role, normalized. Emitters are visually and physically heavier. */
const ROLE_RADIUS: Record<NodeRole, number> = {
  ingest: 0.022,
  analysis: 0.017,
  consensus: 0.027,
  emitter: 0.036,
};

// ═══════════════════════════════════════════════════════════════════════════
// TOPOLOGY
// ═══════════════════════════════════════════════════════════════════════════

/** Per-lane node blueprint. Kept declarative so the graph is auditable at a glance. */
interface LaneBlueprint {
  lane: MarketLane;
  /** Human label rendered next to the lane band. */
  title: string;
  /** Short ticker badge. */
  badge: string;
  /** Analysis-agent names — the per-lane feature extractors. */
  analysts: readonly string[];
  /** Ingest-agent name. */
  ingest: string;
  /** Consensus-agent name. */
  consensus: string;
}

const LANE_BLUEPRINTS: readonly LaneBlueprint[] = [
  {
    lane: "real",
    title: "REAL MARKET",
    badge: "FX",
    ingest: "FX-LIQ",
    analysts: ["MOMENTUM", "VOL-SURF", "DEPTH", "CARRY"],
    consensus: "FX-CONS",
  },
  {
    lane: "otc",
    title: "OTC SYNTHETIC",
    badge: "OTC",
    ingest: "OTC-AGG",
    analysts: ["DRIFT", "QUANT-MOM", "SPREAD-Q", "HEDGE"],
    consensus: "OTC-CONS",
  },
  {
    lane: "crypto",
    title: "CRYPTO 24/7",
    badge: "CRY",
    ingest: "CRY-FEED",
    analysts: ["FLOW-IMB", "FUNDING", "VOL-CLUST", "ON-CHAIN"],
    consensus: "CRY-CONS",
  },
] as const;

/** Column x-anchors: ingest | analysts | consensus | emitter. */
const COL_INGEST = 0.12;
const COL_ANALYST = 0.36;
const COL_CONSENSUS = 0.63;
const COL_EMITTER = 0.87;

function makeNode(
  id: string,
  label: string,
  lane: MarketLane,
  role: NodeRole,
  ax: number,
  ay: number,
  phase: number,
): MatrixNode {
  return {
    id,
    label,
    lane,
    role,
    ax,
    ay,
    // Start exactly on the anchor: the first frame is already a clean grid,
    // so there is no "nodes fly in from a point" transition on mount.
    x: ax,
    y: ay,
    vx: 0,
    vy: 0,
    r: ROLE_RADIUS[role],
    load: 0,
    phase,
    arrivals: 0,
  };
}

/**
 * Build the immutable node + edge topology.
 *
 * Edges are: ingest → each analyst → lane consensus → emitter. Every analyst
 * fans into the consensus, so the emitter's colour is genuinely a blend of all
 * twelve analysis agents rather than a hardcoded hue.
 */
export function buildTopology(): {
  nodes: MatrixNode[];
  edges: MatrixEdge[];
} {
  const nodes: MatrixNode[] = [];
  const edges: MatrixEdge[] = [];
  let phase = 0;

  const push = (n: MatrixNode): number => {
    nodes.push(n);
    return nodes.length - 1;
  };

  for (let li = 0; li < LANE_BLUEPRINTS.length; li += 1) {
    const bp = LANE_BLUEPRINTS[li];
    // Lanes are stacked vertically and centred, leaving the emitter row clear.
    const centreY = 0.24 + li * 0.26;

    const ingestIdx = push(
      makeNode(
        `${bp.lane}-ingest`,
        bp.ingest,
        bp.lane,
        "ingest",
        COL_INGEST,
        centreY,
        (phase += 0.7),
      ),
    );

    const analystIdxs = bp.analysts.map((name, i) => {
      // Fan the analysts vertically around the lane centre so edges read as a
      // bus rather than a single overlapping line.
      const span = 0.17;
      const ay =
        centreY + (bp.analysts.length === 1 ? 0 : (i / (bp.analysts.length - 1) - 0.5) * span);
      return push(
        makeNode(
          `${bp.lane}-${name.toLowerCase()}`,
          name,
          bp.lane,
          "analysis",
          COL_ANALYST,
          ay,
          (phase += 0.7),
        ),
      );
    });

    const consIdx = push(
      makeNode(
        `${bp.lane}-consensus`,
        bp.consensus,
        bp.lane,
        "consensus",
        COL_CONSENSUS,
        centreY,
        (phase += 0.7),
      ),
    );

    for (const a of analystIdxs) {
      edges.push({ from: ingestIdx, to: a, lane: bp.lane, weight: 0.75 });
    }
    for (const a of analystIdxs) {
      edges.push({ from: a, to: consIdx, lane: bp.lane, weight: 0.9 });
    }
  }

  // ── EMITTER — the single fused-output node, fed by all three lane consensus.
  const emitIdx = push(
    makeNode("emitter-verdict", "VERDICT", "real", "emitter", COL_EMITTER, 0.5, 0.35),
  );
  for (const bp of LANE_BLUEPRINTS) {
    const consIdx = nodes.findIndex(
      (n) => n.id === `${bp.lane}-consensus`,
    );
    if (consIdx >= 0) {
      // `lane` is the CONSENSUS node's lane, not the emitter's: the edge colour
      // must identify which market channel this contribution came from.
      edges.push({ from: consIdx, to: emitIdx, lane: bp.lane, weight: 1 });
    }
  }

  return { nodes, edges };
}

/** Lane metadata for the renderer's left-hand rail. */
export const LANE_META = LANE_BLUEPRINTS.map((bp, i) => ({
  lane: bp.lane,
  title: bp.title,
  badge: bp.badge,
  /** Band centre in normalized space — the renderer draws the label here. */
  y: 0.24 + i * 0.26,
}));

export const EMITTER_POSITION = { x: COL_EMITTER, y: 0.5 } as const;

// ═══════════════════════════════════════════════════════════════════════════
// STATE CONSTRUCTION
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_CONFIG: MatrixConfig = { maxPackets: 220, seed: 0x9e3779b9 };

/**
 * Allocate the simulation. Called ONCE per mount, from an effect.
 *
 * The packet pool is pre-allocated to `maxPackets` and every slot is parked in
 * the free list, so the steady state performs ZERO allocations — which is what
 * keeps the render loop free of GC hitches at 60fps.
 */
export function createMatrixState(config: MatrixConfig = DEFAULT_CONFIG): MatrixState {
  const { nodes, edges } = buildTopology();

  const packets: MatrixPacket[] = new Array(config.maxPackets);
  const free: number[] = new Array(config.maxPackets);
  for (let i = 0; i < config.maxPackets; i += 1) {
    packets[i] = {
      edge: 0,
      t: 0,
      speed: 0.5,
      lane: "real",
      kind: "tick",
      direction: null,
      strength: 0.5,
    };
    // Reverse order so the first spawned packets are the lowest indices.
    free[i] = config.maxPackets - 1 - i;
  }

  return {
    nodes,
    edges,
    packets,
    live: [],
    free,
    conviction: 0,
    delivered: 0,
    dropped: 0,
    pressure: 0,
    time: 0,
    // The throughput cursor starts AT zero rather than undefined: an
    // uninitialised field here would make the first sample read
    // `0 - undefined` ⇒ NaN, and the UI would render "NaN/s".
    telemetryCursor: 0,
    rng: config.seed >>> 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PACKET LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

function spawnPacket(
  state: MatrixState,
  edgeIndex: number,
  kind: PacketKind,
  direction: MatrixDirection,
  strength: number,
): void {
  const slot = state.free.pop();
  if (slot === undefined) {
    // Pool exhausted. Counting the drop is more honest than growing the pool
    // unboundedly under a tick storm — and it surfaces in telemetry.
    state.dropped += 1;
    return;
  }
  const p = state.packets[slot];
  p.edge = edgeIndex;
  p.t = 0;
  p.speed = 0.35 + random(state) * 0.55;
  p.kind = kind;
  p.direction = direction;
  p.strength = strength;
  state.live.push(slot);
}

function releasePacket(state: MatrixState, liveIndex: number): void {
  const slot = state.live[liveIndex];
  // Swap-remove: O(1) and order-independent, which is all the physics needs.
  const last = state.live.length - 1;
  state.live[liveIndex] = state.live[last];
  state.live.pop();
  state.free.push(slot);
}

/** Reused scratch buffer for edge selection — the hot path allocates nothing. */
const EDGE_SCRATCH: number[] = [];

/**
 * Pick an outgoing edge from a node, biased toward the active lane.
 *
 * Candidates are collected into a scratch array rather than indexed
 * arithmetically: outgoing edges are NOT contiguous in the edge list (analyst
 * edges interleave with consensus edges), so `first + k` would walk off the
 * node's own fan and pick a stranger's conduit. 19 nodes means the scratch
 * array never exceeds 5 entries.
 */
function pickOutgoingEdge(
  state: MatrixState,
  nodeIndex: number,
  lane: MarketLane | null,
): number {
  const candidates = EDGE_SCRATCH;
  candidates.length = 0;
  let laneHit = -1;

  for (let i = 0; i < state.edges.length; i += 1) {
    const e = state.edges[i];
    if (e.from !== nodeIndex) continue;
    candidates.push(i);
    if (lane && e.lane === lane && laneHit < 0) laneHit = i;
  }
  if (candidates.length === 0) return -1;

  // 60% bias to the active channel so the operator's market is visibly the
  // busiest lane — without ever mutating the fixed topology.
  if (laneHit >= 0 && random(state) < 0.6) return laneHit;
  return candidates[Math.floor(random(state) * candidates.length)];
}

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION STEP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Advance the simulation by `dtMs`.
 *
 * Called from the render loop ONLY — never from a tick handler, never from
 * React. `dtMs` is clamped so a backgrounded tab that resumes after 30s does
 * not integrate a 30-second step and explode every node off-canvas.
 */
export function step(state: MatrixState, feed: MatrixFeed, dtMs: number): void {
  // Clamp to 50ms: at most ~3 frames of catch-up. Anything longer is a tab
  // that was hidden, and replaying it is both wrong and expensive.
  const dt = Math.min(Math.max(dtMs, 0), 50) / 1000;
  if (dt <= 0) return;

  const { nodes, edges } = state;

  // ── 1. FORCES ───────────────────────────────────────────────────────────
  // Home spring. The idle wander is layered on in step 2.
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    n.vx += (n.ax - n.x) * SPRING_K * dt;
    n.vy += (n.ay - n.y) * SPRING_K * dt;
  }

  // ── 2. IDLE WANDER ─────────────────────────────────────────────────────
  // Applied after the spring so it perturbs position rather than fighting it.
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    const w = WANDER * dt;
    n.vx += Math.sin(state.time * 0.6 + n.phase) * w;
    n.vy += Math.cos(state.time * 0.47 + n.phase * 1.3) * w;
  }

  // ── 3. PAIRWISE SEPARATION (collision) ─────────────────────────────────
  // 19 nodes ⇒ 171 pairs. Exact separation beats a spatial hash at this size.
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      const min = a.r + b.r + COLLISION_PAD;
      if (d2 >= min * min) continue;
      // Coincident nodes have no direction; nudge deterministically by index
      // parity so they still separate instead of sticking forever.
      if (d2 < 1e-9) {
        dx = (i + j) % 2 === 0 ? 1 : -1;
        dy = 0;
        d2 = 1;
      }
      const d = Math.sqrt(d2);
      const overlap = (min - d) / d;
      const fx = dx * overlap * REPULSION * 0.5;
      const fy = dy * overlap * REPULSION * 0.5;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  // ── 4. INTEGRATE + DAMP ─────────────────────────────────────────────────
  const damp = Math.pow(DAMPING, dt * 60);
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    n.vx *= damp;
    n.vy *= damp;
    n.x += n.vx * dt;
    n.y += n.vy * dt;
    // Load decay — a node that stops receiving packets visibly cools.
    n.load = Math.max(0, n.load - LOAD_DECAY * dt);
  }

  // ── 5. FEED PRESSURE → EMISSION ─────────────────────────────────────────
  // A live feed with a real target/anchor pair is under load. Pressure rises
  // toward 1 while live and decays to 0 otherwise, so a disconnected tape
  // drains the graph instead of freezing it in a lit state.
  const wantsTraffic = feed.live && feed.price > 0;
  state.pressure = wantsTraffic
    ? Math.min(1, state.pressure + 0.5 * dt)
    : Math.max(0, state.pressure - 0.35 * dt);

  if (state.pressure > 0.02) {
    // Admission control: stop emitting at the in-flight ceiling so the budget
    // below always has real slots to draw on.
    const room = MAX_IN_FLIGHT - state.live.length;
    if (room > 0) {
      const budget = Math.min(
        MAX_SPAWN_PER_STEP,
        room,
        Math.floor(state.pressure * MAX_SPAWN_PER_STEP + random(state)),
      );
      for (let s = 0; s < budget; s += 1) {
        // Kind mix: mostly raw ticks, occasionally a signal or a metric hop.
        // Weights are fixed, not derived from the feed, so the mix is stable.
        const roll = random(state);
        const kind: PacketKind =
          roll < 0.62 ? "tick" : roll < 0.88 ? "signal" : "metric";
        const strength = 0.35 + state.pressure * 0.65;
        // 55% of emissions start at an ingest node; the rest hop mid-pipeline.
        let startNode = -1;
        if (random(state) < 0.55) {
          for (let i = 0; i < nodes.length; i += 1) {
            if (nodes[i].role === "ingest") {
              const match = feed.lane ? nodes[i].lane === feed.lane : true;
              if (match || random(state) < 0.3) {
                startNode = i;
                break;
              }
            }
          }
        } else {
          startNode = Math.floor(random(state) * nodes.length);
        }
        if (startNode < 0) continue;
        const edgeIndex = pickOutgoingEdge(state, startNode, feed.lane);
        if (edgeIndex < 0) continue;
        spawnPacket(state, edgeIndex, kind, feed.direction, strength);
      }
    }
  }

  // ── 6. PACKET ADVANCE ───────────────────────────────────────────────────
  // Iterate BACKWARD: `releasePacket` swap-removes, which would otherwise
  // skip the element that slides into the current index.
  for (let i = state.live.length - 1; i >= 0; i -= 1) {
    const slot = state.live[i];
    const p = state.packets[slot];
    p.t += p.speed * dt;
    if (p.t < 1) continue;

    // Arrived: credit the destination node and forward the signal onward.
    const edge = edges[p.edge];
    const dest = nodes[edge.to];
    dest.load = Math.min(1, dest.load + 0.35 * p.strength);
    dest.arrivals += 1;
    state.delivered += 1;

    // Consume one third of the arriving energy so the pipeline visibly
    // attenuates from ingest to verdict rather than glowing flat.
    if (dest.role !== "emitter") {
      const next = pickOutgoingEdge(state, edge.to, feed.lane);
      if (next >= 0) {
        spawnPacket(
          state,
          next,
          p.kind,
          p.direction,
          p.strength * 0.82,
        );
      }
    } else {
      // Deliberately EMPTY of conviction credit.
      //
      // An earlier version nudged conviction toward each arriving packet's
      // `strength`. That was wrong twice over: it let raw traffic drive the
      // verdict node's colour, and because packet strength is ~0.35-1.0 it
      // fought the confluence ceiling, pinning conviction near 45% even for a
      // 25%-confidence call. Conviction now has exactly ONE owner — step 7,
      // driven by the gated signal — which makes it reproducible, testable, and
      // impossible to inflate by a busy tape.
    }
    releasePacket(state, i);
  }

  // ── 7. CONVICTION TRACKS THE REAL GATED SIGNAL ─────────────────────────
  // The single source of conviction. Smoothing is time-based (not per packet)
  // so the response is identical at 30fps and 144fps, and so one stray
  // emission cannot swing the emitter's colour.
  //
  // A live verdict pulls toward `feed.confluence` rather than a flat 1: the
  // backend's own confidence is the most honest ceiling available, and it
  // makes the emitter's brightness mean "how sure is the model" instead of
  // "is there a signal at all". A null direction bleeds to zero, which is the
  // honest rendering of "no verdict".
  const target =
    feed.direction === "BUY" || feed.direction === "SELL"
      ? Math.min(1, Math.max(0, feed.confluence / 100))
      : 0;
  // Rising is deliberately slower than falling: conviction should be hard to
  // earn and quick to lose.
  const rate = target > state.conviction ? CONVICTION_RISE : CONVICTION_FALL;
  state.conviction += (target - state.conviction) * rate * dt;
  state.conviction = Math.min(1, Math.max(0, state.conviction));
  // Exponential decay asymptotes to 0 and never quite reaches it, which would
  // leave a drained graph reporting conviction of 2.8e-20 forever. Below one
  // rendered percent, snap to a true zero: with no verdict, "no conviction" is
  // the honest state and must be exactly zero, not a denormal near it.
  if (state.conviction < 0.005) state.conviction = 0;

  // Clamp positions defensively. Separation can nudge a node past the box on
  // a very narrow viewport; a clamp is cheaper than a NaN sweep every frame.
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (n.x < 0.02 || n.x > 0.98) n.vx *= -0.5;
    if (n.y < 0.02 || n.y > 0.98) n.vy *= -0.5;
    n.x = Math.min(0.99, Math.max(0.01, n.x));
    n.y = Math.min(0.99, Math.max(0.01, n.y));
  }

  state.time += dt;
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEMETRY — the ONLY surface that crosses into React
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reference-equality bail-out.
 *
 * This is the single most important function in the file for INVARIANT 1. A
 * fresh object every sample would re-render every subscriber once per second
 * forever; comparing each DISPLAYED field first means a steady feed produces
 * literally zero renders. Mirrors `sameSnapshot` in `useFeedHealth`.
 */
export function sameTelemetry(a: MatrixTelemetry, b: MatrixTelemetry): boolean {
  return (
    a.throughput === b.throughput &&
    a.activeNodes === b.activeNodes &&
    a.totalNodes === b.totalNodes &&
    a.inFlight === b.inFlight &&
    a.throughputLabel === b.throughputLabel &&
    a.convictionLabel === b.convictionLabel &&
    a.live === b.live &&
    a.totalDelivered === b.totalDelivered
  );
}

/**
 * Build the snapshot the DOM chrome renders.
 *
 * `convictionLabel` and `throughputLabel` are PRE-FORMATTED here, not in the
 * component. Formatting in the component would produce a new string per sample
 * even when the meaning is unchanged ("18/s" vs "18/s"), which defeats the
 * reference bail-out in `sameTelemetry`. This is the same lesson the feed
 * health readout encodes with `displayAge`.
 */
export function sampleTelemetry(
  state: MatrixState,
  feed: MatrixFeed,
): MatrixTelemetry {
  let activeNodes = 0;
  for (let i = 0; i < state.nodes.length; i += 1) {
    if (state.nodes[i].load >= ACTIVE_LOAD_THRESHOLD) activeNodes += 1;
  }
  // Throughput is a delta against the PREVIOUS SAMPLE of the same state, so
  // the cursor is a field on the state rather than a module-level variable.
  // Module scope would be wrong twice over: two matrix instances (or two
  // concurrent tests) would each consume the other's deliveries and report a
  // rate that belongs to neither.
  const delivered = state.delivered;
  const throughput = Math.max(0, delivered - state.telemetryCursor);
  state.telemetryCursor = delivered;

  const convictionPct = Math.round(state.conviction * 100);
  return {
    throughput,
    activeNodes,
    totalNodes: state.nodes.length,
    inFlight: state.live.length,
    conviction: state.conviction,
    // NOT zero-padded. "0%" reads as a real reading; "00%" reads as a clock.
    // The pre-mount placeholder uses the same shape so the first sample does
    // not visibly reflow.
    convictionLabel: `${convictionPct}%`,
    live: feed.live && state.live.length > 0,
    totalDelivered: delivered,
    throughputLabel: `${throughput}/s`,
  };
}

/**
 * Reset the throughput cursor so the next sample reports a full window rather
 * than the whole lifetime of the state. Called on mount: a remount keeps the
 * same `state`, and without this the first reading after a remount would
 * briefly show the entire session's packet count as a "per second" rate.
 */
export function resetTelemetryWindow(state: MatrixState): void {
  state.telemetryCursor = state.delivered;
}

export { MARKET_LANES };
export type {
  MarketLane,
  MatrixConfig,
  MatrixDirection,
  MatrixEdge,
  MatrixFeed,
  MatrixNode,
  MatrixPacket,
  MatrixState,
  MatrixTelemetry,
  NodeRole,
  PacketKind,
};
