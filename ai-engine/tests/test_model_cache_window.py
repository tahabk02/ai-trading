"""Regression tests for the ML model cache window key.

The cache used to be keyed on ``symbol:timeframe`` alone, so the first payload
to train won the key and every later request on that key was scored with the
wrong model — a perfect-confluence tape fell from 98.7 to 96.6 purely because
an unrelated request had already run. A verdict must reflect the candles in its
own request.
"""
import numpy as np

from app.services.ml_predictor import ModelCache, _data_fingerprint


def _arrays(closes, opens=None):
    c = np.array(closes, dtype=np.float64)
    o = c.copy() if opens is None else np.array(opens, dtype=np.float64)
    h = c * 1.001
    low = c * 0.999
    v = np.full_like(c, 1000.0)
    return c, o, h, low, v


def test_fingerprint_is_stable_for_identical_windows():
    c, o, h, low, v = _arrays([1.0, 1.1, 1.2, 1.3])
    assert _data_fingerprint(c, o, h, low, v) == _data_fingerprint(c, o, h, low, v)


def test_fingerprint_changes_with_a_different_candle_payload():
    a = _arrays([1.0, 1.1, 1.2, 1.3])
    b = _arrays([1.0, 1.1, 1.2, 1.4])
    assert _data_fingerprint(*a) != _data_fingerprint(*b)


def test_fingerprint_is_sensitive_to_opens():
    """opens reaches volume_price_confirmation and candlestick_pattern_score,
    which both move book_confirm. Identical (C,H,L,V) with different opens is a
    different window and must not share a cached model."""
    c, o, h, low, v = _arrays([1.0, 1.1, 1.2, 1.3])
    o2 = o * 0.98
    assert _data_fingerprint(c, o, h, low, v) != _data_fingerprint(c, o2, h, low, v)


def test_fingerprint_is_sensitive_to_highs_lows_and_volume_not_just_closes():
    """A payload that keeps the same closes but fakes volume must not collide:
    the corroborator trains on volume, so a volume-only difference is a real
    different window."""
    base = _arrays([1.0, 1.1, 1.2, 1.3])
    c, o, h, low, v = base
    v2 = v * 7.0
    assert _data_fingerprint(c, o, h, low, v) != _data_fingerprint(c, o, h, low, v2)


def test_cache_does_not_serve_a_model_trained_on_a_different_window():
    """THE regression: two different payloads on one symbol/timeframe must not
    share a model."""
    cache = ModelCache()
    win_a = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    win_b = _data_fingerprint(*_arrays([2.0, 2.1, 2.2, 2.4]))

    cache.set("EUR/USD", "1h", "model_A", "scaler_A", 0.91, win_a)

    assert cache.get("EUR/USD", "1h", win_a) is not None, "same window must hit"
    assert cache.get("EUR/USD", "1h", win_b) is None, (
        "a different candle window must NOT be served the earlier model"
    )


def test_training_order_does_not_change_the_verdict():
    """Send A then D, and D then A; the entry stored for D's own window is
    identical either way."""
    cache = ModelCache()
    win_a = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    win_d = _data_fingerprint(*_arrays([5.0, 5.4, 5.9, 6.5]))

    cache.set("EUR/USD", "1h", "model_A", "s_A", 0.90, win_a)
    cache.set("EUR/USD", "1h", "model_D", "s_D", 0.98, win_d)
    d_after_a = cache.get("EUR/USD", "1h", win_d)

    cache.clear()
    cache.set("EUR/USD", "1h", "model_D", "s_D", 0.98, win_d)
    cache.set("EUR/USD", "1h", "model_A", "s_A", 0.90, win_a)
    d_after_d = cache.get("EUR/USD", "1h", win_d)

    assert d_after_a == d_after_d == ("model_D", "s_D", 0.98)


def test_symbol_and_timeframe_still_separate_entries():
    cache = ModelCache()
    win = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    cache.set("EUR/USD", "1h", "m1", "s1", 0.90, win)
    cache.set("EUR/USD", "1d", "m2", "s2", 0.80, win)
    cache.set("GBP/USD", "1h", "m3", "s3", 0.70, win)

    assert cache.get("EUR/USD", "1h", win) == ("m1", "s1", 0.90)
    assert cache.get("EUR/USD", "1d", win) == ("m2", "s2", 0.80)
    assert cache.get("GBP/USD", "1h", win) == ("m3", "s3", 0.70)


