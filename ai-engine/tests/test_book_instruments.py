"""
test_book_instruments.py — VERIFICATION OF THE 10-BOOK CONFLUENCE MODULE + MARKET-WAITING

Validates every book instrument's mathematical contract in isolation and in
integration with the quant_matrix (v7 → v9):

  1. BOLLINGER BANDS (Bollinger on Bollinger Bands)
     - Flat series → bandwidth ≈ 0 (tightest possible), squeeze ≈ 1, %B = 0.5.
     - Upstep series → %B drifts toward 1.0.
  2. TURTLE DONCHIAN BREAKOUT (Way of the Turtle)
     - Evaluated on the last CLOSED bar vs the PRIOR channel (v9 fix).
     - Clean breakout with penetration → non-zero breakout signal; atr > 0.
  3. MACD/RSI/EMA CROSS-CONFLUENCE (Murphy)
     - Uptrend → positive stack, agreement > 0.
  4. VOLUME-PRICE CONFIRMATION (Chan / Carter)
     - Volume surge + congruent bar → confirm > 0, MFI ∈ [0, 100].
     - Missing volume → neutral 0.
  5. CANDLESTICK STRUCTURE (Nison)
     - Clear bullish engulfing → positive score, pattern labelled.
     - Hammer after downtrend → positive score.
  6. MICROSTRUCTURE QUEUE (Aldridge)
     - price = ask → queue +1; price = bid → −1; price = mid → 0.
  7. EVIDENCE PERSISTENCE (Aronson)
     - Monotonic up series → persistence near 1, support > 0.
  8. ATR VOLATILITY REGIME
     - Flat series → atr_pct ≈ 0, regime = contracting/unknown.
  9. COMPOSITOR + TWO-FACTOR CONFLUENCE CONVERGENCE GATE (v10)
     - direction_sign = 0 → book_confirm = 0 AND gate = NEUTRAL score 0.
     - direction_sign ≠ 0 with aligned instruments → confluence score > 0.
     - full active-book unanimity at real magnitude → DEFINITIVE >= 98%;
       unanimous books with a faint-but-aligned confirmation (0.3 strength)
       still clear (unanimous vote is unanimous vote);
       a TRUE dissenting book (7/8) is an honest sub-thermal near-miss;
       a bare majority is far below thermal;
       a missing microstructure pillar blocks DEFINITIVE even at ~99%.
 10. INTEGRATION (v9 market-waiting + verdict fields)
     - diagnostics["book"] carries book_confirm AND confluence on every verdict.
     - market_waiting / waiting_reason / waiting_detail on QuantVerdict.
     - Sub-thermal directional attempt → waiting_reason = CONFLUENCE_BELOW_THERMAL.
     - flat (no directional conviction) → waiting_reason = NO_DIRECTIONAL_CONVICTION.

Run:  python tests/test_book_instruments.py
"""

import sys
import io
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from app.services.book_instruments import (
    bollinger_bands,
    bollinger_squeeze,
    turtle_donchian,
    trend_momentum_stack,
    volume_price_confirmation,
    money_flow_index,
    candlestick_pattern_score,
    microstructure_queue,
    evidence_robustness,
    atr_volatility_regime,
    evaluate_book_confluence,
    compute_multiplicative_confluence,
    DEFINITIVE_CONFIDENCE_MIN,
    CONFLUENCE_CLUSTERS,
)
from app.services.quant_matrix import evaluate_quant_matrix


def _synth_uptrend(n=80):
    rng = np.random.default_rng(123)
    drift = np.linspace(0, 0.04, n)
    noise = rng.normal(0, 0.0012, n).cumsum() * 0.25
    c = 100.0 * (1 + drift + noise)
    o = np.roll(c, 1); o[0] = c[0] * 0.999
    h = np.maximum(c, o) * 1.0003
    l = np.minimum(c, o) * 0.9997
    v = rng.uniform(200, 500, n)
    return c, o, h, l, v


def _synth_downtrend(n=80):
    rng = np.random.default_rng(456)
    drift = np.linspace(0, -0.04, n)
    noise = rng.normal(0, 0.0012, n).cumsum() * 0.25
    c = 100.0 * (1 + drift + noise)
    o = np.roll(c, 1); o[0] = c[0] * 1.001
    h = np.maximum(c, o) * 1.0003
    l = np.minimum(c, o) * 0.9997
    v = rng.uniform(200, 500, n)
    return c, o, h, l, v


