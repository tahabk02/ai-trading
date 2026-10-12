/**
 * PART 42 [415] — offline reclassification of an existing tier-a API sweep.
 * Applies the corrected [415](d) target rule (classifyTarget) and the [418]
 * verdict taxonomy to the raw cells the sweep wrote, so counts for a run can
 * be recomputed without re-hitting the engine. Writes the verdict column in
 * place and prints the FAIL list with evidence.
 *
 *   node tier-a-reclassify.mjs <source.jsonl> [out.jsonl]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { classifyTarget, QUOTE_STALE_THRESHOLD_MS } from "./part42.conf.mjs";

const src = process.argv[2];
const out = process.argv[3] ?? src;

const lines = readFileSync(src, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const counts = { "OK-real": 0, "OK-withheld+reason": 0, "N/A": 0, FAIL: 0 };
const fails = [];
const withheld = [];
const drawn = [];

for (const c of lines) {
  if (c.verdict === "N/A") { counts["N/A"]++; continue; }

  const priceOk = c.price?.ok;
  const target = c.target ?? {};

  let v = classifyTarget({
    regime: target.regime_gate ?? null,
    suppressed: target.suppressed_reason ?? null,
    executable: target.executable ?? null,
    tier: c.signal?.tier ?? null,
    target_price: target.expected_target_price ?? target.target_price ?? null,
  });

  // Quantitative FAILs (aspect rows) outrank classifier state.
  if (priceOk === false) {
    c.verdict = "FAIL";
    c.fail = {
      aspect: "price",
      detail: `pred=${c.price.pred} quote=${c.price.quote} tol=${c.price.tol} digits=${c.price.digits}`,
    };
  } else if (v.state === "FAIL") {
    c.verdict = "FAIL";
    c.fail = { aspect: "target", detail: v.reason };
  } else if (v.state === "withheld") {
    c.verdict = "OK-withheld+reason";
    c.target = { ...c.target, ...v };
  } else {
    c.verdict = "OK-real";
    c.target = { ...c.target, ...v };
  }

  counts[c.verdict]++;
  if (c.verdict === "FAIL") fails.push(c);
  else if (c.verdict === "OK-withheld+reason") withheld.push(c);
  else if (v.state === "target") drawn.push(c);
}

writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const staleCells = lines.filter((c) => c.freshness?.ageMs != null && c.freshness.ageMs > QUOTE_STALE_THRESHOLD_MS).length;

console.log(JSON.stringify({
  out,
  cells: lines.length,
  counts,
  withheldCount: withheld.length,
  drawnCount: drawn.length,
  staleCells,
  failList: fails.map((f) => ({
    symbol: f.symbol, expiry: f.expiry, aspect: f.fail?.aspect, detail: f.fail?.detail,
  })),
  drawnSample: drawn.slice(0, 8).map((d) => ({
    symbol: d.symbol, expiry: d.expiry, dir: d.signal?.dir, conf: d.signal?.conf, tier: d.signal?.tier,
    target: d.target?.expected_target_price, regime: d.target?.regime_gate,
  })),
}, null, 2));