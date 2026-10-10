/**
 * PART 42 [415] TIER A — API half (corrected semantics).
 *
 * The PRICE equality in [415](a) is a LIVE-surface assertion: the terminal's
 * displayed price (grid card / rail / chart LIVE line / panel PRIX) must equal
 * the /quotes PRICE *at observation time*. Those DOM reads are live store
 * values, not model anchors. The engine's `current_price` is the prediction's
 * ANCHOR (sampled when the engine evaluated) and renders as ANC on the pro
 * surface — it is recorded here but is NOT the price cell.
 *
 * So this runner samples /quotes fresh per horizon and records:
 *   price     — quote (live) + model anchor (ANC) + delta, informational;
 *               LIVE-price equality is asserted by the DOM half.
 *   freshness — quote age vs QUOTE_STALE_THRESHOLD_MS; a stale quote is
 *               allowed but MUST be visibly marked stale on the surfaces.
 *   signal    — direction + confidence + tier + book join.
 *   target    — [415](d) draw rule via classifyTarget (draw authorized only
 *               when the gate is open AND executable; a closed-gate payload
 *               with an internal target_price is withheld + reason).
 *
 * Output: `scripts/part42/tier-a.jsonl` (220 cell rows), [418]-classified.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  EXPIRIES_MIN,
  QUOTE_STALE_THRESHOLD_MS,
  classifyTarget,
  fetchQuotes,
  fetchSymbols,
  multiPredict,
  priceTolerance,
} from "./part42.conf.mjs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(SRC_DIR, "tier-a.jsonl");
const BATCH = 8;
const RETRY_BATCH = 4;
const RETRY_ONCE = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isnum(v) {
  return v != null && Number.isFinite(Number(v));
}

function log(...a) {
  console.log(`[${new Date().toISOString()}]`, ...a);
}

const symbols = await fetchSymbols();
const all = symbols.map((s) => s.symbol);
const chunks = (n) => {
  const out = [];
  for (let i = 0; i < all.length; i += n) out.push(all.slice(i, i + n));
  return out;
};

const cells = [];
const counts = { OK_real: 0, OK_withheld: 0, N_A: 0, FAIL: 0 };

function classify({ sym, row, q, h }) {
  // NOTE: the engine's multiPredict result rows do NOT echo the symbol; the
  // caller must pass `sym` explicitly or rows lose their symbol column.
  const base = { symbol: sym, expiry: h, expiryLabel: `${h}m`, tf: "M1" };
  if (row.ok === false) {
    const reason =
      row.status === 503
        ? "awaiting live market data (engine 503 — history collector still building 1m bars) · " + (row.error ?? "")
        : (row.error ?? `engine no-verdict (status ${row.status})`);
    counts.N_A++;
    cells.push({ ...base, verdict: "N/A", status: row.status, reason });
    return;
  }
  const d = row.data ?? null;
  if (!d) {
    counts.FAIL++;
    cells.push({ ...base, verdict: "FAIL", fail: { aspect: "engine", detail: "ok=true with empty data row (blank without a reason)" } });
    return;
  }

  const digits = isnum(q?.digits) ? Number(q.digits) : isnum(d?.digits) ? Number(d.digits) : 5;
  const quote = isnum(q?.price) ? Number(q.price) : null;
  const anc = isnum(d?.current_price) ? Number(d.current_price) : null;
  const tol = priceTolerance(digits, quote ?? anc ?? 0);
  const ageMs = isnum(q?.ageMs) ? Number(q.ageMs) : null;

  const t = classifyTarget({
    regime: d?.regime_gate ?? d?.regimeGate ?? null,
    suppressed: d?.suppressed_reason ?? d?.suppressedReason ?? null,
    executable: d?.executable ?? null,
    tier: d?.tier ?? null,
    target_price: d?.target_price ?? null,
  });

  if (t.state === "FAIL") {
    counts.FAIL++;
    cells.push({ ...base, verdict: "FAIL", fail: { aspect: "target", detail: t.reason } });
    return;
  }
  const withheld = t.state === "withheld";
  counts[withheld ? "OK_withheld" : "OK_real"]++;
  cells.push({
    ...base,
    verdict: withheld ? "OK-withheld+reason" : "OK-real",
    price: { quote, anc, delta: quote != null && anc != null ? anc - quote : null, tol, digits, note: "live-price equality is a DOM assertion" },
    freshness: { ageMs, staleThreshold: QUOTE_STALE_THRESHOLD_MS, stale: ageMs != null ? ageMs > QUOTE_STALE_THRESHOLD_MS : null },
    signal: { dir: d?.signal ?? null, conf: isnum(d?.confidence) ? Number(d.confidence) : null, tier: d?.tier ?? null },
    target: { ...t, regime_gate: d?.regime_gate ?? d?.regimeGate ?? null, suppressed_reason: d?.suppressed_reason ?? d?.suppressedReason ?? null, executable: d?.executable ?? null },
  });
}

for (const h of EXPIRIES_MIN) {
  // Fresh /quotes sample per horizon: the tape advances during the sweep, so a
  // single beginning-of-run snapshot would be misdated for later horizons.
  const quotes = await fetchQuotes();
  let failed = [];
  for (const batch of chunks(BATCH)) {
    const res = await multiPredict(batch, h, "1m");
    const results = (res.body || {}).results || {};
    for (const sym of batch) {
      const row = results[sym] ?? null;
      if (!row) { failed.push(sym); continue; }
      if (row.ok === false && row.status === 503) { failed.push(sym); continue; }
      classify({ sym, row, q: quotes.bySymbol[sym] ?? null, h });
    }
    log(`horizon=${h}m progressed cells=${cells.length} counts=${JSON.stringify(counts)}`);
    await sleep(3000);
  }
  if (RETRY_ONCE && failed.length) {
    log(`retrying ${failed.length} 503s from ${h}m...`);
    await sleep(4000);
    const quotes2 = await fetchQuotes();
    const still = [];
    for (const sched0 of chunks(RETRY_BATCH)) {
      const sched = sched0.filter((s) => failed.includes(s));
      if (!sched.length) continue;
      const res = await multiPredict(sched, h, "1m");
      const results = (res.body || {}).results || {};
      for (const sym of sched) {
        const row = results[sym] ?? null;
        if (!row || row.ok === false) { still.push(sym); continue; }
        classify({ sym, row, q: quotes2.bySymbol[sym] ?? null, h });
      }
      await sleep(3000);
    }
    for (const sym of still) {
      counts.N_A++;
      cells.push({
        symbol: sym, expiry: h, expiryLabel: `${h}m`, tf: "M1",
        verdict: "N/A", status: 503,
        reason: "awaiting live market data (engine 503 on both attempts — history collector still building this pair's 1m bars)",
      });
    }
  }
}

writeFileSync(OUT, cells.map((c) => JSON.stringify(c)).join("\n") + "\n");
log(JSON.stringify({ out: OUT, cells: cells.length, counts }, null, 2));