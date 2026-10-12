# High-Frequency / Multi-Timeframe Quality Gates

PART 44 **[501]**. Reference for the per-asset-class quality filters that sit
in the `executable` conjunction of every `/predict` and `/tick-signal`
response, plus the proof that they can only **veto**, never **release**, a
verdict the regime detector holds back.

Proof test: `ai-engine/tests/test_hf_mtf_gate_cannot_override_regime.py`
(16 tests). Run:

```
cd ai-engine
python -m pytest tests/test_hf_mtf_gate_cannot_override_regime.py -q
```

## 1. Where the gates live

| Gate | Module | Entry point | Fires for |
| --- | --- | --- | --- |
| OTC high-frequency quality | `ai-engine/app/services/otc_hf_quality.py` | `evaluate_otc_hf_quality` | `OTC` |
| REAL liquidity + MTF alignment | `ai-engine/app/services/real_liquidity_gate.py` | `evaluate_real_liquidity_gate` | `REAL` |
| Crypto high-frequency quality | `ai-engine/app/services/crypto_hf_quality.py` | `evaluate_crypto_hf_quality` | `CRYPTO` |
| Dispatch | `ai-engine/app/services/execution_gate.py` | `build_execution_surface` → `market_strategies.resolve_strategy` | all |
| Composition / release | `ai-engine/app/services/signal_gatekeeper.py` | `apply_strict_execution_gate` | all |

Each filter returns a class-gate verdict dict:
`{"passes": bool, "reason": None | str, "score": 0..1, "factors": {...}, "metrics": {...}}`.

## 2. OTC — `otc_hf_fail`

`OTC_HF_PASS_BAR = 0.65`. Four micro-structure factors, weighted:

| Factor | Weight | 1 when |
| --- | --- | --- |
| `micro_momentum` | **0.40** | MACD(5,13,5) histogram and tick velocity both signed with the signal, and acceleration does not oppose it |
| `order_flow` | 0.30 | bid/ask pressure (or tick-position proxy) does not oppose the signal |
| `volatility` | 0.20 | realized `ATR/price` inside `[0.0008, 0.0050]` |
| `mean_reversion` | 0.10 | trailing z-score `|z| < 2.5` (synthetic reverts an over-extended entry) |

`REQUIRED_FACTORS = ["micro_momentum", "volatility", "mean_reversion"]`.

`passes = all(required != 0) AND weighted_score >= 0.65`. Otherwise
`reason = "otc_hf_fail"`. A zero **required** factor cannot be offset by the
other weights (e.g. a flat tape has `micro_momentum = 0` → fail). A tape
shorter than `MIN_OTC_TICKS = 30` clean closes returns
`reason = "insufficient_history"`; a non-directional signal returns
`"no_directional_signal"`.

## 3. REAL — `mtf_misaligned` and friends

`evaluate_real_liquidity_gate` requires **all five** factors to be `1`:

| Factor | Condition |
| --- | --- |
| `history` | `>= MIN_REAL_CLOSES = 160` clean closes |
| `spread` | one-tick spread `< max(0.5%, atr_ratio)` and relative spread `< SPREAD_WIDE_PCT = 0.005` (50 bps). No L2 quotes → proxy fallback (`quote_proxy=True`) or `no_bid_ask_quotes` veto |
| `flow` | bid/ask pressure (or proxy) not opposing the signal (opposes only when `|pressure| >= 0.5` and sign-opposite) |
| `mtf` | **M1/M5/H1 alignment** (see below) |
| `stress` | recent volatility z-score `< VOL_STRESS_Z_MAX = 3.0` |

MTF alignment is **resampled from the single forwarded tape** — no separate
multi-timeframe feed:

- **M1** = trailing slope of the base series (`_ema_slope_sign`, last 4 closes).
- **M5** = period-5 buckets (`resample_ohlc(closes, 5)`); needs `>= 12` buckets
  (i.e. `>= 60` closes).
