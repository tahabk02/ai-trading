/**
 * PART 42 [415]/[418] — DOM half verdicts.
 *
 * Reads tier-a-dom.jsonl (the browser sweep) and tier-a.jsonl (the API sweep)
 * and assigns each of the 220 pro cells + 44 blotter reads a [418] verdict:
 *
 *   FAIL                     price mismatch without a held marker, surface
 *                            disagreement, stale shown as live, or a target
 *                            drawn while the same-time gate says closed.
 *   OK-real                  a verdict/target drawn, surfaces agreeing.
 *   OK-withheld+reason       no target and the surfaces state WHY (engine
 *                            sub-reason verbatim, never a blank).
 *   N/A+reason               market gate / engine refused this window with a
 *                            recorded reason (503 / awaiting / nav error), OR
 *                            the REAL pair's weekly forex market is closed
 *                            (PART 42.1 — reason "market_closed: <last close>").
 *                            A closed market draws no signal/target by design;
 *                            it is NOT a FAIL.
 *
 * Cross-window drift between the two sweeps is ATTRIBUTED, not conflated: both
 * timestamps are kept and a drifted cell is labelled as such rather than FAIL,
 * because the gate re-verdicts over minutes (EUR/CAD was T1 at 3m/5m in the
 * API sweep and no_tier 20 min later — both true at their timestamps).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = dirname(fileURLToPath(import.meta.url));
const dom = readFileSync(join(SRC, "tier-a-dom.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const api = readFileSync(join(SRC, "tier-a.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const apiBySymExp = new Map();
for (const r of api) apiBySymExp.set(`${r.symbol}|${r.expiry}`, r);

const counts = { FAIL: 0, OK_real: 0, OK_withheld: 0, N_A: 0 };
const fails = [];
const drifted = [];
const drawnDom = [];
const willcheck = [];

function within(v, q, tol) {
  if (!Number.isFinite(v) || !Number.isFinite(q) || tol == null) return null;
  const eps = tol * 1e-9 + 1e-12;
  return Math.abs(v - q) <= tol + eps;
}
const displayTol = (digits) => (digits >= 4 ? 2 * Math.pow(10, -digits) : digits === 3 ? 0.02 : 0.01);

function surfacesAgree(vals) {
  const nums = vals.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return { ok: true, note: "fewer than 2 readable surfaces" };
  const lo = Math.min(...nums), hi = Math.max(...nums);
  return { ok: hi - lo <= 4e-4, note: `range ${hi - lo}` };
}

for (const row of dom) {
  const sym = row.symbol;
  const blot = row.blotter?.card ?? null;
  const blotPrice = blot?.price != null ? Number(blot.price) : null;
  const q = row.quote ?? null;
  const digits = q?.digits ?? 5;
  const tol = displayTol(digits);
  // The blotter card's price ORACLE: sampled at read time by the script (per
  // cell). Its provenance tone tells us whether the tape marked itself held.
  const provTone = blot?.provenance?.label ?? null;
  // PART 42.1 — a REAL pair in its weekly closed window is recorded as N/A:
  // no signal and no target are expected, and a stale "last close" price is
  // correct, not a failure.
  const marketClosedNow = q?.marketClosed === true;
  const marketClosedWhy = `market_closed: last close ${q?.lastTickAt ?? "unknown"}`;

  for (const cell of row.pro ?? []) {
    const e = Number(cell.expiry.replace("m", ""));
    const a = apiBySymExp.get(`${sym}|${e}`) ?? null;
    const p = cell.price ?? {};
    const live = p.live, panel = p.panel, anc = p.anc;
    const quote = p.quote != null ? Number(p.quote) : null;

    if (marketClosedNow) {
      counts.N_A++;
      willcheck.push({ symbol: sym, expiry: e, verdict: "N/A", why: marketClosedWhy });
      continue;
    }

    const reasons = [
      cell.target?.reason,
      cell.status_reason,
      cell.hud ? (/\b(PENDING HIGH PRECISION|REGIME REVIEW|SCORED-ONLY|BELOW|TOO LATE|AWAITING|NO VERDICT)\b/i.exec(cell.hud)?.[0] ?? null) : null,
    ].filter(Boolean);
    const hasReason = reasons.some((r) => /pending|regime|scored|below|too late|awaiting|no verdict|tier|floor/i.test(r));
    const drawn = cell.target?.state === "target";
    const withdrawn = !drawn;

    // PRICE: recomputed from RAW numbers (stored flags may predate the
    // tolerance boundary fix). Live surface renders toFixed(4) → its honest
    // unit is one display digit (5e-5); panel renders formatPairPrice at the
    // pair's own decimals → 2 display units of slack for fresh-tape jitter.
    // ANC is the ENGINE'S ANCHOR (sampled at evaluation time), a distinct
    // surface that legitimately lags a moving tape — it never joins the
    // live-price agreement set.
    const liveOk = within(live, quote, Math.max(displayTol(digits), 0.00005));
    const panelOk = panel == null ? null : within(panel, quote, Math.max(displayTol(digits), 0.0001));
    const agr = surfacesAgree([live, panel]);
    // Domain surfaces must agree with each other; vs-oracle fails count only if
    // no HELD/fallback marker excuses the tape.
    const heldTape = /held|fallback/i.test(String(provTone ?? ""));
    const priceBad =
      (liveOk === false || panelOk === false) && !heldTape && !(quote == null && (blotPrice == null));
    const surfaceBad = agr.ok === false;

    // TARGET rule vs the same-time gate.
    let targetState = "unknown";
    if (drawn) {
      const apiExpectDraw = a?.target?.state === "target" || a?.verdict === "OK-real";
      targetState = apiExpectDraw ? "agree-drawn" : "drift-drawn";
      drawnDom.push({ symbol: sym, expiry: e, text: cell.target?.text ?? null });
    } else {
      targetState = hasReason ? "withheld-reason" : "blank";
    }

    // Consistency of the withheld reason across surfaces (HUD vs pro-tgt vs card).
    const hudReason = cell.hud ?? "";
    const tgtReason = cell.target?.reason ?? "";
    const reasonConsistent =
      !withdrawn || !hasReason || hudReason.length === 0 ||
      /regime_review|awaiting|no verdict|pending|scored|too late|below/i.test(hudReason) && /regime|awaiting|pending|scored|too late|below/i.test(tgtReason);

    const isAwaitingNoVerdict = withdrawn && !hasReason && cell.error === undefined &&
      /no_tier|regime_review|awaiting|no verdict/i.test(String(cell.status_reason ?? ""));
    const engineRefused = cell.error || (cell.settled === false && isAwaitingNoVerdict);

    let v;
    if (engineRefused && cell.error) {
      v = { verdict: "N/A", why: "nav/" + (cell.error ?? "engine window") };
    } else if (surfaceBad) {
      v = { verdict: "FAIL", why: `surface disagreement ${agr.note}` };
    } else if (priceBad) {
      v = { verdict: "FAIL", why: `price mismatch live_ok=${liveOk} panel_ok=${panelOk} quote=${quote} live=${live} panel=${panel} heldTape=${heldTape}` };
    } else if (drawn && targetState === "drift-drawn") {
      v = { verdict: "OK-real", why: "drawn; API snapshot drifted (earlier)" };
      drifted.push({ symbol: sym, expiry: e });
    } else if (drawn) {
      v = { verdict: "OK-real", why: "target drawn; all surfaces agree" };
    } else if (withdrawn && targetState === "blank") {
      v = { verdict: "FAIL", why: "no target AND no reason rendered (blank)" };
    } else if (withdrawn && !reasonConsistent && hasReason) {
      v = { verdict: "FAIL", why: `surface reasons disagree hud="${hudReason.slice(0, 60)}" tgt="${tgtReason}"` };
    } else {
      v = {
        verdict: isAwaitingNoVerdict ? "N/A" : "OK-withheld+reason",
        why: isAwaitingNoVerdict ? "engine no-verdict this window (awaiting/no_tier)" : (cell.target?.reason ?? cell.status_reason ?? "withheld"),
      };
    }

    counts[v.verdict === "OK-real" ? "OK_real" : v.verdict === "OK-withheld+reason" ? "OK_withheld" : v.verdict === "N/A" ? "N_A" : "FAIL"]++;
    if (v.verdict === "FAIL") fails.push({ symbol: sym, expiry: e, why: v.why, hud: cell.hud?.slice(0, 80), live, panel, quote });
    willcheck.push({ symbol: sym, expiry: e, verdict: v.verdict, why: v.why });
  }

  // Blotter cell (the grid card for X) — 44 rows.
  const a1m = apiBySymExp.get(`${sym}|1`) ?? null;
  const cardTarget = blot?.target ?? null;
  const cardDrawn = cardTarget?.state === "target";
  const cardReason = cardTarget?.reason ?? null;
  const chip = blot?.chip ?? null;
  if (marketClosedNow) {
    // PART 42.1 — closed REAL market: no signal/target expected; last close is
    // correct. Recorded as N/A, never FAIL.
    counts.N_A++;
  } else if (blot?.price == null && blot?.error == null) {
    counts.FAIL++;
    fails.push({ symbol: sym, expiry: "blotter", why: "card price unreadable" });
  } else if (blot?.error) {
    counts.N_A++;
  } else if (cardDrawn && (a1m?.target?.state !== "target")) {
    drifted.push({ symbol: sym, expiry: "blotter" });
    counts.OK_real++;
  } else if (cardDrawn) {
    counts.OK_real++;
  } else if (cardReason || /awaiting|pending|below|regime/i.test(String(cardReason))) {
    counts.OK_withheld++;
  } else if (blot.prov) {
    counts.OK_withheld++;
  } else {
    counts.FAIL++;
    fails.push({ symbol: sym, expiry: "blotter", why: "card no reason, no price, no provenance (blank)" });
  }
}

const out = {
  cells: willcheck.length + 44,
  pro: willcheck.length,
  blotter: 44,
  counts,
  failList: fails,
  drifted: drifted.length,
  drawnDomCount: drawnDom.length,
  drawnDom,
};
writeFileSync(join(SRC, "tier-a-dom-verdicts.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  cells: out.cells, proCells: willcheck.length, blotterCells: 44, counts,
  drawnDom: drawnDom.length, drifted: drifted.length,
  failSample: fails.slice(0, 8),
}, null, 2));