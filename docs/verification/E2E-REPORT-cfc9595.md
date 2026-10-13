# E2E Verification Report — cfc9595

- Generated: 2026-10-13T09:42:23.988Z
- Branch: `part46-47-verification`
- Verdict: **OK**
- Harness: `core-backend/scripts/verify-e2e` (offline, deterministic, no network/DB/browser)
- Node: v22.17.0
- Code under test: `core-backend/src/services/realtimeCandleAggregator.service.ts`
- Fixtures (disk): 8 symbols (otc=4, real=2, crypto=2), 32 min each, 15368 ticks total
- Broker clock anchor: 1788222720000 ms (fixture-authoritative)

## Baseline checks

| id | check | status | message |
| --- | --- | --- | --- |
| C1 | Candle exactness (server vs independent oracle, all 16 TFs) | PASS | all 128 (symbol,timeframe) cells match bar-for-bar (timestamps + OHLCV) |
| C2 | OHLC invariants (finite, high>=max(o,c), low<=min(o,c)) | PASS | all 6704 bars structurally valid |
| C3 | Slot geometry (strictly increasing, unique, grid-aligned) | PASS | every series is monotonic, unique and grid-aligned |
| C4 | Rollup (M5 == strict fold of M1) | PASS | M5 reproduces the strict M1 fold for EUR/USD (6 closed bars) |
| C5 | OTC source purity (no proxy tick in an OTC book) | PASS | all 7684 OTC ticks carry pocket_option_ws provenance |
| C6 | Time anchoring (product expiry == last ceil-projection slot) | PASS | all 20 product expiry slots match the oracle's last projection slot |
| C7 | Clock coherence (slots anchored to broker clock, not Date.now) | PASS | every series' newest closed bucket is anchored to brokerNow=1788222720000 |
| C8 | Target geometry (product ladder == oracle, contiguous, first=tip+tf) | PASS | all 20 product ladders match the oracle slot-for-slot |
| C9 | Timer entry/expiry (product expiry == entry + duration) | PASS | all 4 TIMER durations map entry->expiry exactly |
| C10 | Price linkage + freshness (grid == rail == chart, quote fresh) | PASS | live ticker/grid/rail all report 1.11879; last closed S5 close (1.1188) matches the folded tick stream; quote age=0ms |
| C11 | Settlement logging (post-expiry outcome logged per expiry) | PASS | settlement logged for EUR/USD expiry=1788222660 (entry=1.11622 exit=1.1188 -> WIN) |
| C12 | Live PO session replay (broker websocket) | N/A | not exercised offline |
| C13 | /history HTTP surface (real bars endpoint) | N/A | not exercised offline |
| C14 | DOM-rendered chart series parity | N/A | not exercised offline |
| C15 | SignalOutcome Postgres persistence | N/A | not exercised offline |

## Fault injection (each mutation must FAIL its target)

| id | mutation | targets | caught | explicit failure message |
| --- | --- | --- | --- | --- |
| M1 | Perturb one closed S5 close by +0.0001 | C1 | yes | candle mismatch in 1/128 cells: EUR/USD S5: bar[192] close: server=1.09665 oracle=1.09655 (ts=1788221760000) |
| M2 | Set an M1 high below its close (OHLC violation) | C2 | yes | OHLC violated at EUR/USD M1 ts=1788221100000: o=1.08846 h=0.08579000000000003 l=1.0855 c=1.08579 |
| M3 | Duplicate one S5 slot (breaks monotonic/unique) | C3 | yes | EUR/USD S5: non-monotonic timestamps 1788220900000 -> 1788220900000 |
| M4 | Roll M1->M5 using MEAN high instead of max high | C4 | yes | M5 rollup mismatch for EUR/USD: bar[0] high: server=1.0878799999999997 oracle=1.09054 (ts=1788220800000) |
| M5 | Inject a proxy-sourced tick into an OTC book | C5 | yes | proxy tick in OTC book EUR/USD at ts=1788222719000: source=github_repo_cached |
| M6 | Shift the product expiry slot by one timeframe (off-by-one) | C6 | yes | product expiry wrong for 5s/60s: got=1788222785 expect=1788222780 (ceil=1788222780) |
| M7 | Anchor slots to wall clock (Date.now) instead of broker clock | C7 | yes | EUR/USD S5: newest closed bucket ts=1788222715000 != broker-anchored 1790814715000 |
| M8 | Insert a gap in a product target ladder | C8 | yes | product slot[1] wrong for 60s: got=1788222735 expect=1788222730 |
| M9 | Shift a TIMER entry bucket (expiry != entry + duration) | C9 | yes | product timer expiry wrong for dur=60s: entry=1788222600 expiry=1788222720 expect=1788222660 |
| M10 | Drift the last closed chart close away from the tick stream | C10 | yes | chart close 1.119 != folded tick close 1.1188 for EUR/USD |
| M11 | Drop the post-expiry settlement record | C11 | yes | no settlement record for EUR/USD at expiry bucket 1788222660 |

## N/A cells (unavailable offline — NOT passes)

| id | check | reason |
| --- | --- | --- |
| C12 | Live PO session replay (broker websocket) | requires live Pocket Option credentials + the broker websocket; the harness replays captured ticks instead of connecting |
| C13 | /history HTTP surface (real bars endpoint) | requires a running core-backend with a database and a live PO session; not available offline |
| C14 | DOM-rendered chart series parity | requires a browser + live streamed data; the harness compares the aggregation layer, not the React-rendered series |
| C15 | SignalOutcome Postgres persistence | requires a Postgres instance and Prisma client; the harness validates the pure settlement derivation only (C11) |

## Scope and limitations

- Exercised offline: server aggregator vs an INDEPENDENT oracle across all 16 timeframes and all fixture symbols; OHLC invariants; slot geometry; M5 rollup; OTC source purity; product expiry/target/TIMER slot math vs the oracle; broker-clock anchoring; price linkage + quote freshness; settlement derivation.
- NOT exercised (see N/A reasons): a live Pocket Option session, the `/history` HTTP surface, the DOM-rendered chart series, and Postgres persistence of `SignalOutcome` rows.
- This report describes candle/time/settlement correctness from replayed ticks only. It is not a brokerage or financial-advice statement.