def test_ttl_expiry_is_measured_on_the_entry():
    import time as _time

    cache = ModelCache()
    win = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    cache.set("EUR/USD", "1h", "m", "s", 0.9, win)

    # Backdate the entry past the TTL.
    key = cache._key("EUR/USD", "1h", win)
    model, scaler, acc, fp, _ = cache._cache[key]
    cache._cache[key] = (model, scaler, acc, fp, _time.time() - cache.TTL_SECONDS - 1)

    assert cache.get("EUR/USD", "1h", win) is None


# ── two-tier behaviour ────────────────────────────────────────────────────
# Tier 1 (exact window) is the only verdict source. Tier 2 (coarse) exists so a
# cold exact key can be warmed without retraining from scratch, and must never
# be reachable through get().


def test_set_also_mirrors_into_the_coarse_tier():
    cache = ModelCache()
    win = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    cache.set("EUR/USD", "1h", "m", "s", 0.9, win)
    assert cache.get_coarse("EUR/USD", "1h") == ("m", "s", 0.9)


def test_coarse_tier_keeps_only_the_most_recent_model():
    cache = ModelCache()
    win_a = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    win_b = _data_fingerprint(*_arrays([9.0, 9.1, 9.2, 9.4]))

    cache.set("EUR/USD", "1h", "old", "s1", 0.5, win_a)
    cache.set("EUR/USD", "1h", "new", "s2", 0.95, win_b)

    assert cache.get_coarse("EUR/USD", "1h") == ("new", "s2", 0.95)
    # Both exact windows remain individually retrievable.
    assert cache.get("EUR/USD", "1h", win_a) == ("old", "s1", 0.5)
    assert cache.get("EUR/USD", "1h", win_b) == ("new", "s2", 0.95)


def test_get_never_falls_back_to_a_different_window():
    """THE safety invariant of the coarse tier: get() must miss, not silently
    serve another window's model."""
    cache = ModelCache()
    warm = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    cold = _data_fingerprint(*_arrays([9.0, 9.1, 9.2, 9.4]))

    cache.set("EUR/USD", "1h", "warm_model", "s", 0.99, warm)

    assert cache.get("EUR/USD", "1h", cold) is None, (
        "get() must not serve the coarse model for a different window"
    )
    # ...while the coarse tier is still available for the explicit warm path.
    assert cache.get_coarse("EUR/USD", "1h") == ("warm_model", "s", 0.99)


def test_coarse_tier_is_scoped_per_symbol_and_timeframe():
    cache = ModelCache()
    win = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    cache.set("EUR/USD", "1h", "eur1h", "s", 0.9, win)
    cache.set("EUR/USD", "1d", "eur1d", "s", 0.8, win)
    cache.set("GBP/USD", "1h", "gbp1h", "s", 0.7, win)

    assert cache.get_coarse("EUR/USD", "1h") == ("eur1h", "s", 0.9)
    assert cache.get_coarse("EUR/USD", "1d") == ("eur1d", "s", 0.8)
    assert cache.get_coarse("GBP/USD", "1h") == ("gbp1h", "s", 0.7)
    assert cache.get_coarse("AUD/USD", "1h") is None


def test_clear_empties_both_tiers():
    cache = ModelCache()
    win = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    cache.set("EUR/USD", "1h", "m", "s", 0.9, win)
    assert cache.size == 1 and cache.coarse_size == 1

    cache.clear()
    assert cache.size == 0, "clear left exact entries behind"
    assert cache.coarse_size == 0, "clear left coarse entries behind"
    assert cache.get("EUR/USD", "1h", win) is None
    assert cache.get_coarse("EUR/USD", "1h") is None


def test_coarse_tier_expires_on_the_same_ttl():
    import time as _time

    cache = ModelCache()
    win = _data_fingerprint(*_arrays([1.0, 1.1, 1.2, 1.3]))
    cache.set("EUR/USD", "1h", "m", "s", 0.9, win)

    ckey = cache._coarse_key("EUR/USD", "1h")
    model, scaler, acc, fp, _ = cache._coarse[ckey]
    cache._coarse[ckey] = (model, scaler, acc, fp, _time.time() - cache.TTL_SECONDS - 1)

    assert cache.get_coarse("EUR/USD", "1h") is None


def test_lru_eviction_keeps_the_exact_tier_bounded():
    cache = ModelCache()
    for i in range(cache.MAX_SIZE + 20):
        win = _data_fingerprint(*_arrays([float(i), float(i) + 1, float(i) + 2]))
        cache.set("EUR/USD", "1h", "m%d" % i, "s", 0.9, win)
    assert cache.size == cache.MAX_SIZE
    # Coarse is one entry per instrument, so it must not grow with windows.
    assert cache.coarse_size == 1
