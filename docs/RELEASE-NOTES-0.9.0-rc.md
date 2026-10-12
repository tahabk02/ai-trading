# Release Notes — Trading AI Platform 0.9.0-rc

Candidate release. This document (**item `[500]`**) is the PART → commit ledger
for everything built on top of the regime-detector base commit `bf264b6`,
through the last code commit `3014650` (2026-10-11).

- Base commit (included): `bf264b6` — the PART 42 regime/honesty foundation.
- Range covered: `bf264b6..3014650` (all code). The doc/test items `[500]/[501]`
  land in the commit after that range.
- Branch: `feat/regime-detector` (remote `origin`).
- Every PART tag in this range is listed below with its commit, items and the
  verification that was recorded when it landed.

> **Empirical (measured) over theoretical.** Where a number is stated it was
> observed on this machine (tests run, live DB query, or browser probe). Where a
> claim is not yet proven end-to-end it is listed under *Known open items*.

## PART → commit ledger

| PART | Items | Commit | Date | Summary |
| --- | --- | --- | --- | --- |
| PART 42 (base) | `[401-425]` | `bf264b6` | 2026-10-10 | Regime detector, honesty gates, signal lock, OTC/HF quality, execution audit + PART 42 test battery. |
| PART 42 | `[398-425]` | `ec8e367` | 2026-10-10 | Backend verification harness, alert gate + engine circuit breaker, market schedule, loopback metadata, honesty surfaces. |
| PART 42 | `[387-425]` | `d32aae3` | 2026-10-10 | Client honest surface readout, target/alert toast gate, quote provenance, PART 42 DOM contract. |
| PART 40–42 | — | `96d458e` | 2026-10-10 | Infra: PO bridge session rotation + connect handshake, exec-engine Docker, stack health/restart scripts, PART 40–42 docs. |
| (client fix) | — | `af6802f` | 2026-10-10 | `quoteProvenance` accepts `Partial<MarketQuote>` payloads (DOM provenance reads the BOM quote subset). |
| (tooling) | — | `3293625` | 2026-10-10 | Next 14.2.3 → 15.5.27 + React 18 → 19; `next.config.js` tracing-root fix. |
| PART 42.1 | `[420-423]` | `0ebe539` | 2026-10-10 | Market-closed is a first-class state, not an error loop; day-independent tests + TODO write-up. |
| (client fix) | `[431][433]` | `afeb663` | 2026-10-10 | Next 15 custom-server `prepare` + security headers/CSP; smoke-test fairness. |
| (engine health) | `[432]` | `272eb30` | 2026-10-10 | Warm-start health contract — degraded is `200`, never `503` (test). |
| (deps) | `[435]` | `02532e2` | 2026-10-10 | Client audit fixes — `lucide-react` 0.475 (React 19 peer), non-breaking `npm audit fix`, harness timeout. |
| (deps) | `[435]` | `b0c12dd` | 2026-10-10 | Pin `urllib3>=2.8.0` + `pip>=26.2.0`; core-backend non-breaking audit fix. |
| (engine health) | `[432]` | `f31761a` | 2026-10-10 | Liveness/readiness split — `/health/live` (always 200) vs `/health/ready` (200 only when warm). |
| PART 43.4 | `[469]-[471]` | `6442ba6` | 2026-10-10 | No-session state is honest + quiet: OTC-on-proxy = PO OFFLINE, `/predict` awaiting-tick 503 handled, `content.js` proven to be a browser extension. |
| PART 43.5 | `[472]-[476]` | `08c54dd` | 2026-10-10 | A proxy tick is not “live”: OTC liveness decided solely from PO-sourced prints (backend gate + client HUD/verdict/target withholding). |
| PART 43.6 | (self-healing) | `77366a9` | 2026-10-11 | PO SSID self-healing — opt-in credential-login last-resort + `/health/po-auth`. |
| PART 43.6 | — | `4f0f599` | 2026-10-11 | Hosted session continuity — auth audit, circuit breaker + backoff, captcha/2FA interlock, secrets-from-file, session alerts, runbook. |
| PART 43.7 | `[486]-[489]` | `5370c03` | 2026-10-11 | Fail-closed hosted po-auth guard; ToS relabel; single external alert webhook sink; execution-engine behind an off-by-default compose profile. |
| PART 44 | `[455]/[456]` | `698107e` | 2026-10-11 | Unified execution envelope (`ExecutionResponse<T>`) + execution audit log store & route. |
| PART 44 | `[494]-[497]` | `8972763` | 2026-10-11 | Data provenance all the way down — OTC provenance gate, read-only audit CLI, provenance-gated recovery status, OTC-scoped feed-state logging. |
| PART 44 | `[498][499]` | `3014650` | 2026-10-11 | Bridge connection-init diagnostics (exception class / regional URLs / rotation) + account-uid masking in logs. |

## What each PART changed (detail)

