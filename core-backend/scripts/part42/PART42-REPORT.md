# PART 42 — SYMBOL × TIME VERIFICATION MATRIX  [414]–[419]

Owner review [414]Header. Verified the terminal the way it renders live, and the engine the way it answers live, for every symbol × horizon the product claims to support. The matrix measures **honesty and completeness of what the gates produce** — never signal correctness.

## [418] Verdict taxonomy (used for every cell below)

- **OK-real** — a target/signal is drawn, all surfaces agree, and nothing is gated against the drawn cell.
- **OK-withheld+reason** — no target/signal, and the surfaces state *why* (engine sub-reason rendered verbatim: `pending_high_precision`, `OTC_HF_FAIL`, `NO_BID_ASK_QUOTES`, `MTF_MISALIGNED`, `regime_review`, `no_tier`, `too_late`). Closed gate still carrying an internal target is **withheld+reason**, not a contradiction.
- **N/A+reason** — market gate / engine refused this window with a recorded reason (503 awaiting bars, no data source, nav error).
- **FAIL** — blank without a reason, wrong-symbol price, stale shown as live, target drawn while the same-time gate is closed, or surfaces disagreeing **at one timestamp** (minutes-apart drift is attributed via timestamps, never FAIL).

## Environment (captured during the run)

| | |
|---|---|
| Build | Alpha.5 Pro — Live Trading Terminal, page title `Alpha.5 Pro`, `EN FR AR` |
| Ports | :8000 engine (PID 11572, single listener) · :4000 backend (PID 25508) · :3000 client (PID 20584) |
| Feed | `github_repo_cached` snapshot tape (blotter provenance `GITHUB`); stale frames honestly labelled `HELD`/`held_stale_real` |
| Anchors | 42 quotes via `/api/v1/quotes` (BTC/ETH excluded); 44 symbols via `/api/v1/symbols?limit=1000` |
| Currency | Fri 2026-10-09 → Sat 2026-10-10 UTC, PO forex open |

## [416] Tier B — WS candle contract, 44 symbols × 16 timeframes = 704 cells

**700 OK-real · 4 N/A · 0 FAIL.** The 4 N/A are BTC/ETH at S5/S10/S30 — the history collector has no bars for crypto at sub-minute resolutions; recorded reason on both attempts.

## [415] Tier A — gate × surfaces, 44 symbols × 5 expiries (1m/2m/3m/5m/10m)

### API half — 220 cells
**19 OK-real · 197 OK-withheld+reason · 4 N/A · 0 FAIL.** The 4 N/A are BTC/USD ×2 and ETH/USD ×2 (engine 503 on both attempts while the 1m bar history was still building — legitimate `N/A+reason`).

- **Drawn cells existed** (early window, engine in a traded phase), by horizon: 1m×1, 2m×5, 3m×6, 5m×5, 10m×2. Symbol-level attribution survives for six of them from the sweep run log + later reconcile: **EUR/TRY 1m, EUR/CAD 3m+5m, EUR/CHF 3m+5m, EUR/GBP 5m** (each T1, `regime=tradable`, `executable=true`, target_price present).
- ⚠️ JSONL caveat: 216/220 rows predate a symbol-column fix (`tier-a-api.mjs:63` — the engine's `multiPredict` rows don't echo the symbol). **Counts are authoritative; the file is not symbol-joinable for those 216 rows.** Runner patched so future sweeps emit `symbol`; per-symbol identity is restored by `tier-a-reconcile.jsonl` (below).

### DOM half — 264 reads (220 pro cells + 44 blotter cards)
**264 OK-withheld+reason · 0 FAIL · 0 drawn.**

- The gate was closed for the **entire** DOM window (engine steady state = `no_tier` / `regime_review` / `pending_high_precision`). Every withdrawn cell renders a reason — **zero blank cells**, so no silent gate can hide behind the UI.
- Engine sub-reasons surfaced verbatim across HUD, target slot and blotter card: `OTC_HF_FAIL`, `NO_BID_ASK_QUOTES`, `SPREAD_PROXY_INSUFFICIENT_ATR`, `MTF_MISALIGNED`, `pending_high_precision`, `awaiting_payload`.
- **Price honesty:** live and panel surfaces matched the per-cell `/quotes` sample within display tolerance on every readable cell (incl. the boundary case 55.2355 vs 55.23545 = exactly one 4-dp unit). Where the WS tape held an older print it was labelled honestly: EUR/CHF `0.93130 HELD 1048s` on the blotter vs REST 0.932807 — provenance rendered, never stale-as-live. Stale crypto frames (`held_stale_real`) show the `WAITING` badge on the trading panel, never a phantom CALL/PUT.
- Engine anchor (`ANC`) is a distinct surface (sampled at evaluation time) and legitimately differs from the live line — excluded from live-price agreement, documented as such.

