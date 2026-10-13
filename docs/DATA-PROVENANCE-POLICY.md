# AssetHistory data-provenance policy — [524]

Scope: how persisted `AssetHistory` bars are classified, which rows downstream
consumers may trust, and why the answer is **filter, never delete**.

Source of truth for the numbers below:
`core-backend/src/lib/assetHistoryAudit.ts` (pure) + `core-backend/scripts/audit-asset-history.ts` (CLI).

## 0. Corrections of record

Two statements in the 2026-10-13 working notes were wrong; this file replaces
them.

1. **There are zero non-PO OTC bars.** The audit prints
   `otc_proxy_faults=0`. The `non_po=2941` count is *not* OTC — every one of
   those 2,941 bars is on a NON-OTC (real / crypto) symbol, where a non-PO feed
   (Frankfurter / GitHub / coingecko) is legitimate. The earlier framing of
   "2,941 non-PO OTC bars" was incorrect.
2. **"PART 36" is not a data-provenance item.** `PART 36` in `TODO.md:215` is the
   Next.js 14 → 15/16 major bump. Coupling [524] to PART 36 was a
   misattribution.

## 1. The audit numbers, reconciled (2026-10-12 snapshot)

`symbols=45 bars=438603 otc=345266 po_sourced=3581 non_po=2941 unstamped=432081 flat=260371 otc_proxy_faults=0 otc_unstamped=341945`

| metric | value | share | meaning |
| --- | ---: | ---: | --- |
| `bars` | 438,603 | 100% | all persisted rows |
| `otc` | 345,266 | 78.7% | rows whose symbol is an OTC instrument |
| `po_sourced` | 3,581 | 0.8% | `source` names a Pocket Option feed (trusted) |
| `non_po` | 2,941 | 0.7% | `source` names another feed (NOT a fault on real/crypto) |
| `unstamped` | 432,081 | 98.5% | `source` is NULL/empty (legacy pre-[494]) |
| `flat` | 260,371 | 59.4% | `open===high===low===close` |
| `otc_proxy_faults` | **0** | 0% | OTC **and** non-PO → the only actionable corruption class |
| `otc_unstamped` | 341,945 | 99.0% of OTC | OTC legacy rows with no stamp |

Reconciliation:

- `po_sourced + non_po + unstamped = 3581 + 2941 + 432081 = 438603 = bars` ✓
- `otc = otc_unstamped + stamped_otc` → `345266 - 341945 = 3321` stamped OTC bars,
  all PO-sourced (since `otc_proxy_faults = 0`). So OTC PO = 3,321 and the
  remaining 260 PO bars are non-OTC (real/crypto).
- `otc_proxy_faults = 0` ⇒ **no** OTC bar is authored by a non-PO feed.

## 2. Provenance classes (exact predicates)

Implemented in `assetHistoryAudit.ts`:

- **po** — `isPocketOptionSource(source)`: `source` (lower-case, `:live` suffix
  stripped) begins with `pocket_option`. Covers the SSOT tier, held tiers
  (`pocket_option_held`, `pocket_option_last_known`) and the HTTP-live stamp.
  (`core-backend/src/lib/pocketOptionSource.ts`)
- **nonPo** — `source` present, not PO.
- **unstamped** — `source` NULL or empty (rows written before the [494] column).
- **OTC** — `symbolRegistry.getAssetSubType(symbol) === "otc"`.
- **flat** — `open === high === low === close` (exact float equality).

## 3. Why 98.5% is unstamped

The `source` column was introduced in PART 44 [494]. Every row written before it
has `source = NULL` (432,081 rows). This is **ambiguity, not proof of
corruption**: an unstamped OTC row may be genuine old PO tape. Therefore
unstamped OTC rows are reported loudly (`otc_unstamped=341,945`) and are
**never auto-deleted** — deleting them would destroy the only record of that
history.

## 4. Why 59% is flat

A flat bar (`O===H===L===C`) is the classic **stale / hold carrier** signature —
a proxy re-serving one price for a long window. But a genuinely quiet minute on
a thin pair is also flat. Flatness is therefore a **suspect signal, not a
fault**:

- it is tallied, never auto-deleted on its own;
- it must be excluded from **calibration / regime** statistics, where a
  zero-variance bar carries no information and skews variance/ATR-style inputs;
- it may still be **displayed** (the operator should see the raw tape).

## 5. Trust policy — filter, never delete

The rule differs by asset class, so it is applied in the **service layer**
(asset class lives in `symbolRegistry`, not in the table):

| class | trusted iff |
| --- | --- |
| OTC | `isPocketOptionSource(source)` — unstamped OTC and non-PO OTC are **excluded** |
| REAL / CRYPTO | `source IS NOT NULL` — any known feed is acceptable; only unknown (unstamped) is excluded |
| all (calibration / regime) | additionally **not flat** |

- No consumer may read the raw table as authoritative price history. Every
  statistical / inference consumer reads through this filter.
- The raw table is retained in full. Remediation is **re-stamping**, not removal.

## 6. Enforcement points (the read paths today)

Both read paths in `core-backend/src/services/historyCollector.service.ts` are
currently unfiltered by provenance:

- `getAssetHistoryBars` (`:516`) — serves `/history` (consumed by regime / ML
  ingestion).
- `getRecentBars` (`:564`) — the boot backfill into `CandleAggregator`.

**Proposal (tracked, not done in this PR):** add an opt-in `trustedOnly` filter
implementing the table in §5; wire regime / ML / calibration reads to
`trustedOnly: true`; leave display paths unfiltered so raw bars remain visible
with their provenance badge.

## 7. Remediation CLI (default is read-only)

`npm run audit:history` is read-only. Acting on faults requires **both** a
snapshot and an explicit mode:

```
npm run audit:history -- --backup ./faults.json --apply --mode quarantine
npm run audit:history -- --backup ./faults.json --apply --mode delete   # last resort
```

- `quarantine` re-stamps fault rows to `quarantined:<source>` — the rows survive
  but the PO predicate no longer trusts them.
- `delete` requires the backup as the rollback.
- Unstamped OTC rows are **never** auto-deleted by either mode.

Today `otc_proxy_faults = 0`, so `--apply` has nothing to act on.

## 8. Tracked follow-ups

- Persist `asset_class` on `AssetHistory` (or a registry table) so §5 can be a
  pure SQL **VIEW** (`asset_history_trusted`) instead of a service-layer filter.
- Add `trustedOnly` to `getAssetHistoryBars` / `getRecentBars` and route
  regime / ML / calibration ingestion through it.
- Re-run `npm run audit:history --backup` after the next stamping backfill and
  record the delta.
