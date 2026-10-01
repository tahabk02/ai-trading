/**
 * NEURAL MATRIX — DOMAIN TYPES
 * ============================================================================
 * Pure type surface for the agent-network runtime. No React, no DOM, no
 * browser globals: this file is importable from the `logic` vitest project
 * (node environment) exactly like every other module in `src/lib`.
 *
 * The whole point of the split is that the SIMULATION is a value-transform —
 * `step(state, input) -> state` — and only the renderer touches the canvas.
 * That is what makes the zero-hop invariant auditable: there is no React in
 * this file tree for a tick to accidentally re-render through.
 */

/** Market channel a node belongs to. Mirrors `AssetSubType` in constants/symbols. */
export type MarketLane = "real" | "otc" | "crypto";

export const MARKET_LANES: readonly MarketLane[] = [
  "real",
  "otc",
  "crypto",
] as const;

/** Structural role in the pipeline — drives radius, colour and collision mass. */
export type NodeRole = "ingest" | "analysis" | "consensus" | "emitter";

/** Directional bias of a consensus packet. Mirrors the engine's BUY/PUT ladder. */
export type MatrixDirection = "BUY" | "SELL" | null;

/** What a packet carries. Changes the glyph, not the physics. */
export type PacketKind = "tick" | "signal" | "metric";

/** A simulated agent node. Positions are NORMALIZED (0..1) in layout space. */
export interface MatrixNode {
  readonly id: string;
  readonly label: string;
  readonly lane: MarketLane;
  readonly role: NodeRole;
  /** Home anchor in normalized layout space — the spring target. */
  readonly ax: number;
  readonly ay: number;
  /** Live position, normalized 0..1. Mutated by the integrator. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Collision radius in normalized units. Heavier roles occupy more space. */
  readonly r: number;
  /**
   * Rolling 0..1 activity, driven by packet arrivals. Decays every step, so a
   * node that stops receiving packets visibly cools instead of latching on.
   */
  load: number;
  /** Deterministic per-node phase for the idle shimmer. Never Math.random(). */
  readonly phase: number;
  /** Monotonic arrival counter — a "packets handled" readout for the inspector. */
  arrivals: number;
}

/** A directed conduit between two agents. */
export interface MatrixEdge {
  readonly from: number;
  readonly to: number;
  readonly lane: MarketLane;
  /** 0..1 — conduit thickness / conduction capacity. */
  readonly weight: number;
}

/**
 * A consensus signal in flight.
 *
 * Pooled: `t` is rewritten in place, the object itself is recycled through a
 * free-list. At 60fps with a few hundred concurrent packets, allocating fresh
 * objects per spawn is the single easiest way to reintroduce GC pauses into an
 * otherwise allocation-free render loop.
 */
export interface MatrixPacket {
  /** Edge index this packet travels along. */
  edge: number;
  /** Progress along the edge, 0..1. */
  t: number;
  /** Progress per second. */
  speed: number;
  readonly lane: MarketLane;
  /**
   * NOT readonly: pool slots are reused, so every field is rewritten on each
   * spawn. Marking these readonly would be a type-level lie about the pool.
   */
  kind: PacketKind;
  direction: MatrixDirection;
  /** 0..1 — drives glow radius and opacity. */
  strength: number;
}

/** Live, read-only view of the terminal that the engine reacts to. */
export interface MatrixFeed {
  /** Active symbol, uppercased. Empty string before the store hydrates. */
  symbol: string;
  /** Lane the active symbol routes through — the highlighted channel. */
  lane: MarketLane;
  /** Live price. 0 when no packet has arrived yet. */
  price: number;
  /** AI target price. 0 when unknown. */
  target: number;
  /** AI anchor price. 0 when unknown. */
  anchor: number;
  /** Realized volatility proxy (ATR). 0 when unknown. */
  atr: number;
  /** Book-agreement confluence, 0..100. 0 when unknown. */
  confluence: number;
  /** Gated direction from the ONE coherent signal view. */
  direction: MatrixDirection;
  /** `true` while the socket is live and the price is fresh. */
  live: boolean;
}

/** Immutable starting configuration for `createMatrixState`. */
export interface MatrixConfig {
  /**
   * Upper bound on concurrent packets. The engine emits at most one packet per
   * arrival and recycles, so this is a hard ceiling on live allocation — it is
   * NOT a target. Sized for the fixed topology below.
   */
  maxPackets: number;
  /** Seed for the deterministic PRNG. Same seed ⇒ same jitter, always. */
  seed: number;
}

/** The complete mutable simulation state. Owned by a ref; never in React. */
export interface MatrixState {
  readonly nodes: MatrixNode[];
  readonly edges: MatrixEdge[];
  readonly packets: MatrixPacket[];
  /** Indices of `packets` currently in use — avoids scanning dead slots. */
  readonly live: number[];
  /** Free packet slots. */
  readonly free: number[];
  /** 0..1 — the emitter's current conviction, smoothed. */
  conviction: number;
  /** Cumulative delivered packets. */
  delivered: number;
  /** Cumulative dropped packets (pool exhausted). */
  dropped: number;
  /** Rolling tick-pressure accumulator, decayed each step. */
  pressure: number;
  /** Seconds of simulated time elapsed. Drives the idle wander phase. */
  time: number;
  /**
   * `delivered` as of the LAST telemetry sample, so throughput can be reported
   * as a per-sample delta.
   *
   * Deliberately a field on the state rather than a module-level cursor: the
   * Pro page can mount more than one matrix over its lifetime, and a shared
   * cursor would make each instance consume the other's deliveries.
   */
  telemetryCursor: number;
  /** Deterministic PRNG cursor. */
  rng: number;
}

/**
 * ONE published, change-gated telemetry snapshot.
 *
 * This is the ONLY object that crosses from the simulation into React, and it
 * is republished at most 1×/second AND only when a displayed field actually
 * changed. Everything the operator reads in DOM chrome comes from here; the
 * canvas reads `MatrixState` directly and bypasses React entirely.
 *
 * `sameTelemetry` below is the bail-out that makes a steady feed cost zero
 * renders — the same trick `useFeedHealth` uses for the freshness readout.
 */
export interface MatrixTelemetry {
  /** Delivered packets in the last sample window. */
  readonly throughput: number;
  /** Nodes with load above the "active" threshold. */
  readonly activeNodes: number;
  /** Total node count. */
  readonly totalNodes: number;
  /** Live packet count right now. */
  readonly inFlight: number;
  /** Smoothed emitter conviction, 0..1. */
  readonly conviction: number;
  /** Pre-formatted conviction percentage — stable string for DOM text. */
  readonly convictionLabel: string;
  /** `true` while the feed is live AND the simulation has motion. */
  readonly live: boolean;
  /** Cumulative delivered packets for the session. */
  readonly totalDelivered: number;
  /** Pre-formatted throughput, e.g. "18/s". */
  readonly throughputLabel: string;
}
