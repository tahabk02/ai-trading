/**
 * PART 42 [415] TIER A — DOM half.
 *
 * For each symbol (processed in resumable chunks from tier-a-dom-state.json):
 *
 *   PRO PASS — /dashboard/pro?symbol=X&tf=60, then each of the (2m..10m) expiry
 *              options clicked in turn. After each refetch settles we read the
 *              live surfaces the engine gates against:
 *                • pro-live-price        (chart LIVE store price — the number
 *                                         the chart's live line renders)
 *                • pro-anc               (engine anchor, informational)
 *                • pro-tgt               (target slot: state/reason/detail)
 *                • pro-expiry-status     (per-horizon gate reason)
 *                • neural-matrix verdict (same coherent view as the HUD)
 *                • trading-panel PRIX + CALL/PUT badge (right rail)
 *                • chart HUD overlay     (signal/conf/books + target slot)
 *                • rail card price+stale on linked SignalWidget when present
 *              plus each expiry option's data-too-late flag.
 *
 *   BLOTTER PASS — /dashboard, read `asset-card` for X: price text, quote
 *              provenance, card-target-slot attrs, live badge, tier.
 *
 * Every read is paired with a fresh /quotes snapshot so the [415](a) PRICE
 * equality vs the feed is compared at observation time, not against a
 * beginning-of-run snapshot.
 *
 * Output: `tier-a-dom.jsonl` (append); state persisted after each symbol.
 * Usage:  node <browser-dir>/browser.mjs --session part42a --script tier-a-dom.mjs
 *         (processes CHUNK symbols per invocation, default 2).
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const STATE = join(SRC_DIR, "tier-a-dom-state.json");
const ROWS = join(SRC_DIR, "tier-a-dom.jsonl");
const ROWS2 = join(SRC_DIR, "tier-a-reconcile.jsonl");
const CHUNK = Number(process.env.TIER_A_DOM_CHUNK ?? 2);
const RECONCILE = (process.env.TIER_A_RECONCILE ?? "")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

const BASE = "http://localhost:4000/api/v1";
const EXPIRIES = ["1m", "2m", "3m", "5m", "10m"];
const PRO_URL = (sym, tf) =>
  `http://localhost:3000/dashboard/pro?symbol=${encodeURIComponent(sym)}&tf=${tf}`;
const TERM_URL = "http://localhost:3000/dashboard";

const state = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, "utf8"))
  : { idx: 0, symbols: null, cursor: null };

function qsym(s) { // canonical
  return String(s || "").trim().toUpperCase();
}
function num(v) {
  return v == null ? null : Number(String(v).replace(/[^0-9.\-]/g, ""));
}
function parsePriceText(txt) {
  if (txt == null) return null;
  const m = String(txt).match(/[-+]?\d[\d.,]*/);
  if (!m) return null;
  return parseFloat(m[0].replace(/,/g, ""));
}
function tolFor(digits, price) {
  if (digits >= 4) return 2 * Math.pow(10, -digits);
  if (digits === 3) return 0.02;
  return Math.max((price || 0) * 0.0005, 0.01);
}
function within(v, q, tol) {
  if (v == null || q == null) return null;
  const eps = tol * 1e-9 + 1e-12; // boundary epsilon for float rounding
  return Math.abs(v - q) <= tol + eps;
}

async function quotes() {
  const r = await fetch(`${BASE}/quotes`, { signal: AbortSignal.timeout(20_000) });
  const j = await r.json();
  const bySymbol = {};
  for (const q of j.quotes || []) bySymbol[qsym(q.symbol)] = q;
  return { ts: j.timestamp, bySymbol };
}

/** The authoritative 44, gate-open (drawn-target) symbols first so the demo
 *  path is exercised on the very first chunk. */
