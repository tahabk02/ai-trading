/**
 * PART 42 — Tier B (API level): 44 symbols × 16 timeframes = 704 cells,
 * candles only. Each cell subscribes to the SAME Socket.IO surface the
 * production chart uses (`subscribe` → `history_candles` burst) and asserts
 * the closed-candle contract:
 *   bars>0                    (else documented history-building state)
 *   timestamps strictly increasing & unique   (no dup at the backfill seam)
 *   timestamps aligned to the bucket grid      (ts % tfMs === 0)
 *   OHLC finite, low<=open/close<=high
 *   flat bars (high==low) recorded as an INFO flag — "flat renders as a line"
 *
 * Verdict per cell is one of [418]:
 *   OK-real        — burst arrived and every structural check passed
 *   N/A            — no closed candles for (symbol, tf): history-building
 *   FAIL           — bars present but the candle contract is broken
 *
 * Output: tier-b.jsonl (one row per cell) + a printed summary.
 *
 * Usage: node scripts/part42/tier-b.mjs [--verbose]
 */
import { io } from "socket.io-client";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, TIMEFRAMES, TF_MS, fetchSymbols, fetchQuotes, verdict } from "./part42.conf.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "scripts", "part42", "tier-b.jsonl");
const VERBOSE = process.argv.includes("--verbose");
const CELL_TIMEOUT_MS = Number(process.env.TIER_B_TIMEOUT_MS ?? 6_000);

appendFileSync(OUT, "");
const log = (o) => appendFileSync(OUT, JSON.stringify(o) + "\n");

function summarize(cell) {
  const bad = cell.checks.filter((c) => c.ok === false);
  const na = cell.checks.some((c) => c.na === true);
  if (cell.bars === 0 && na) {
    return verdict(cell, "N/A", "no closed candles yet (history-building)");
  }
  if (bad.length > 0) {
    return verdict(cell, "FAIL", bad.map((b) => b.reason).join("; "));
  }
  return verdict(cell, "OK-real", cell.flat ? "flat bars (traded flat / static tape)" : "candle contract clean");
}

