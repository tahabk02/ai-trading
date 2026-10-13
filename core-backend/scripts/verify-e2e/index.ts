/**
 * verify-e2e/index.ts — PART 47 [525] offline end-to-end verification runner.
 *
 * Runs with NO network, NO database, NO browser and NO live PO session:
 *   1. load (or generate) deterministic >= 30 min replay fixtures,
 *   2. replay them through the REAL server aggregator,
 *   3. replay the SAME ticks through an INDEPENDENT oracle,
 *   4. compute product slot/timer values with the REAL shipped helpers,
 *   5. run the invariant battery (C1..C11),
 *   6. inject 11 defects and require each to produce an explicit FAIL,
 *   7. write docs/verification/E2E-REPORT-<sha>.md (+ .json).
 *
 * Exit code is 1 when the verdict is not OK.
 */

import { execSync } from "child_process";

import {
  RealtimeCandleAggregatorService,
  SERVER_CANDLE_TFS,
} from "../../src/services/realtimeCandleAggregator.service";
import {
  expiryMarkerBucketSec,
  targetIntervalsFor,
  targetSlots,
} from "../../../client-app/src/lib/realtimeCandleAggregator";

import { loadFixtures } from "./fixtures";
import { floorBucket, oracleAggregate } from "./oracle";
import { runChecks, fixtureSummary } from "./checks";
import { runMutations } from "./mutations";
import { buildSummary, writeReports } from "./report";
import type { Bar, E2EContext, Fixture, SettlementRecord } from "./types";

/** Mirrors the server's TF_MS grid (the server does not export the map). */
const TF_MS: Record<string, number> = {
  S5: 5_000,
  S10: 10_000,
  S15: 15_000,
  S30: 30_000,
  M1: 60_000,
  M2: 120_000,
  M3: 180_000,
  M5: 300_000,
  M10: 600_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
  W1: 604_800_000,
  MN1: 2_592_000_000,
};

const ANCHOR_TFS_SEC = [5, 10, 15, 30, 60];
const LADDER_EXPIRY_SEC = [60, 120, 300, 600];

function git(cmd: string, fallback: string): string {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return fallback;
  }
}

function toBar(c: {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}): Bar {
  return {
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}

/** Build the product-side slot/timer surface using the REAL shipped helpers. */
function buildProductSurface(brokerNowMs: number): E2EContext["product"] {
  const nowSec = Math.floor(brokerNowMs / 1000);
  const expirySlots: E2EContext["product"]["expirySlots"] = [];
  const targetLadders: E2EContext["product"]["targetLadders"] = [];

  for (const tfSec of ANCHOR_TFS_SEC) {
    const tip = floorBucket(nowSec, tfSec);
    for (const exp of LADDER_EXPIRY_SEC) {
      expirySlots.push({ tfSec, expirationSec: exp, slotSec: expiryMarkerBucketSec(tip, exp, tfSec) });
      const slots = targetSlots(tip, tfSec, targetIntervalsFor(exp, tfSec)).map((s) => s.timeSec);
      targetLadders.push({ tfSec, expirationSec: exp, slots });
    }
  }

  const entrySec = floorBucket(nowSec, 60) - 60;
  const timerExpiries = LADDER_EXPIRY_SEC.map((dur) => ({
    entrySec,
    durationSec: dur,
    expirySec: expiryMarkerBucketSec(entrySec, dur, 60),
  }));

  return { expirySlots, targetLadders, timerExpiries };
}

function buildSettlements(
  fixtures: Fixture[],
  server: Map<string, Map<string, Bar[]>>,
): SettlementRecord[] {
  const out: SettlementRecord[] = [];
  for (const f of fixtures) {
    const m1 = server.get(f.symbol)?.get("M1") ?? [];
    if (m1.length < 2) continue;
    const entryBar = m1[m1.length - 2];
    const expiryBar = m1[m1.length - 1];
    out.push({
      symbol: f.symbol,
      direction: "BUY",
      entryBucketSec: Math.floor(entryBar.timestamp / 1000),
      expiryBucketSec: Math.floor(expiryBar.timestamp / 1000),
      entry: entryBar.close,
      exitPrice: expiryBar.close,
      outcome: expiryBar.close >= entryBar.close ? "WIN" : "LOSS",
    });
  }
  return out;
}

function main(): void {
  const sha = git("git rev-parse HEAD", "unknown");
  const branch = git("git rev-parse --abbrev-ref HEAD", "unknown");

  const { fixtures, source } = loadFixtures();

  const agg = RealtimeCandleAggregatorService.getInstance();
  agg.destroy();

  const server = new Map<string, Map<string, Bar[]>>();
  const oracle = new Map<string, Map<string, Bar[]>>();

  for (const f of fixtures) {
    for (const t of f.ticks) {
      agg.addTick(f.symbol, t.price, t.tsMs, t.volume ?? 0);
    }
    const byTf = new Map<string, Bar[]>();
    const byTfOracle = new Map<string, Bar[]>();
    for (const tf of SERVER_CANDLE_TFS) {
      const closed = agg.getClosedHistory(f.symbol, tf) ?? [];
      byTf.set(tf, closed.map(toBar));
      byTfOracle.set(tf, oracleAggregate(f.ticks, TF_MS[tf]));
    }
    server.set(f.symbol, byTf);
    oracle.set(f.symbol, byTfOracle);
  }

  const lastTs = fixtures.reduce((m, f) => Math.max(m, f.ticks[f.ticks.length - 1]?.tsMs ?? 0), 0);
  const brokerNowMs = lastTs;

  const ctx: E2EContext = {
    sha,
    generatedAtIso: new Date().toISOString(),
    fixtures,
    server,
    oracle,
    brokerNowMs,
    timeframes: [...SERVER_CANDLE_TFS],
    tfMs: TF_MS,
    product: buildProductSurface(brokerNowMs),
    settlements: buildSettlements(fixtures, server),
  };

  const checks = runChecks(ctx);
  const mutations = runMutations(ctx);

  const meta = {
    sha: sha.slice(0, 7),
    branch,
    fixtureSource: source,
    fixtureSummary: fixtureSummary(ctx),
    serverAggregator: "core-backend/src/services/realtimeCandleAggregator.service.ts",
    nodeVersion: process.version,
  };

  const summary = buildSummary(ctx, meta, checks, mutations);
  const paths = writeReports(summary, meta.sha);

  const pass = checks.filter((c) => c.status === "PASS").length;
  const na = checks.filter((c) => c.status === "N/A").length;
  const fail = checks.filter((c) => c.status === "FAIL").length;
  const caught = mutations.filter((m) => m.caught).length;

  console.log(`verify:e2e — verdict ${summary.verdict}`);
  console.log(`  checks:    ${pass} pass, ${na} N/A, ${fail} fail`);
  console.log(`  mutations: ${caught}/${mutations.length} caught`);
  console.log(`  report:    ${paths.md}`);
  console.log(`  json:      ${paths.json}`);

  if (summary.verdict !== "OK") {
    for (const c of checks.filter((x) => x.status === "FAIL")) console.error(`  FAIL ${c.id}: ${c.message}`);
    for (const m of mutations.filter((x) => !x.caught)) console.error(`  MISS ${m.id}: ${m.message}`);
    process.exitCode = 1;
  }

  agg.destroy();
}

main();