async function fetchSymbolList() {
  const r = await fetch(`${BASE}/symbols?limit=1000`, { signal: AbortSignal.timeout(20_000) });
  const j = await r.json();
  const all = (j.symbols || []).map((s) => qsym(s.symbol)).sort();
  const openFirst = ["EUR/TRY", "EUR/CAD", "EUR/CHF", "EUR/GBP"];
  const rest = all.filter((s) => !openFirst.includes(s));
  return [...openFirst.filter((s) => all.includes(s)), ...rest];
}

/** Wait until the pro surface reports a *settled* state (2 stable polls). */
async function settle(page, key) {
  const start = Date.now();
  let last = null;
  let stableSince = null;
  const deadline = start + 240_000;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const g = (t) => document.querySelector(`[data-testid=${t}]`);
      const tgt = g("pro-tgt");
      const st = g("pro-expiry-status");
      const anc = g("pro-anc");
      const live = g("pro-live-price");
      return {
        tgt_state: tgt?.getAttribute("data-state") ?? null,
        tgt_reason: tgt?.getAttribute("data-reason") ?? null,
        tgt_detail: tgt?.getAttribute("data-detail") ?? null,
        status: st?.getAttribute("data-reason") ?? null,
        anc: anc?.textContent ?? null,
        live: live?.textContent ?? null,
      };
    });
    const sig = JSON.stringify([
      snap.tgt_state, snap.tgt_reason, snap.status, snap.anc, snap.live,
    ]);
    if (last === sig) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 6000) return { settled: true, ms: Date.now() - start, snap };
    } else {
      stableSince = null;
    }
    last = sig;
    await page.waitForTimeout(1800);
  }
  return { settled: false, ms: Date.now() - start, snap: last ? JSON.parse(last) : null };
}