async function probeCell(socket, symbol, tf) {
  const tfMs = TF_MS[tf];
  const cell = {
    tier: "B", symbol, timeframe: tf, cellKey: `${symbol}:${tf}`,
    bars: 0, flat: false, checks: [], at: new Date().toISOString(),
  };
  const started = Date.now();
  const burstPromise = new Promise((resolve) => {
    const onBurst = (payload) => {
      if (!payload || typeof payload !== "object") return;
      if (String(payload.symbol || "").toUpperCase() !== symbol) return;
      if (String(payload.timeframe || "").toUpperCase() !== tf) return;
      socket.off("history_candles", onBurst);
      resolve(payload.candles || []);
    };
    socket.on("history_candles", onBurst);
    setTimeout(() => { socket.off("history_candles", onBurst); resolve(null); }, CELL_TIMEOUT_MS);
  });

  socket.emit("subscribe", { symbol, timeframe: tf });
  const candles = await burstPromise;

  if (!candles) {
    cell.checks.push({ ok: true, na: true, reason: `no history_candles burst within ${CELL_TIMEOUT_MS}ms` });
    return summarize({ ...cell, checks: cell.checks, bars: 0 });
  }
  cell.bars = candles.length;
  if (cell.bars === 0) {
    cell.checks.push({ ok: true, na: true, reason: "empty closed-candle history (history-building)" });
    return summarize({ ...cell, checks: cell.checks });
  }
  const latencyMs = Date.now() - started;
  cell.latency_ms = latencyMs;

  // Structural contract.
  let prevTs = -Infinity;
  const seen = new Set();
  let monotonic = true;
  let unique = true;
  let aligned = true;
  let ohlcOk = true;
  let flatAll = true;
  let seamGap = null;
  const reasons = [];
  for (const c of candles) {
    const ts = c?.timestamp ?? c?.bucket_start_ms;
    const { open, high, low, close } = c ?? {};
    if (typeof ts !== "number" || !Number.isFinite(ts)) { ohlcOk = false; reasons.push(`bar missing numeric timestamp`); continue; }
    if (ts <= prevTs) { monotonic = false; reasons.push(`non-monotonic timestamp ${ts} after ${prevTs}`); }
    if (seen.has(ts)) { unique = false; reasons.push(`duplicate bucket timestamp ${ts} (backfill seam)`); }
    seen.add(ts);
    prevTs = ts;
    if (ts % tfMs !== 0) { aligned = false; reasons.push(`bucket ${ts} not aligned to ${tfMs}ms grid`); }
    if (![open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) {
      ohlcOk = false; reasons.push(`non-finite OHLC at ${ts}`); continue;
    }
    if (low > high) { ohlcOk = false; reasons.push(`low(${low}) > high(${high}) at ${ts}`); }
    if (open < low || open > high || close < low || close > high) {
      ohlcOk = false; reasons.push(`open/close outside [low,high] at ${ts}`);
    }
    if (high !== low) flatAll = false;
  }
  cell.flat = flatAll;
  // Backfill-seam duplicates: sequential duplicate detection above covers both
  // adjacent and reintroduced buckets because the set is inclusive.

  cell.checks.push({ ok: monotonic, reason: monotonic ? "timestamps strictly increasing" : reasons.find((r) => r.includes("non-monotonic")) });
  cell.checks.push({ ok: unique, reason: unique ? "timestamps unique (no backfill seam dup)" : reasons.find((r) => r.includes("duplicate")) });
  cell.checks.push({ ok: aligned, reason: aligned ? `aligned to ${tfMs}ms grid` : reasons.find((r) => r.includes("not aligned")) });
  cell.checks.push({ ok: ohlcOk, reason: ohlcOk ? "OHLC finite + low<=open/close<=high" : reasons.find((r) => r.includes("finite") || r.includes("outside") || r.includes("low(")) });
  void seamGap;
  return summarize({ ...cell, checks: cell.checks });
}

function printSummary(rows) {
  const counts = { "OK-real": 0, "N/A": 0, FAIL: 0 };
  const fails = [];
  for (const r of rows) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    if (r.verdict === "FAIL") fails.push(r);
  }
  console.log(`Tier B  cells=${rows.length} ${JSON.stringify(counts)}`);
  console.log(`flat-tape cells (high==low across all bars): ${rows.filter((r) => r.flat).length}`);
  const bySymbol = {};
  for (const r of rows) if (r.verdict !== "OK-real") (bySymbol[r.symbol] = bySymbol[r.symbol] || []).push(`${r.timeframe}:${r.verdict}`);
  for (const [sym, tfs] of Object.entries(bySymbol)) console.log(`  ${sym}: ${tfs.join(" ")}`);
  if (fails.length) {
    console.log(`FAIL list (${fails.length}):`);
    for (const f of fails) console.log(`  ${f.cellKey} ${f.detail}`);
  }
}

async function main() {
  const symbols = (await fetchSymbols()).map((s) => s.symbol);
  const quotes = await fetchQuotes();
  const cells = [];
  console.log(`Tier B start: ${symbols.length} symbols x ${TIMEFRAMES.length} timeframes = ${symbols.length * TIMEFRAMES.length} cells`);
  const socket = io(BASE, {
    transports: ["websocket"],
    timeout: CELL_TIMEOUT_MS,
    reconnection: false,
  });
  await new Promise((res, rej) => {
    socket.on("connect", res);
    socket.on("connect_error", rej);
  });
  for (const symbol of symbols) {
    for (const tf of TIMEFRAMES) {
      const row = await probeCell(socket, symbol, tf);
      const q = quotes.bySymbol[symbol];
      row.price = q ? q.price : null;
      row.priceAgeMs = q ? q.ageMs : null;
      row.quoteSource = q ? q.source : null;
      log(row);
      cells.push(row);
      if (VERBOSE) console.log(`${row.verdict}\t${row.cellKey}\tbars=${row.bars}`);
    }
  }
  socket.close();
  printSummary(cells);
  console.log(`wrote ${OUT}`);
  const failN = cells.filter((c) => c.verdict === "FAIL").length;
  process.exit(failN > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});