### Reconcile — the drawn path, DOM↔API in-sync (4 gate-open-capable symbols)
Engine idle → re-read EUR/TRY, EUR/CAD, EUR/CHF, EUR/GBP at all 5 expiries with a same-symbol single `/predict` per cell:

- **DOM 20/20 withheld** (`regime_review`/`awaiting_payload`), **API 20/20 withheld** in agreement at the same timestamps, blotter 4/4 withheld. `no_tier` across the board — engine and surfaces agree the door is closed right now.
- No cell drew during the reconcile window, so in-sync **drawn-target** DOM+API evidence remains ungathered; the 19 drawn cells are proven by the earlier API sweep only (run-log attribution above).

## [417] Tier C — visual, 6 symbols × S30/M1/H1
**NOT RUN.** Selection plan (unexecuted): 1 OTC-in-bridge (needs PO session), 1 OTC-outside, 1 REAL forex, 1 CRYPTO, 1 gated, 1 tradable-if-any; screenshot + DOM readout per (symbol,timeframe).

## [419] One-table result — 1 188 observed cells, **0 FAIL**

| Tier | Cells | OK-real | OK-withheld+reason | N/A+reason | FAIL |
|---|---|---|---|---|---|
| B (WS candles) | 704 | 700 | 0 | 4 | **0** |
| A API (gate) | 220 | 19 | 197 | 4 | **0** |
| A DOM (surfaces) | 264 | 0 | 264 | 0 | **0** |
| **Total** | **1188** | **719** | **461** | **8** | **0** |

**FAIL list: EMPTY.** No wrong-symbol price, no blank-without-reason, no stale-as-live, no target on a closed gate, no same-timestamp surface disagreement in Tier A or Tier B.

## Headline findings

1. The gate's steady state is **fully suppressed** — the engine currently never reaches `tradable` (always `no_tier`/`pending_high_precision`). That is honest (the platform produces zero executable signals, and says so with a reason on every surface), but it is a product fact beyond the matrix: signal draw today is 0/20 on the gate-open-capable path.
2. Where the tape is stale it is **labelled**, never masqueraded: `HELD`, `held_stale_real`, provenance titles, `WAITING` badges.
3. Cross-window drift (API drew at T, DOM saw `no_tier` at T+Δt) is **attributed by timestamp**, not FAIL — the gate re-verdicts as the tape moves; both states are true at their moments.

## Limits / residuals
- PO-forward (“OTC-in-bridge”) and real-tick halves of prior sections still blocked on a **fresh human login** → `capture_session.py --wait N`; without it, 0 composed PO heartbeats.
- Engine contention: `multiPredict` starves the shared tape collector (503 `awaiting live market data`). Always batch ≤8 symbols, 3–5s gaps; the API sweep needed two attempts on some horizons.
- Crypto: no `/quotes` metadata (grid price comes from the WS store), no S5/S10/S30 bars → N/A on those cells.
- JSONL symbol-column caveat on 216 API rows (counts unaffected; runner fixed).

## Harness (repeatable)
Raw data + verdicts: `tier-a.jsonl` (API, 220), `tier-a-dom.jsonl` (DOM, 44 rows = 264 reads), `tier-a-dom-verdicts.json`, `tier-a-reconcile.jsonl`, `tier-b.jsonl` (704). Scripts: `tier-a-api.mjs`, `tier-a-dom.mjs` (CHUNK env, resumable state), `tier-a-reconcile` mode, `tier-a-analyze.mjs`, `tier-b.mjs`, `part42.conf.mjs`. Re-run: `node …/browser.mjs --session part42a --script tier-a-dom.mjs` (DOM), `node tier-a-api.mjs` (API).