async function proPass(page, sym, q) {
  const q0 = q;
  const digitsSeed = q?.digits ?? 5;
  const rows = [];

  await page.goto(PRO_URL(sym, 60), { waitUntil: "domcontentloaded", timeout: 60_000 });
  try {
    await page.waitForSelector('[data-testid="pro-expiry-options"]', { timeout: 90_000 });
  } catch {
    rows.push({ expiry: "NAV-ERROR", error: "pro-expiry-options never appeared" });
    return rows;
  }
  await page.waitForFunction(
    () => document.querySelector('[data-testid="pro-live-price"]')?.textContent?.includes(".") ?? false,
    { timeout: 90_000 },
  ).catch(() => {});

  for (let i = 0; i < EXPIRIES.length; i++) {
    const label = EXPIRIES[i];
    if (i > 0) {
      const clickable = page.locator(`[data-testid="pro-expiry-${label}"]`);
      await clickable.first().waitFor({ timeout: 30_000 }).catch(() => {});
      await clickable.first().click({ timeout: 30_000 }).catch((e) => {
        rows.push({ expiry: label, error: "click failed: " + e.message.split("\n")[0] });
        return;
      });
    }
    // Note: the 1m row is the tf=60 deep link's own prediction already settling
    // on load; 2m..10m settle after the click's forced refetch.
    const st = await settle(page, label);
    // PRICE oracle must be sampled AT the moment of the DOM read, not once per
    // chunk: the tape advances and can hold a different (HELD) print than an
    // earlier REST snapshot (see EUR/CHF 0.93130 HELD vs endpoint 0.932807).
    const qNow = await quotes().catch(() => ({ bySymbol: {} }));
    const qr = qNow.bySymbol?.[sym] ?? null;
    const digits = qr?.digits ?? digitsSeed;
    const dom = await page.evaluate(() => {
      const g = (t) => document.querySelector(`[data-testid=${t}]`);
      const tgt = g("pro-tgt");
      const status = g("pro-expiry-status");
      const anc = g("pro-anc");
      const live = g("pro-live-price");
      const matrix = g("neural-matrix");
      const panelPrice = g("right-rail");
      // Chart HUD overlay: the sibling container of hud-target-slot.
      const hudSlot = g("hud-target-slot");
      let hudOverlay = null;
      if (hudSlot) {
        const box = hudSlot.closest("div.pointer-events-none");
        hudOverlay = box ? box.innerText.replace(/\s+/g, " ").trim() : hudSlot.parentElement?.innerText.replace(/\s+/g, " ").trim();
      }
      // TradingPanel (right rail): PRIX (the "$…" display next to PRICE) +
      // the AI Signal Badge, locale-independent (label may be localized).
      let panelPriceText = null, panelBadge = null, panelStale = false, panelButtons = null;
      const rail = g("right-rail");
      if (rail) {
        const dollars = [...rail.querySelectorAll("span, div")].find(
          (s) => /^\$\d/.test(s.textContent.trim()) && s.textContent.trim().length < 30,
        );
        panelPriceText = dollars ? dollars.textContent.trim() : null;
        const badge = [...rail.querySelectorAll("div")].find(
          (d) => d.className.includes("rounded-xl") && /(CALL|PUT|Connecting|Waiting|Quick Trade)/i.test(d.textContent),
        );
        if (badge) {
          const bt = badge.textContent.trim();
          panelBadge = /CALL/i.test(bt) && !/Connecting/i.test(bt) ? "CALL"
            : /PUT/i.test(bt) && !/Connecting/i.test(bt) ? "PUT"
            : /Connecting|Waiting/i.test(bt) ? "WAITING"
            : bt.slice(0, 24);
          panelStale = /Connecting|Waiting/i.test(bt);
        }
        const callBtn = rail.querySelector('[data-testid="action-call"]');
        const putBtn = rail.querySelector('[data-testid="action-put"]');
        panelButtons = {
          call: callBtn ? { text: callBtn.textContent.trim().slice(0, 24), pressed: callBtn.getAttribute("aria-pressed") } : null,
          put: putBtn ? { text: putBtn.textContent.trim().slice(0, 24), pressed: putBtn.getAttribute("aria-pressed") } : null,
        };
      }
      // Rail SignalWidget for this symbol (Execution Price + stale marker).
      let railPrice = null, railStale = false;
      const railCard = [...document.querySelectorAll("div")].find(
        (d) => d.textContent?.includes("Execution Price") && /^[A-Z]{3}\/[A-Z]{3}/.test(d.textContent.trim() || "") && d.querySelector('[data-testid="rail-stale-marker"]'),
      );
      if (railCard) {
        const pending = [...railCard.querySelectorAll("span, p")].map((e) => e.textContent.trim()).filter(Boolean);
        railStale = !!railCard.querySelector('[data-testid="rail-stale-marker"]');
        const eco = pending.find((t) => /^\$\d/.test(t));
        railPrice = eco ? parsePriceText(eco) : null;
      }
      // Expiry option too-late flags + active.
      const opts = {};
      for (const o of ["1m", "2m", "3m", "5m", "10m"]) {
        const el = g(`pro-expiry-${o}`);
        if (el) opts[o] = { tooLate: el.getAttribute("data-too-late") === "true", active: el.getAttribute("aria-pressed") === "true" };
      }
      const matrixVerdict = matrix?.textContent?.match(/HOLD|BUY|SELL/)?.[0] ?? null;
      return {
        tgt: tgt ? { state: tgt.getAttribute("data-state"), reason: tgt.getAttribute("data-reason"), detail: tgt.getAttribute("data-detail"), text: tgt.textContent.trim() } : null,
        status: status ? status.getAttribute("data-reason") : null,
        anc: anc?.textContent.trim() ?? null,
        live: live?.textContent.trim() ?? null,
        matrixVerdict,
        hudOverlay,
        panelPriceText, panelBadge, panelStale,
        railPrice, railStale,
        opts,
      };
    });
    const liveNum = parsePriceText(dom.live);
    const ancNum = parsePriceText(dom.anc);
    const panelNum = parsePriceText(dom.panelPriceText);
    const qPrice = qr?.price != null ? Number(qr.price) : null;
    const liveTol = Math.max(tolFor(digits, qPrice), 0.00005); // pro renders toFixed(4)
    rows.push({
      expiry: label,
      settled: st.settled,
      settle_ms: st.ms,
      price: {
        quote: qPrice,
        quoteAgeMs: qr?.ageMs ?? null,
        live: liveNum,
        anc: ancNum,
        panel: panelNum,
        rail: dom.railPrice,
        live_ok: within(liveNum, qPrice, liveTol),
        panel_ok: qPrice != null && panelNum != null ? within(panelNum, qPrice, Math.max(tolFor(digits, qPrice), 0.0001)) : (panelNum == null ? null : within(panelNum, qPrice, tolFor(digits, qPrice))),
        rail_ok: within(dom.railPrice, qPrice, Math.max(tolFor(digits, qPrice), 0.00005)),
        tol_live: liveTol,
        tol: tolFor(digits, qPrice),
        digits,
        quoteStale: qr?.stale ?? null,
      },
      target: dom.tgt,
      status_reason: dom.status,
      matrix_verdict: dom.matrixVerdict,
      hud: dom.hudOverlay,
      panel: { priceText: dom.panelPriceText, badge: dom.panelBadge, stale: dom.panelStale, buttons: dom.panelButtons },
      rail_stale: dom.railStale,
      expire: dom.opts,
    }); 
  }
  return rows;
}

