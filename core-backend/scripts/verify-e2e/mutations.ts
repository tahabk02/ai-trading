/**
 * verify-e2e/mutations.ts — PART 47 [525] fault-injection proof.
 *
 * Each mutation injects exactly ONE defect into a copy of the context and the
 * battery is re-run. The targeted check MUST emit an explicit FAIL; if it does
 * not, the harness reports the mutation as NOT CAUGHT, which fails the run.
 * This is what makes the green result meaningful rather than a rubber stamp.
 */

import type { Bar, E2EContext, MutationResult, SettlementRecord } from "./types";
import { runChecks } from "./checks";
import { floorBucket } from "./oracle";

function clone(ctx: E2EContext): E2EContext {
  return structuredClone(ctx);
}

/** Fixed skew used by M7 to simulate a wall-clock (Date.now) slot anchor. */
const WALL_CLOCK_SKEW_MS = 30 * 86_400_000;

function midIndex(len: number): number {
  return Math.max(0, Math.floor(len / 2));
}

export interface Mutation {
  id: string;
  name: string;
  /** The check id this mutation is designed to break. */
  targets: string;
  apply: (ctx: E2EContext) => E2EContext;
}

export const MUTATIONS: Mutation[] = [
  {
    id: "M1",
    name: "Perturb one closed S5 close by +0.0001",
    targets: "C1",
    apply: (ctx) => {
      const c = clone(ctx);
      const sym = ctx.fixtures[0].symbol;
      const bars = c.server.get(sym)?.get("S5");
      if (bars && bars.length) bars[midIndex(bars.length)].close += 0.0001;
      return c;
    },
  },
  {
    id: "M2",
    name: "Set an M1 high below its close (OHLC violation)",
    targets: "C2",
    apply: (ctx) => {
      const c = clone(ctx);
      const sym = ctx.fixtures[0].symbol;
      const bars = c.server.get(sym)?.get("M1");
      if (bars && bars.length > 5) bars[5].high = bars[5].close - 1;
      return c;
    },
  },
  {
    id: "M3",
    name: "Duplicate one S5 slot (breaks monotonic/unique)",
    targets: "C3",
    apply: (ctx) => {
      const c = clone(ctx);
      const sym = ctx.fixtures[0].symbol;
      const bars = c.server.get(sym)?.get("S5");
      if (bars && bars.length > 21) {
        const dup: Bar = { ...bars[20] };
        bars.splice(21, 0, dup);
      }
      return c;
    },
  },
  {
    id: "M4",
    name: "Roll M1->M5 using MEAN high instead of max high",
    targets: "C4",
    apply: (ctx) => {
      const c = clone(ctx);
      const sym = ctx.fixtures[0].symbol;
      const m1 = c.server.get(sym)?.get("M1") ?? [];
      const m5 = c.server.get(sym)?.get("M5") ?? [];
      const groups = new Map<number, Bar[]>();
      for (const b of m1) {
        const g = floorBucket(b.timestamp, 300_000);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(b);
      }
      for (const bar of m5) {
        const g = groups.get(bar.timestamp);
        if (g && g.length) {
          bar.high = g.reduce((s, x) => s + x.high, 0) / g.length;
          bar.low = g.reduce((s, x) => s + x.low, 0) / g.length;
        }
      }
      return c;
    },
  },
  {
    id: "M5",
    name: "Inject a proxy-sourced tick into an OTC book",
    targets: "C5",
    apply: (ctx) => {
      const c = clone(ctx);
      const f = c.fixtures.find((x) => x.assetClass === "otc");
      if (f) {
        f.ticks.push({
          tsMs: ctx.brokerNowMs - 1_000,
          price: f.ticks[f.ticks.length - 1]?.price ?? 1,
          volume: 0,
          source: "github_repo_cached",
        });
      }
      return c;
    },
  },
  {
    id: "M6",
    name: "Shift the product expiry slot by one timeframe (off-by-one)",
    targets: "C6",
    apply: (ctx) => {
      const c = clone(ctx);
      if (c.product.expirySlots.length) {
        c.product.expirySlots[0].slotSec += c.product.expirySlots[0].tfSec;
      }
      return c;
    },
  },
  {
    id: "M7",
    name: "Anchor slots to wall clock (Date.now) instead of broker clock",
    targets: "C7",
    apply: (ctx) => {
      const c = clone(ctx);
      // Deterministic stand-in for the process wall clock being ~30 days ahead
      // of the fixture's broker clock — the exact defect a Date.now() anchor
      // produces. A fixed skew keeps the report reproducible run to run.
      c.brokerNowMs = ctx.brokerNowMs + WALL_CLOCK_SKEW_MS;
      return c;
    },
  },
  {
    id: "M8",
    name: "Insert a gap in a product target ladder",
    targets: "C8",
    apply: (ctx) => {
      const c = clone(ctx);
      const l = c.product.targetLadders.find((x) => x.slots.length > 2);
      if (l) l.slots[1] += l.tfSec;
      return c;
    },
  },
  {
    id: "M9",
    name: "Shift a TIMER entry bucket (expiry != entry + duration)",
    targets: "C9",
    apply: (ctx) => {
      const c = clone(ctx);
      if (c.product.timerExpiries.length) {
        c.product.timerExpiries[0].entrySec -= c.product.timerExpiries[0].durationSec;
      }
      return c;
    },
  },
  {
    id: "M10",
    name: "Drift the last closed chart close away from the tick stream",
    targets: "C10",
    apply: (ctx) => {
      const c = clone(ctx);
      const sym = ctx.fixtures[0].symbol;
      const bars = c.server.get(sym)?.get("S5");
      if (bars && bars.length) bars[bars.length - 1].close += 0.0002;
      return c;
    },
  },
  {
    id: "M11",
    name: "Drop the post-expiry settlement record",
    targets: "C11",
    apply: (ctx) => {
      const c = clone(ctx);
      const sym = ctx.fixtures[0].symbol;
      const m1 = c.server.get(sym)?.get("M1") ?? [];
      if (m1.length) {
        const expiryBucketSec = Math.floor(m1[m1.length - 1].timestamp / 1000);
        c.settlements = c.settlements.filter(
          (s: SettlementRecord) =>
            !(s.symbol === sym && s.expiryBucketSec === expiryBucketSec),
        );
      }
      return c;
    },
  },
];

export function runMutations(ctx: E2EContext): MutationResult[] {
  return MUTATIONS.map((m) => {
    const mutated = m.apply(clone(ctx));
    const results = runChecks(mutated);
    const target = results.find((r) => r.id === m.targets);
    if (!target) {
      return {
        id: m.id,
        name: m.name,
        targets: m.targets,
        caught: false,
        message: `target check ${m.targets} produced no result`,
      };
    }
    if (target.status !== "FAIL") {
      return {
        id: m.id,
        name: m.name,
        targets: m.targets,
        caught: false,
        message: `NOT CAUGHT: ${m.targets} returned ${target.status}`,
      };
    }
    return {
      id: m.id,
      name: m.name,
      targets: m.targets,
      caught: true,
      message: target.message,
    };
  });
}
