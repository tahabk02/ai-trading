/**
 * audit-asset-history.ts — PART 44 [495] DATA PROVENANCE AUDIT CLI
 *
 * Read-only by default: loads persisted AssetHistory rows and prints the
 * provenance verdict per symbol (PO-sourced vs non-PO-sourced vs unstamped) so
 * an operator can SEE proxy/held/ai bars wearing an OTC history label.
 *
 * Usage:
 *   npm run audit:history                     # read-only report
 *   npm run audit:history -- --backup ./faults.json
 *                                             # write the fault set to JSON
 *   npm run audit:history -- --symbol EUR/USD --backup ./faults.json \
 *       --apply --mode quarantine             # re-stamp OTC proxy bars
 *   npm run audit:history -- --backup ./faults.json --apply --mode delete
 *                                             # DESTRUCTIVE — delete them
 *
 * Guardrails:
 *   • `--apply` REQUIRES `--mode quarantine|delete` AND a `--backup` snapshot.
 *   • quarantine re-stamps the fault bars to `quarantined:<source>` — the rows
 *     survive but are visibly excluded from any PO-gated consumer.
 *   • delete removes the fault rows (the JSON backup is your rollback).
 *   • Unstamped OTC rows (legacy pre-[494]) are reported but NEVER auto-deleted.
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

const SERVICE_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(SERVICE_ROOT, ".env"), override: false, quiet: true });

import { summarizeAssetHistory, AssetHistoryBarRow, OtcFaultBar } from "../src/lib/assetHistoryAudit";

const QUARANTINE_PREFIX = "quarantined:";

function usage(): void {
  console.log(`audit-asset-history — PART 44 [495] provenance audit

  --symbol <x>      audit only one symbol
  --limit <n>       cap how many rows are read (default: all)
  --backup <path>   write the JSON fault snapshot before mutating
  --apply           enable mutation (REQUIRES --mode + --backup)
  --mode <mode>     quarantine | delete`);
}

function arg(flag: string, argv: string[]): string | null {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

function flags(argv: string[]): {
  symbol: string | null;
  limit: number | null;
  backup: string | null;
  apply: boolean;
  mode: "quarantine" | "delete" | null;
} {
  const symbol = arg("--symbol", argv);
  const limitRaw = arg("--limit", argv);
  const backup = arg("--backup", argv);
  const modeRaw = arg("--mode", argv);
  const mode =
    modeRaw === "quarantine" || modeRaw === "delete" ? modeRaw : modeRaw ? null : null;
  if (modeRaw && mode === null) {
    console.error(`invalid --mode "${modeRaw}" (expected quarantine|delete)`);
    process.exit(2);
  }
  const limit = limitRaw ? Number(limitRaw) : null;
  if (limitRaw && (!Number.isInteger(limit) || (limit as number) < 1)) {
    console.error(`invalid --limit "${limitRaw}"`);
    process.exit(2);
  }
  return { symbol, limit, backup, apply: argv.includes("--apply"), mode };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function printReport(
  summary: ReturnType<typeof summarizeAssetHistory>,
): void {
  console.log("PART 44 [495] — DATA PROVENANCE AUDIT");
  console.log(`generated_at: ${summary.generated_at}`);
  console.log(
    `symbols=${summary.symbols} bars=${fmt(summary.totalBars)} ` +
      `otc=${fmt(summary.totalOtcBars)} po_sourced=${fmt(summary.totalPoSourcedBars)} ` +
      `non_po=${fmt(summary.totalNonPoSourcedBars)} unstamped=${fmt(summary.totalUnstampedBars)} ` +
      `flat=${fmt(summary.totalFlatBars)}`,
  );
  console.log(`otc_proxy_faults=${fmt(summary.otcProxyBarCount)} otc_unstamped=${fmt(summary.otcUnstampedBarCount)}`);
  console.log("");
  for (const s of summary.perSymbol) {
    console.log(
      `  ${s.symbol}: bars=${s.bars} otc=${s.otcBars} po=${s.poSourcedBars} ` +
        `non_po=${s.nonPoSourcedBars} unstamped=${s.unstampedBars} flat=${s.flatBars} ` +
        `ticks[min=${s.tickCountMin},avg=${s.bars > 0 ? Math.round(s.tickCountSum / s.bars) : 0},max=${s.tickCountMax}]`,
    );
    if (s.otcProxyBarCount > 0) {
      console.log(`    FAULT: ${s.otcProxyBarCount} OTC bar(s) authored by a non-PO feed`);
    }
    if (s.otcUnstampedBarCount > 0) {
      console.log(`    NOTE: ${s.otcUnstampedBarCount} OTC bar(s) with no provenance stamp (legacy)`);
    }
  }
  if (summary.verdicts.length > 0) {
    console.log("");
    for (const v of summary.verdicts) console.log(`• ${v}`);
  }
}

async function loadRows(
  prisma: PrismaClient,
  opts: { symbol: string | null; limit: number | null },
): Promise<AssetHistoryBarRow[]> {
  const where = opts.symbol
    ? { symbol: String(opts.symbol).trim().toUpperCase() }
    : {};
  const rows = await prisma.assetHistory.findMany({
    where,
    orderBy: [{ symbol: "asc" }, { bucketStartMs: "asc" }],
    ...(opts.limit ? { take: opts.limit } : {}),
  });
  return rows.map((r) => ({
    symbol: r.symbol,
    timeframe: r.timeframe,
    bucketStartMs: Number(r.bucketStartMs),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    tickCount: r.tickCount,
    source: r.source ?? null,
  }));
}

function flattenFaults(
  summary: ReturnType<typeof summarizeAssetHistory>,
): OtcFaultBar[] {
  return summary.perSymbol.flatMap((s) => s.otcProxyBars);
}

function quarantineBatch(
  prisma: PrismaClient,
  faults: OtcFaultBar[],
): Promise<number> {
  return prisma.$transaction(
    faults
      .filter((f) => !String(f.source ?? "").startsWith(QUARANTINE_PREFIX))
      .map((f) =>
        prisma.assetHistory.updateMany({
          where: {
            symbol: f.symbol,
            timeframe: f.timeframe,
            bucketStartMs: BigInt(f.bucketStartMs),
          },
          data: { source: `${QUARANTINE_PREFIX}${f.source ?? "unknown"}` },
        }),
      ),
  ).then((results) => results.reduce((a, r) => a + r.count, 0));
}

function deleteBatch(prisma: PrismaClient, faults: OtcFaultBar[]): Promise<number> {
  return prisma.$transaction(
    faults.map((f) =>
      prisma.assetHistory.deleteMany({
        where: {
          symbol: f.symbol,
          timeframe: f.timeframe,
          bucketStartMs: BigInt(f.bucketStartMs),
        },
      }),
    ),
  ).then((results) => results.reduce((a, r) => a + r.count, 0));
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }
  const opts = flags(argv);

  if (opts.apply && !opts.mode) {
    console.error("--apply requires --mode quarantine|delete");
    process.exit(2);
  }
  if (opts.apply && !opts.backup) {
    console.error("--apply requires --backup <path> (snapshot before mutating)");
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const rows = await loadRows(prisma, { symbol: opts.symbol, limit: opts.limit });
    const summary = summarizeAssetHistory(rows);
    const faults = flattenFaults(summary);
    printReport(summary);

    if (opts.backup) {
      const snapshot = {
        generated_at: summary.generated_at,
        filtered_symbol: opts.symbol,
        summary: {
          totalBars: summary.totalBars,
          otcProxyBarCount: summary.otcProxyBarCount,
          otcUnstampedBarCount: summary.otcUnstampedBarCount,
        },
        otc_proxy_faults: faults,
      };
      fs.writeFileSync(opts.backup, JSON.stringify(snapshot, null, 2), "utf-8");
      console.log(`\nbackup written: ${opts.backup} (${faults.length} fault rows)`);
    }

    if (opts.apply) {
      if (faults.length === 0) {
        console.log("\n--apply: no OTC proxy/held faults to act on — nothing to do.");
        return;
      }
      const affected =
        opts.mode === "delete"
          ? await deleteBatch(prisma, faults)
          : await quarantineBatch(prisma, faults);
      console.log(
        `\nAPPlied --mode=${opts.mode}: ${affected} OTC proxy/held bar(s) ${opts.mode === "delete" ? "deleted" : "quarantined (re-stamped)"}.`,
      );
    } else {
      console.log(
        "\n(read-only — pass --backup <path> --apply --mode quarantine|delete to act on the faults)",
      );
    }
  } catch (err) {
    console.error("audit failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error("audit failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});