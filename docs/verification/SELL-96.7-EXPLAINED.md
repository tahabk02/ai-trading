# Annotated payload — `SELL 96.7% (2/6)`

Status: **constructed, representative payload** (not a captured live response).
It exists to explain two numbers that are easy to misread. It is **not** a
probability, a prediction record, or verification evidence.

The chart HUD renders `SELL 96.7% (2/6)` at
`client-app/src/components/trading/financial-chart.tsx:1946-1965`, from two
independent fields of the `/predict` response:

- `hudSignal`  = `predictionData.signal`            → the `SELL`
- `hudConf`    = `predictionData.confidence`        → the `96.7`
- `hudBooks`   = `predictionData.book_agreement_detail` → the `(2/6)`

The `%` sign attaches to `confidence`/`book_agreement`, which is a **0-100
strategy-book AGREEMENT score**, not a calibrated win probability
(`client-app/src/services/api.ts:90-96`, chart type comment
`financial-chart.tsx:138-140`).

## The payload (subset)

Fixture: `docs/verification/fixtures/prediction-payload-SELL-96.7.json`

```json
{
  "symbol": "EUR/USD",
  "signal": "SELL",
  "confidence": 96.7,
  "book_agreement": 96.7,
  "book_agreement_detail": {
    "convergence_index": 0.9140,
    "alignment": 0.3333,
    "magnitude": 0.7125,
    "aligned_count": 2,
    "active_count": 6,
    "label": "2/6 books aligned"
  },
  "market_waiting": false
}
```

## What each number is

### `96.7` — the confluence score (`confidence` == `book_agreement`)

On the fast live-quant path the response sets both fields to the same value:

- `ai-engine/app/api/v1/signals.py:1276-1277`
  (`"confidence": verdict.confidence`, `"book_agreement": round(verdict.confidence, 2)`).

That value is a **sigmoid of the convergence index**, clipped to 0-100:

- `ai-engine/app/services/book_instruments.py:1095-1100`
  (`score = 100 / (1 + exp(-k * (conv - midpoint)))`, clipped to `[0, 100]`).

It measures how strongly the active strategy books converge — it does **not**
estimate the chance the trade wins. A saturated sigmoid can approach 100 on a
strong convergence index even when only a few books are active, which is exactly
why the honest `(n/n)` label is rendered next to it.

### `(2/6)` — `aligned_count` / `active_count`

Built by `book_agreement_detail()` (`ai-engine/app/services/book_instruments.py:1127-1144`)
from the confluence internals:

- `active_count` = number of strategy books with **real (non-zero) data** for
  this tape (`book_instruments.py:1112,1122`, `active_count` = `len(active_keys)`).
- `aligned_count` = of those active books, how many agree with the arbitrated
  direction (`book_instruments.py:1123`).
- `label` is literally `f"{aligned}/{active} books aligned"`.

So `2/6` reads: **6 books had live data; 2 of them agreed with the SELL.**
This is the honest counterweight to the `96.7` — same payload, two views of the
same confluence.

## Non-claims (explicit)

- `96.7%` is **not** a win probability and **not** calibrated accuracy. It is a
  book-agreement score.
- `(2/6)` is **not** a confidence interval; it is `aligned/active` book counts.
- This fixture is constructed for explanation. No live `/predict` response was
  captured; nothing here is cited as verification evidence.

## Same numbers, other surfaces

- `client-app/src/components/trading/signal-widget.tsx:169-170`
- `client-app/src/components/trading/ai-explanation.tsx:102-103`
- `client-app/src/components/trading/predictive-intelligence.tsx:123-124`
