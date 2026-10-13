/**
 * verify-e2e/fixtures.ts — PART 47 [525] deterministic replay fixtures.
 *
 * The harness must be able to run twice and produce identical numbers, and it
 * must not depend on a live PO session. So fixtures are GENERATED once from a
 * seeded PRNG (no Math.random, no network) and written to `fixtures/` on first
 * run; every later run LOADS them from disk. The broker clock is a FIXED past
 * epoch so a wall-clock bug (using Date.now) is trivially detectable.
 */

import * as fs from "fs";
import * as path from "path";
import type { Fixture, Tick } from "./types";

/** 2026-09-01T00:00:00Z — broker-clock anchor, aligned to a minute. */
export const BROKER_START_MS = 1_788_220_800_000;
export const SPAN_MINUTES = 32;
export const TICK_INTERVAL_MS = 1_000;
/** Fixture-authoritative "now": one interval past the last tick. */
export const BROKER_NOW_MS = BROKER_START_MS + SPAN_MINUTES * 60_000;
/** A quote older than this is stale and must not be presented as live. */
export const QUOTE_STALE_AFTER_MS = 5_000;

interface SymbolSpec {
  symbol: string;
  assetClass: Fixture["assetClass"];
  source: string;
  base: number;
  drift: number;
  digits: number;
}

/** >= 6 symbols across OTC / real / crypto provenance classes. */
export const SYMBOL_SPECS: SymbolSpec[] = [
  { symbol: "EUR/USD", assetClass: "otc", source: "pocket_option_ws", base: 1.085, drift: 0.0007, digits: 5 },
  { symbol: "GBP/USD", assetClass: "otc", source: "pocket_option_ws", base: 1.265, drift: 0.0009, digits: 5 },
  { symbol: "AUD/CAD", assetClass: "otc", source: "pocket_option_ws", base: 0.905, drift: 0.0006, digits: 5 },
  { symbol: "USD/CHF", assetClass: "otc", source: "pocket_option_ws", base: 0.895, drift: 0.0006, digits: 5 },
  { symbol: "USD/JPY", assetClass: "real", source: "github_repo_cached", base: 149.5, drift: 0.06, digits: 3 },
  { symbol: "EUR/GBP", assetClass: "real", source: "pocket_option_ws", base: 0.855, drift: 0.0004, digits: 5 },
  { symbol: "BTC/USD", assetClass: "crypto", source: "coingecko", base: 61_000, drift: 55, digits: 2 },
  { symbol: "ETH/USD", assetClass: "crypto", source: "coingecko", base: 3_200, drift: 4, digits: 2 },
];

/** Deterministic LCG — identical across runs and platforms. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function generateFixture(spec: SymbolSpec, index: number): Fixture {
  const rng = makeRng(0x9e3779b9 ^ (index + 1) * 2_654_435_761);
  const count = Math.floor((SPAN_MINUTES * 60_000) / TICK_INTERVAL_MS);
  const ticks: Tick[] = [];
  let price = spec.base;

  for (let i = 0; i <= count; i += 1) {
    const shock = (rng() - 0.5) * 2 * spec.drift;
    price = roundTo(Math.max(spec.base * 0.5, price + shock + spec.drift * 0.02), spec.digits);
    ticks.push({
      tsMs: BROKER_START_MS + i * TICK_INTERVAL_MS,
      price,
      volume: 0,
      source: spec.source,
    });
  }

  return {
    symbol: spec.symbol,
    assetClass: spec.assetClass,
    source: spec.source,
    startMs: BROKER_START_MS,
    intervalMs: TICK_INTERVAL_MS,
    spanMinutes: SPAN_MINUTES,
    ticks,
  };
}

export function generateFixtures(): Fixture[] {
  return SYMBOL_SPECS.map((spec, i) => generateFixture(spec, i));
}

interface FixtureFileV1 {
  version: 1;
  startMs: number;
  intervalMs: number;
  spanMinutes: number;
  symbols: Array<{
    symbol: string;
    assetClass: Fixture["assetClass"];
    source: string;
    digits: number;
    ticks: Array<[number, number]>;
  }>;
}

function serialize(fixtures: Fixture[]): FixtureFileV1 {
  return {
    version: 1,
    startMs: BROKER_START_MS,
    intervalMs: TICK_INTERVAL_MS,
    spanMinutes: SPAN_MINUTES,
    symbols: fixtures.map((f) => ({
      symbol: f.symbol,
      assetClass: f.assetClass,
      source: f.source,
      digits: SYMBOL_SPECS.find((s) => s.symbol === f.symbol)?.digits ?? 5,
      ticks: f.ticks.map((t) => [t.tsMs, t.price] as [number, number]),
    })),
  };
}

function deserialize(doc: FixtureFileV1): Fixture[] {
  return doc.symbols.map((s) => ({
    symbol: s.symbol,
    assetClass: s.assetClass,
    source: s.source,
    startMs: doc.startMs,
    intervalMs: doc.intervalMs,
    spanMinutes: doc.spanMinutes,
    ticks: s.ticks.map(([tsMs, price]) => ({ tsMs, price, volume: 0, source: s.source })),
  }));
}

export function fixturesDir(): string {
  return path.join(__dirname, "fixtures");
}

export function fixtureFilePath(): string {
  return path.join(fixturesDir(), `replay-${BROKER_START_MS}.json`);
}

/**
 * Load fixtures from disk, generating and persisting them on first run.
 * Returns `{ fixtures, source }` where source is "disk" | "generated".
 */
export function loadFixtures(): { fixtures: Fixture[]; source: "disk" | "generated" } {
  const dir = fixturesDir();
  const file = fixtureFilePath();
  if (fs.existsSync(file)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as FixtureFileV1;
    return { fixtures: deserialize(doc), source: "disk" };
  }
  const fixtures = generateFixtures();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(serialize(fixtures)), "utf8");
  return { fixtures, source: "generated" };
}

/** Compact one-line provenance summary for the report. */
export function describeFixtures(fixtures: Fixture[]): string {
  const byClass = new Map<string, number>();
  for (const f of fixtures) byClass.set(f.assetClass, (byClass.get(f.assetClass) ?? 0) + 1);
  const classes = [...byClass.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
  const ticks = fixtures.reduce((n, f) => n + f.ticks.length, 0);
  return `${fixtures.length} symbols (${classes}), ${SPAN_MINUTES} min each, ${ticks} ticks total`;
}
