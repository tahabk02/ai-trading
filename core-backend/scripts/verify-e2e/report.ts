/**
 * verify-e2e/report.ts — PART 47 [525] report writer.
 *
 * Emits the human-readable Markdown report plus the machine-readable JSON to
 * `docs/verification/`. The verdict is only OK when NO baseline cell is FAIL and
 * EVERY mutation was caught. N/A cells are listed with their reasons and never
 * counted as passes.
 */

import * as fs from "fs";
import * as path from "path";
import type { CheckResult, E2EContext, MutationResult } from "./types";

export interface RunMeta {
  sha: string;
  branch: string;
  fixtureSource: "disk" | "generated";
  fixtureSummary: string;
  serverAggregator: string;
  nodeVersion: string;
}

export interface RunSummary {
  verdict: "OK" | "FAIL";
  checks: CheckResult[];
  mutations: MutationResult[];
  reportMd: string;
  reportJson: string;
}

function repoRoot(): string {
  return path.join(__dirname, "..", "..", "..");
}

function verificationDir(): string {
  return path.join(repoRoot(), "docs", "verification");
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|");
}

export function buildSummary(
  ctx: E2EContext,
  meta: RunMeta,
  checks: CheckResult[],
  mutations: MutationResult[],
): RunSummary {
  const baselineFails = checks.filter((c) => c.status === "FAIL");
  const naCells = checks.filter((c) => c.status === "N/A");
  const missedMutations = mutations.filter((m) => !m.caught);
  const verdict: RunSummary["verdict"] =
    baselineFails.length === 0 && missedMutations.length === 0 ? "OK" : "FAIL";

  const lines: string[] = [];
  lines.push(`# E2E Verification Report — ${meta.sha}`);
  lines.push("");
  lines.push(`- Generated: ${ctx.generatedAtIso}`);
  lines.push(`- Branch: \`${meta.branch}\``);
  lines.push(`- Verdict: **${verdict}**`);
  lines.push(`- Harness: \`core-backend/scripts/verify-e2e\` (offline, deterministic, no network/DB/browser)`);
  lines.push(`- Node: ${meta.nodeVersion}`);
  lines.push(`- Code under test: \`${meta.serverAggregator}\``);
  lines.push(`- Fixtures (${meta.fixtureSource}): ${meta.fixtureSummary}`);
  lines.push(`- Broker clock anchor: ${ctx.brokerNowMs} ms (fixture-authoritative)`);
  lines.push("");

  lines.push("## Baseline checks");
  lines.push("");
  lines.push("| id | check | status | message |");
  lines.push("| --- | --- | --- | --- |");
  for (const c of checks) {
    lines.push(`| ${c.id} | ${esc(c.name)} | ${c.status} | ${esc(c.message)} |`);
  }
  lines.push("");

  lines.push("## Fault injection (each mutation must FAIL its target)");
  lines.push("");
  lines.push("| id | mutation | targets | caught | explicit failure message |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const m of mutations) {
    lines.push(`| ${m.id} | ${esc(m.name)} | ${m.targets} | ${m.caught ? "yes" : "NO"} | ${esc(m.message)} |`);
  }
  lines.push("");

  lines.push("## N/A cells (unavailable offline — NOT passes)");
  lines.push("");
  if (naCells.length === 0) {
    lines.push("_none_");
  } else {
    lines.push("| id | check | reason |");
    lines.push("| --- | --- | --- |");
    for (const c of naCells) {
      lines.push(`| ${c.id} | ${esc(c.name)} | ${esc(c.reason ?? "(missing reason!)")} |`);
    }
  }
  lines.push("");

  lines.push("## Scope and limitations");
  lines.push("");
  lines.push("- Exercised offline: server aggregator vs an INDEPENDENT oracle across all 16 timeframes and all fixture symbols; OHLC invariants; slot geometry; M5 rollup; OTC source purity; product expiry/target/TIMER slot math vs the oracle; broker-clock anchoring; price linkage + quote freshness; settlement derivation.");
  lines.push("- NOT exercised (see N/A reasons): a live Pocket Option session, the `/history` HTTP surface, the DOM-rendered chart series, and Postgres persistence of `SignalOutcome` rows.");
  lines.push("- This report describes candle/time/settlement correctness from replayed ticks only. It is not a brokerage or financial-advice statement.");
  lines.push("");

  const md = lines.join("\n");
  const json = JSON.stringify(
    {
      sha: meta.sha,
      branch: meta.branch,
      generatedAt: ctx.generatedAtIso,
      verdict,
      fixtureSource: meta.fixtureSource,
      fixtureSummary: meta.fixtureSummary,
      brokerNowMs: ctx.brokerNowMs,
      checks,
      mutations,
      naCells: naCells.map((c) => ({ id: c.id, check: c.name, reason: c.reason ?? null })),
    },
    null,
    2,
  );

  return { verdict, checks, mutations, reportMd: md, reportJson: json };
}

export function writeReports(summary: RunSummary, sha: string): { md: string; json: string } {
  const dir = verificationDir();
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `E2E-REPORT-${sha}.md`);
  const jsonPath = path.join(dir, `E2E-REPORT-${sha}.json`);
  fs.writeFileSync(mdPath, summary.reportMd, "utf8");
  fs.writeFileSync(jsonPath, summary.reportJson, "utf8");
  return { md: mdPath, json: jsonPath };
}