- **H1** = period-60 buckets; needs `>= 2` buckets (i.e. `>= 120` closes).

Each timeframe is `up` / `down` / `flat`. `aligned` counts timeframes whose
direction equals the signal sign; `available` counts timeframes with a
non-flat trend.

- `passes = aligned >= MTF_MIN_ALIGNED` where **`MTF_MIN_ALIGNED = 2`**.
- If `available >= 2` but `aligned < 2` → `reason = "mtf_misaligned"`
  (there was enough evidence and it disagreed with the signal).
- If `available < 2` → `reason = "mtf_insufficient_evidence"`.

So `mtf_misaligned` means: at least two of M1/M5/H1 had a *definite* trend, but
fewer than two agreed with the signal. One aligned timeframe is not enough.

## 4. How a gate affects tradability (the composition)

`apply_strict_execution_gate` (`signal_gatekeeper.py:839`):

```python
class_verified = class_passes if gate_provided else True   # line 942
executable     = directional and bar_cleared and class_verified  # line 943
```

A provided class gate that fails always forces `executable = False` and stamps
`suppressed_reason = class_reason` (`otc_hf_fail` / `mtf_misaligned` / …) with
`regime_gate = "pending_high_precision"`. The gate is a **pure AND operand**:
it is the *only* thing `class_passes` feeds.

The `/predict` response is assembled as:

```python
{ "signal": ..., "regime": _surface_regime_gate(closes).get("regime"),
  **_strict_execution_surface(...) }
```

so `regime` is the honest Hurst/ADF label, while `executable` / `regime_gate` /
`regime_status` / `suppressed_reason` come from the strict surface above.

## 5. Proof: the gate cannot override a regime hold-back

`test_hf_mtf_gate_cannot_override_regime.py` pins, in the PART 34 audit style:

1. **Structural** — `executable` is defined exactly once as the AND of
   `directional && bar_cleared && class_verified`; `class_verified` is the
   `gate_provided` conditional; `regime_gate` / `regime_status` are never
   derived from the class gate; `**class_gate` / `**class_metrics` are never
   spread into the surface; the two filter modules contain no release field.
2. **Thresholds** — the `0.65` bar, weights, required factors, `MTF_MIN_ALIGNED = 2`
   and the 50 bps spread bar are the documented values.
3. **Behavioural monotonicity** — a red gate vetoes at every confidence
   (`50..100%`); a green gate plus below-bar confidence is still not
   executable; flipping green→red can only remove tradability; and a fully
   earned verdict *is* released (positive control, so the veto tests are not
   vacuous).
4. **Keystone** — applying the PART 14 regime hold-back
   (`apply_regime_gate(surface, "scored_only")`) to a surface whose HF/MTF gate
   is **green** still yields `executable = False`, `tier = T5`,
   `suppressed_reason = "regime_scored_only"`, with the green `class_gate`
   verdict preserved for audit. The hold-back is applied through a separate
   field/composition step that never consults the class gate, and — conversely
   — a `tradable` regime cannot arm a class-vetoed signal.

Net contract: **release requires direction AND the confidence bar AND a green
class gate AND no regime hold-back. The HF/MTF gate contributes only the third
term, so it can subtract tradability but never add it.**

## 6. Known caveats (tracked, not silently ignored)

- The regime label from `_surface_regime_gate` is only *read* as `.get("regime")`
  by the `/predict` builders; the strict execution surface's `regime_gate` is
  driven by the class gate + confidence bar. Gating `executable` directly on the
  regime label is a behaviour change tracked in `TODO.md` (see the xfail in
  `test_no_force_emit_escape.py`).
- The `>= REGIME_GATE_BYPASS_CLOSES (160)` LIVE-TEST bypass makes a `random_walk`
  window with a trusted long history tradable by design (revert note in
  `signal_gatekeeper.py:161-178`).