### PART 42 / 42.1 — regime + honesty foundation (base `bf264b6`)
Strict execution gate `[402/418]`, no-force-emit escape, tier-coherence clamp;
OTC/real HF quality + crypto HF quality classifiers and sanitization; single
signal lock; market strategies; inference budget/saturation `503`; warm-start
`/health` contract; exact CORS allowlist + env isolation; flexible tiers,
min-confidence filter, model-cache window. PART 42.1 made the weekly forex close
a first-class *state* (`marketSchedule`, New York clock, REAL pairs only).

### PART 43.4 — no-session honesty `[469]-[471]`
`isPoOfflineOtc()` + dimmed price / `PO OFFLINE · market proxy` chip; rail +
panel price withholding; `/predict` awaiting-tick `503` treated as a handled
state (5s backoff, no retry storm); `content.js` traced to a browser extension.

### PART 43.5 — OTC “live” = PO-sourced `[472]-[476]`
`/health/ticks` tape dump with per-entry `source`; `resolveQuoteLiveness()` OTC
gate on PO freshness; `tickIngestion` PO-authority guards keyed on
`isPocketOptionActivelyLive()`; client HUD verdict + target withheld when
PO-offline.

### PART 43.6 / 43.7 — hosted session continuity + fail-closed guard
Credentials forwarded to the `refresh_ssid.py` child only; `PO_HEALTH_ADMIN_KEY`
guard on mutating `/health/po-auth/*`; circuit breaker (3 failed logins → open +
human reset) with 60s/2x/30min backoff; captcha/2FA interlock; secrets from
mounted files; `PO_TOS_CONSENT` gate; session monitor + one-shot alerts;
execution-engine behind an off-by-default `execution` compose profile.

### PART 44 — data + execution provenance `[455]…[499]`
- `[455]/[456]` (exec): `ExecutionResponse<T>` contract + execution audit log
  (`GET /api/v1/audit/execution-logs`); wired through `POST /trades` and
  `POST /signals/receive` with validation `400` / kill-switch `423` / dry-run
  `200` / success `201`·`200`.
- `[494]` (data): `AssetHistory.source` + index (`migration 20261011000000`);
  OTC bars authored ONLY by PO-sourced, non-stale ticks; provenance carried by
  `buildMinuteBars`, never erased by an unstamped tick.
- `[495]`: pure read-only provenance audit + `npm run audit:history` CLI;
  `--apply` requires `--mode quarantine|delete` **and** `--backup`; unstamped
  OTC rows are reported but never auto-deleted.
- `[496]`: `restoredFeedStatus()` — an OTC pair reads ONLINE on recovery ONLY
  from a genuine PO source.
- `[497]`: `feedStateLog` — one line per per-symbol state transition + a guarded
  60s summary; expected PO-offline/holding/market-closed states are INFO, real
  failures ERROR; the downgrade is **OTC-scoped** (a REAL pair stays ERROR).
- `[498]`: bridge `_ensure_connected` failure logs carry exception class,
  regional WS URL list and rotation flag; runbook §6.
- `[499]`: `mask_uid()` reveals only a prefix; wired into every site that printed
  the raw account uid.

## Verification recorded at HEAD

| Surface | Command | Result |
| --- | --- | --- |
| core-backend types | `npx tsc --noEmit` | clean (exit 0) |
| core-backend tests | `npx vitest run` | **51 files / 459 tests passed** |
| pocket-bridge tests | targeted pytest subset | **114 passed** (excludes the pre-existing `test_asset_resolution.py` stall and live-only `test_auth_live.py`) |
| `[495]` audit (live dev DB) | `npm run audit:history` | 45 symbols / 424,380 bars / 334,794 OTC / 307 PO-sourced / **0 non-PO faults** / 334,508 unstamped OTC (legacy) |

## Known open items (tracked in `TODO.md`, not blockers for the RC)

- **pocket-bridge `test_asset_resolution.py`** stalls ~75–105s in
  `_ensure_connected` (test-shape fault; seed `_assets_ready` to fix). Full
  pocket-bridge suite cannot run cleanly until then.
- **`[491]`** — the po-auth guard has only an in-process test; an external
  through-the-compose-stack guard probe is still owed.
- **`[492]`** — `app.set("trust proxy", 1)` is hard-coded; should be a
  configurable trusted-hop count.
- `[391]` candle-history depth, W1/MN1 calendar parity, and the PART 23/32.5a
  follow-ups remain queued in `TODO.md`.

## Numbering note

`[455]/[456]` are the **execution envelope + audit log** items in PART 44
(`698107e`). The “pre-rc docs” deliverable is therefore numbered from the next
free slot to avoid colliding with those committed items:

- `[500]` — this release-notes document.
- `[501]` — the HF/MTF quality gate reference (`docs/quality-gates-hf-mtf.md`)
  and its proof test (`ai-engine/tests/test_hf_mtf_gate_cannot_override_regime.py`).