async function blotterPass(page, sym) {
  await page.goto(TERM_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  try {
    await page.waitForSelector('[data-testid="asset-card"]', { timeout: 60_000 });
  } catch {
    return { error: "no asset-card rendered" };
  }
  // Wait for THIS card to land a real price (the first WS quote may lag the
  // grid's initial paint, which renders the price seat as "--").
  const waited = await page.waitForFunction(
    (s) => {
      for (const c of document.querySelectorAll('[data-testid="asset-card"]')) {
        const h = c.querySelector("h4");
        if (h && (h.textContent || "").trim().toUpperCase() === s) {
          const price = c.querySelector(".num-fig");
          return price && /^[\d.]{4,}$/.test(price.textContent.trim());
        }
      }
      return false;
    },
    sym,
    { timeout: 45_000 },
  ).then(() => true).catch(() => false);

  const direct = await page.evaluate((s) => {
    for (const c of document.querySelectorAll('[data-testid="asset-card"]')) {
      const h = c.querySelector("h4");
      if (h && (h.textContent || "").trim().toUpperCase() === s) {
        const slot = c.querySelector('[data-testid="card-target-slot"]');
        const prov = c.querySelector('[data-testid="quote-provenance"]');
        const price = [...c.querySelectorAll(".num-fig")].find(
          (p) => /^[\d.]{4,}$/.test(p.textContent.trim()) && p.className.includes("\\[16px\\]") || (p.textContent.trim().length > 3 && /^[\d.]{4,}$/.test(p.textContent.trim())),
        );
        // Live verdict direction on the card (CALL/PUT/WAITING badges).
        const chip = [...c.querySelectorAll("span.inline-flex")].map((s) => s.textContent.trim()).find((t) => /^(CALL|PUT|WAITING)$/.test(t)) ?? null;
        return {
          price: price?.textContent.trim() ?? null,
          provenance: prov ? { label: prov.textContent.trim(), title: prov.getAttribute("title") ?? "" } : null,
          chip,
          target: slot ? {
            state: slot.getAttribute("data-state"),
            reason: slot.getAttribute("data-reason"),
            detail: slot.getAttribute("data-detail"),
            text: slot.textContent.replace(/\s+/g, " ").trim(),
          } : null,
          text: c.textContent.replace(/\s+/g, " ").trim().slice(0, 320),
        };
      }
    }
    return null;
  }, sym);
  return { cards: await page.evaluate(() => document.querySelectorAll('[data-testid="asset-card"]').length), waited, card: direct };
}

export default async function run(page) {
  if (RECONCILE.length) {
    // Reconciliation mode: re-read the listed symbols FRESH (pro pass ×5 +
    // blotter), append to tier-a-reconcile.jsonl, and DO NOT advance the main
    // sweep state. Paired with a single-predict API call per cell so a drawn
    // target can be evidenced DOM+API at the same timestamp.
    const q0 = await quotes().catch((e) => ({ error: String(e) }));
    const out = [];
    for (const sym of RECONCILE) {
      try {
        const q = q0.bySymbol?.[sym] ?? null;
        const pro = await proPass(page, sym, q);
      const blot = await blotterPass(page, sym);
      const apiCells = [];
      for (const c of pro) {
        const m = c.expiry.match(/^(\d+)m$/);
        if (!m) { apiCells.push({ expiry: c.expiry, error: "no numeric expiry" }); continue; }
        let apiRow = null;
        for (const tf of ["1m", "2m", "3m", "5m", "10m"]) {
          if (Number(m[1]) !== Number(tf.replace("m", ""))) continue;
          try {
            const r = await fetch(`${BASE}/predict`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ symbol: sym, timeframe: "1m", expiry: tf, silent: true }),
              signal: AbortSignal.timeout(45_000),
            });
            if (!r.ok) { apiCells.push({ expiry: tf, http: r.status }); continue; }
            const j = await r.json();
            apiRow = {
              tech: j.tech, verdict: j.verdict, regime: j.regime, executable: j.executable,
              tier: j.tier, target_price: j.target_price,
              too_late: j.too_late, suppressed: j.suppressed,
              reason: j.reason ?? (j.regime === "closed" ? "gated" : null),
              ts: j.timestamp ?? j.signal_time ?? null,
            };
            break;
          } catch (e) {
            apiCells.push({ expiry: tf, error: String(e).slice(0, 80) });
          }
        }
        apiCells.push({ expiry: c.expiry, api: apiRow });
      }
      appendFileSync(ROWS2, JSON.stringify({
        ts: new Date().toISOString(), symbol: sym, pro, blotter: blot, apiCells,
      }) + "\n");
        const drawn = pro.filter((p) => p.target?.state === "target").length;
        out.push({
          symbol: sym, proCells: pro.length, cardPrice: blot.card?.price ?? null,
          drawnInPro: drawn, apiDrawn: apiCells.map((a) => ({ e: a.expiry, d: a.api?.executable === true && a.api?.regime === "tradable" ? "drawn" : a.api?.http ?? a.api?.error ?? "withheld" })),
        });
      } catch (e) {
        out.push({ symbol: sym, error: String(e).slice(0, 200) });
      }
    }
    return { mode: "reconcile", processed: RECONCILE.length, rows: out };
  }

  // Bootstrap state from the authoritative symbol list on first run.
  if (!existsSync(STATE)) {
    state.idx = 0;
    state.symbols = await fetchSymbolList();
    writeFileSync(STATE, JSON.stringify(state));
  }
  const q0 = await quotes().catch((e) => ({ error: String(e) }));
  const out = [];
  const done = [];

  for (let k = 0; k < CHUNK; k++) {
    if (state.idx >= state.symbols.length) break;
    const sym = state.symbols[state.idx];
    const q = q0.bySymbol?.[sym] ?? null;
    const pro = await proPass(page, sym, q);
    const blot = await blotterPass(page, sym);
    const row = {
      ts: new Date().toISOString(),
      symbol: sym,
      quote: q ? { price: q.price, digits: q.digits, ageMs: q.ageMs, tickCount: q.tickCount, source: q.source, stale: q.stale } : null,
      pro: pro,
      blotter: blot,
    };
    appendFileSync(ROWS, JSON.stringify(row) + "\n");
    out.push({ symbol: sym, proCells: pro.length, blotterCards: blot.cards ?? null, cardPrice: blot.card?.price ?? null });
    done.push(row);
    state.idx += 1;
    writeFileSync(STATE, JSON.stringify(state));
  }

  return {
    processed: done.length,
    remaining: state.symbols.length - state.idx,
    chunk: CHUNK,
    rows: out.map((r) => ({ symbol: r.symbol, proCells: r.proCells, cardPrice: r.cardPrice })),
  };
}