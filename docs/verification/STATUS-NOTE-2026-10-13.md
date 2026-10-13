# NOT A VERIFICATION

This file is **not** an E2E verification report. It records only what was
run and observed on 2026-10-13. No end-to-end consistency verification was
performed: the `verify-e2e` harness did not exist at the time, replay
fixtures were never captured from a live feed, and no mutation battery was
executed. Nothing here should be cited as evidence of correctness.

A real verification report has since been produced: `npm run verify:e2e` (PART 47
[525]) now runs the offline replay + independent candle oracle + 11-mutation
harness and writes `docs/verification/E2E-REPORT-<sha>.md` (+ `.json`). The report
for the harness commit is `E2E-REPORT-cfc9595.md` — verdict **OK** (11 pass,
4 N/A, 0 fail; 11/11 mutations caught). That file, not this note, is the evidence.

## Update (2026-10-13, same day)

- PART 47 [525] offline harness **built and green**: `npm run verify:e2e` →
  `E2E-REPORT-cfc9595.md` / `.json`.
- PART 46 [517] (chart ENTRY marker/band + withheld readout) **deferred** with a
  precise entry in `TODO.md` (no PART 46 spec text exists in the repo; not
  implemented blind).
- PART 46 [512] annotated payload: `docs/verification/SELL-96.7-EXPLAINED.md`
  (constructed, not captured) + `docs/verification/fixtures/`.
- PART 46 [524] policy: `docs/DATA-PROVENANCE-POLICY.md` — corrects the earlier
  "2,941 non-PO OTC bars" framing (`otc_proxy_faults=0`; those bars are
  non-OTC) and records filter-never-delete.

## What was actually run (in-place, no harness)

- Commit under test: `ee1936c` (working tree; `v0.9.0-rc.1` == `ea05b89`).
- Timestamp: 2026-10-13 (local), timezone: Morocco Standard Time.
- Unit suites: core-backend (470), client-app (827), ai-engine key tests (20) pass; `tsc --noEmit` clean.
- Data provenance audit (`scripts/audit-asset-history.ts`):
  `symbols=45 bars=438603 otc=345266 po_sourced=3581 non_po=2941 unstamped=432081 flat=260371 otc_proxy_faults=0`.
- PO session state: N/A (not run live).
- Per-symbol tick sources / market state / clock offset: N/A (no live capture).

## PART 47 [516] clean-checkout verification

Method: `git worktree add` of branch tip `f995e56` into a temp dir (committed
tree only, no local modifications), with `core-backend/node_modules` linked so no
reinstall was required.

- `npx tsc --noEmit` (core-backend): **clean** (exit 0).
- `npm run verify:e2e`: **verdict OK** (11 pass, 4 N/A, 0 fail; 11/11 mutations
  caught) → `E2E-REPORT-f995e56.md` / `.json`.
- `npm test` (core-backend vitest): 48 files / 462 tests pass, **4 files fail**
  (466 collected):
  - `src/lib/__tests__/envIsolation.test.ts` (4 assertions) — expects a real
    `core-backend/.env` to resolve service-local config.
  - `src/lib/__tests__/audit.routes.test.ts`, `flushSafety.live.test.ts`,
    `quickfix.test.ts` — fail to start: the boot guard refuses without
    `DATABASE_URL` / a signing key.

Cause: `core-backend/.env` is gitignored (only `.env.example` /
`.env.prod.example` are tracked), so these suites cannot run from a clean
checkout. This is **pre-existing** (the affected suites do not touch anything
changed on this branch); in-place (with `.env`) the suite is 52 files / **474
pass**. Tracked as a follow-up (see `TODO.md`), not fixed here.

Verdict: the branch's changed surface (harness, [514] dry-run, docs) reproduces
cleanly from a pristine tree; the only clean-checkout failures are the
pre-existing env-dependent suites.

## Open (carried forward)

- [491], [492], [482] known gaps.
- Clean-checkout env dependency for `envIsolation` / boot-guard suites (new).

No tag `v0.9.0-rc.2` was validly released; the previous rc.2 tag was
mis-pointed and has been deleted ([521]).