def _flat_series(n=60):
    c = np.full(n, 100.0)
    o = c.copy()
    h = c * 1.0001
    l = c * 0.9999
    v = np.full(n, 300.0)
    return c, o, h, l, v


_BOOK_KEYS = tuple(CONFLUENCE_CLUSTERS.keys())


def main():
    failures = []

    # ── TEST 1: BOLLINGER BANDS ──
    c_flat, *_ = _flat_series(40)
    bb = bollinger_bands(c_flat)
    if abs(bb["pct_b"] - 0.5) > 0.1:
        failures.append(f"Flat BB %B={bb['pct_b']}, expected ≈0.5")
    squeeze = bollinger_squeeze(c_flat, lookback=30)
    if squeeze < 0.8:
        failures.append(f"Flat squeeze={squeeze}, expected >0.8 (tightest)")
    c_up, *_ = _synth_uptrend(60)
    bb_up = bollinger_bands(c_up)
    if bb_up["pct_b"] < 0.4:
        failures.append(f"Uptrend BB %B={bb_up['pct_b']}, expected >0.4")

    # ── TEST 2: TURTLE DONCHIAN (v9: last CLOSED bar vs PRIOR channel) ──
    c_up, o_up, h_up, l_up, _ = _synth_uptrend(80)
    don = turtle_donchian(c_up, h_up, l_up)
    if don["breakout_dir"] not in (0, 1):
        failures.append(f"Donchian breakout_dir={don['breakout_dir']}, expected 0 or 1")
    if don["atr_14"] <= 0:
        failures.append(f"Donchian ATR={don['atr_14']}, must be >0")
    # A long closed-bar uptrend must now register a real breakout (not the
    # pre-v9 artifact that could never pierce the forming bar's own high).
    c_long, o_long, h_long, l_long, _ = _synth_uptrend(120)
    don_long = turtle_donchian(c_long, h_long, l_long)
    print(f"  donchian(uptrend120): breakout={don_long['breakout']} dir={don_long['breakout_dir']} penetration={don_long['penetration']}")
    if don_long["breakout_dir"] != 1:
        failures.append(
            f"Long uptrend Donchian breakout_dir={don_long['breakout_dir']}, "
            f"expected 1 (closed-bar breakout against the prior channel)"
        )

    # ── TEST 3: MACD/RSI/EMA STACK ──
    stack = trend_momentum_stack(c_up)
    if stack["agreement"] <= 0.0:
        failures.append(f"Uptrend stack agreement={stack['agreement']}, expected >0")
    if not (-1.0 <= stack["stack"] <= 1.0):
        failures.append(f"Uptrend stack={stack['stack']} outside [-1,1]")

    # ── TEST 4: VOLUME-PRICE ──
    c, o, h, l, v = _synth_uptrend(40)
    vp = volume_price_confirmation(c, o, h, l, v)
    mfi_val = money_flow_index(c, h, l, v)
    if not (0.0 <= mfi_val <= 100.0):
        failures.append(f"MFI={mfi_val}, expected [0,100]")
    vp_no = volume_price_confirmation(c, o, h, l, np.zeros_like(v))
    if vp_no["confirm"] != 0.0:
        failures.append(f"No-volume confirm={vp_no['confirm']}, expected 0")

    # ── TEST 5: CANDLESTICK ──
    c_eng = np.array([100.0, 100.4, 100.1, 101.0, 101.0])
    o_eng = np.array([100.0, 100.0, 100.4, 99.6, 101.0])
    h_eng = c_eng + 0.05
    l_eng = c_eng - 0.05
    cs = candlestick_pattern_score(c_eng, o_eng, h_eng, l_eng)
    if cs["score"] <= 0:
        failures.append(f"Engulfing score={cs['score']}, expected >0")
    if "bullish_engulfing" not in cs["pattern"]:
        failures.append(f"Engulfing pattern={cs['pattern']}, expected bullish_engulfing")

    # ── TEST 6: MICROSTRUCTURE QUEUE ──
    q_ask = microstructure_queue(1.1010, bid=1.1000, ask=1.1010)
    q_bid = microstructure_queue(1.1000, bid=1.1000, ask=1.1010)
    q_mid = microstructure_queue(1.1005, bid=1.1000, ask=1.1010)
    if q_ask < 0.8:
        failures.append(f"Ask queue={q_ask}, expected >0.8")
    if q_bid > -0.8:
        failures.append(f"Bid queue={q_bid}, expected <-0.8")
    if abs(q_mid) > 0.1:
        failures.append(f"Mid queue={q_mid}, expected ≈0")
    q_none = microstructure_queue(1.1005, bid=None, ask=None)
    if q_none != 0.0:
        failures.append(f"None queue={q_none}, expected 0")

    # ── TEST 7: EVIDENCE PERSISTENCE ──
    c_mono = np.arange(100, 104, 0.05)
    ev = evidence_robustness(c_mono, atr=0.1)
    if ev["persistence"] < 0.6:
        failures.append(f"Monotonic persistence={ev['persistence']}, expected >0.6")
    if ev["support"] < 0.4:
        failures.append(f"Monotonic support={ev['support']}, expected >0.4")

    # ── TEST 8: ATR REGIME ──
    c_flat, h_flat, l_flat, *_ = _flat_series(40)
    vr = atr_volatility_regime(c_flat, h_flat, l_flat)
    if vr["regime"] not in ("contracting", "stable", "unknown"):
        failures.append(f"Flat regime={vr['regime']}, expected contracting/stable/unknown")

    # ── TEST 9: COMPOSITOR + STRICT MULTIPLICATIVE CONFLUENCE GATE ──
    c, o, h, l, v = _synth_uptrend(80)
    bc0 = evaluate_book_confluence(c, o, h, l, v, direction_sign=0)
    if bc0.book_confirm != 0.0:
        failures.append(f"sign=0 book_confirm={bc0.book_confirm}, expected 0")
    if bc0.confluence["gate"] != "NEUTRAL" or bc0.confluence["score"] != 0.0:
        failures.append(f"sign=0 confluence gate={bc0.confluence['gate']} score={bc0.confluence['score']}, expected NEUTRAL 0")
    if "atr_volatility" not in bc0.factors:
        failures.append("factors missing atr_volatility (Bollinger/ATR volatility pillar)")
    bc_buy = evaluate_book_confluence(c, o, h, l, v, direction_sign=1)
    bc_sell = evaluate_book_confluence(c, o, h, l, v, direction_sign=-1)
    if not (0.0 <= bc_buy.book_confirm <= 1.0):
        failures.append(f"BUY book_confirm={bc_buy.book_confirm}, outside [0,1]")
    if not (0.0 <= bc_sell.book_confirm <= 1.0):
        failures.append(f"SELL book_confirm={bc_sell.book_confirm}, outside [0,1]")
    if bc_buy.active_count < 5:
        failures.append(f"Active instruments={bc_buy.active_count}, expected >=5")
    if bc_buy.aligned_count < bc_sell.aligned_count:
        failures.append(
            f"Uptrend BUY aligned={bc_buy.aligned_count} < SELL={bc_sell.aligned_count}"
        )
    if bc_buy.confluence["score"] <= 0.0:
        failures.append(f"BUY confluence score={bc_buy.confluence['score']}, expected >0")
    if bc_buy.confluence["gate"] not in ("INSUFFICIENT", "DEFINITIVE"):
        failures.append(f"BUY confluence gate={bc_buy.confluence['gate']}, expected INSUFFICIENT/DEFINITIVE")

    # The two-factor confluence kernel (v10): full active-book unanimity at
    # real magnitude → DEFINITIVE >= 98%; an ALIGNED-but-faint book (0.3
    # strength) still counts as a confirming vote, so unanimity holds at ~99%
    # (unanimous vote = unanimous vote, regardless of magnitude); a true
    # DISSENTING book (7/8 unanimous) honestly lands just sub-thermal (the
    # composers' secondary path then dispatches it at its own reported
    # strength); a bare majority is far below thermal; and a missing
    # microstructure pillar still blocks DEFINITIVE even at ~99%.
    all_aligned = {k: 1.0 for p in CONFLUENCE_CLUSTERS.values() for k in p}
    one_faint = dict(all_aligned); one_faint["candlestick"] = 0.3
    one_dissent = dict(all_aligned); one_dissent["candlestick"] = -0.4
    majority = {
        "bollinger_bands": 1.0, "atr_volatility": 1.0, "macd_rsi_stack": 1.0,
        "donchian_breakout": 1.0, "candlestick": 1.0,
        "microstructure_queue": -0.6, "volume_price": -0.6,
        "evidence_persistence": -0.6,
    }
    micro_missing = dict(all_aligned)
    for k in ("microstructure_queue", "volume_price", "evidence_persistence"):
        micro_missing[k] = 0.0

    ca = compute_multiplicative_confluence(all_aligned, 1)
    cf = compute_multiplicative_confluence(one_faint, 1)
    cd = compute_multiplicative_confluence(one_dissent, 1)
    cj = compute_multiplicative_confluence(majority, 1)
    cm = compute_multiplicative_confluence(micro_missing, 1)
    print(
        f"  confluence: all={ca['score']} ({ca['gate']}) faint={cf['score']} ({cf['gate']}) "
        f"dissent={cd['score']} ({cd['gate']}) majority={cj['score']} ({cj['gate']}) "
        f"micro={cm['score']} ({cm['gate']})"
    )
    if not (ca["score"] >= DEFINITIVE_CONFIDENCE_MIN and ca["gate"] == "DEFINITIVE"):
        failures.append(f"All-aligned books got {ca['score']}/{ca['gate']}, expected DEFINITIVE >= {DEFINITIVE_CONFIDENCE_MIN}")
    if not (cf["score"] >= DEFINITIVE_CONFIDENCE_MIN and cf["gate"] == "DEFINITIVE"):
        failures.append(f"Faint-but-unanimous got {cf['score']}/{cf['gate']}, expected DEFINITIVE (unanimous active books)")
    if not (cd["score"] < DEFINITIVE_CONFIDENCE_MIN and cd["gate"] == "INSUFFICIENT"):
        failures.append(f"7/8 dissent got {cd['score']}/{cd['gate']}, expected INSUFFICIENT (7/8 is not 98% consistency)")
    if not (cj["score"] < 70.0 and cj["gate"] == "INSUFFICIENT"):
        failures.append(f"Bare-majority got {cj['score']}/{cj['gate']}, expected honest sub-thermal (<70)")
    if not (cm["gate"] == "INSUFFICIENT" and "MICROSTRUCTURE_CLUSTER_MISSING" in cm["blockers"]):
        failures.append(f"Missing-micro pillar got {cm['gate']} blockers={cm['blockers']}, expected INSUFFICIENT + MICROSTRUCTURE_CLUSTER_MISSING")
    # Neutral input → score 0 NEUTRAL, never a confluence.
    if compute_multiplicative_confluence(all_aligned, 0)["gate"] != "NEUTRAL":
        failures.append("Neutral direction manufactured a confluence gate")

    # ── TEST 10: INTEGRATION — market-waiting + diagnostics["book"] + confluence ──
    def _make_candles(closes):
        candles = []
        for i, c in enumerate(closes):
            o = closes[i - 1] if i > 0 else c * 0.999
            hi = max(o, c) * 1.0005
            lo = min(o, c) * 0.9995
            candles.append({
                "timestamp": i * 60_000, "open": o, "high": hi,
                "low": lo, "close": c, "volume": 300.0,
            })
        return candles

    drift = np.linspace(0, 0.03, 120)
    rng = np.random.default_rng(42)
    noise = rng.normal(0, 0.0015, 120).cumsum() * 0.3
    c_bull = 1.1 * (1 + drift + noise)
    v_bull = evaluate_quant_matrix(_make_candles(c_bull), timeframe="1h")
    book_diag = v_bull.diagnostics.get("book", {})
    for key in ("book_confirm", "agreement", "magnitude", "factors", "detail", "confluence"):
        if key not in book_diag:
            failures.append(f"Bull diagnostics missing book.{key}")
    bconf = book_diag.get("confluence", {})
    if not (0.0 <= bconf.get("score", -1) <= 100.0):
        failures.append(f"Bull confluence score={bconf.get('score')} outside [0,100]")
    if bconf.get("gate") not in ("NEUTRAL", "INSUFFICIENT", "DEFINITIVE"):
        failures.append(f"Bull confluence gate={bconf.get('gate')} unknown")
    for p in _BOOK_KEYS:
        if p not in bconf.get("clusters", {}):
            failures.append(f"Bull confluence missing pillar {p}")
    if not isinstance(v_bull.market_waiting, bool):
        failures.append(f"bull market_waiting type={type(v_bull.market_waiting)}, expected bool")
    if v_bull.direction == "BUY":
        if v_bull.diagnostics.get("confidence_gated"):
            if v_bull.waiting_reason != "CONFLUENCE_BELOW_THERMAL":
                failures.append(
                    f"Bull waiting_reason={v_bull.waiting_reason}, expected CONFLUENCE_BELOW_THERMAL"
                )
            if not v_bull.market_waiting:
                failures.append("Gated BUY should be market_waiting=True")
        elif v_bull.market_waiting is not False:
            failures.append("Dispatched BUY should have market_waiting=False")
    elif v_bull.direction == "SELL":
        if not v_bull.diagnostics.get("confidence_gated"):
            failures.append("Bull gated verdict missing confidence_gated")
        if v_bull.waiting_reason != "CONFLUENCE_BELOW_THERMAL":
            failures.append(
                f"Bull waiting_reason={v_bull.waiting_reason}, expected CONFLUENCE_BELOW_THERMAL"
            )
    else:
        failures.append(f"Bull evaluated {v_bull.direction} — must be directional (never HOLD)")

    # flat → deterministic tie-break, market-waiting (never HOLD)
    flat = evaluate_quant_matrix(_make_candles([1.1] * 120), live_price=1.1, timeframe="1h")
    if flat.direction not in ("BUY", "SELL"):
        failures.append(f"Flat direction={flat.direction}, expected directional BUY/SELL (never HOLD)")
    if flat.waiting_reason != "CONFLUENCE_BELOW_THERMAL":
        failures.append(
            f"Flat waiting_reason={flat.waiting_reason}, expected CONFLUENCE_BELOW_THERMAL"
        )
    if not flat.market_waiting:
        failures.append("Flat market_waiting should be True")

    drift_b = np.linspace(0, -0.03, 120)
    rng_b = np.random.default_rng(7)
    noise_b = rng_b.normal(0, 0.0015, 120).cumsum() * 0.3
    c_bear = 1.1 * (1 + drift_b + noise_b)
    v_bear = evaluate_quant_matrix(_make_candles(c_bear), timeframe="1h")
    if v_bear.direction == "SELL":
        if v_bear.diagnostics.get("confidence_gated"):
            if v_bear.waiting_reason != "CONFLUENCE_BELOW_THERMAL":
                failures.append(
                    f"Bear waiting_reason={v_bear.waiting_reason}, expected CONFLUENCE_BELOW_THERMAL"
                )
            if not v_bear.market_waiting:
                failures.append("Gated SELL should be market_waiting=True")
        elif v_bear.market_waiting is not False:
            failures.append("Dispatched SELL should have market_waiting=False")
    elif v_bear.direction == "BUY":
        if v_bear.waiting_reason != "CONFLUENCE_BELOW_THERMAL":
            failures.append(
                f"Bear waiting_reason={v_bear.waiting_reason}, expected CONFLUENCE_BELOW_THERMAL"
            )
    else:
        failures.append(f"Bear evaluated {v_bear.direction} — must be directional (never HOLD)")

    # ── RESULT ──
    print()
    if failures:
        print("FAILURES:")
        for f in failures:
            print("  X", f)
        sys.exit(1)
    else:
        print(
            "ALL BOOK INSTRUMENT TESTS PASSED  (Bollinger squeeze/B%B, Turtle "
            "Donchian closed-bar breakout, MACD/RSI/EMA stack, volume-price "
            "confirmation, Nison candles, Aldridge queue, Aronson evidence, ATR "
            "regime, strict multiplicative 98% confluence gate, market-waiting "
            "integration)"
        )


if __name__ == "__main__":
    main()