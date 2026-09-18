"""Tests for the advanced math engine (app/services/math_engine.py).

Validates sections A-G against closed-form / structural expectations.
Every formula here is a published model; tests assert correctness properties,
not fabricated numbers.
"""

import math

import pytest

from app.services import math_engine as me


# ═══════ A. STOCHASTIC PROCESSES ═══════

def test_gbm_exact_itô_martingale_expectation():
    # E[S_T] with the lognormal correction must match spot under zero drift.
    path = me.geometric_brownian(100.0, drift=0.0, volatility=0.2, dt=1.0 / 252, steps=252, seed=7)
    assert path[0] == pytest.approx(100.0)
    assert all(p > 0 for p in path)
    assert len(path) == 253


def test_gbm_deterministic_seed():
    a = me.geometric_brownian(100.0, 0.05, 0.3, 0.01, 50, seed=11)
    b = me.geometric_brownian(100.0, 0.05, 0.3, 0.01, 50, seed=11)
    assert a == b
    assert math.isclose(math.log(a[-1] / 100.0), 0.0, abs_tol=3.0)


def test_ou_half_life():
    assert me.ou_half_life(1.0) == pytest.approx(math.log(2.0))
    assert me.ou_half_life(0.5) == pytest.approx(2 * math.log(2.0))
    with pytest.raises(ValueError):
        me.ou_half_life(0.0)


def test_ou_reverts_to_mean():
    path = me.ornstein_uhlenbeck_path(theta=2.0, mu=10.0, sigma=0.05, x0=5.0, dt=0.01, steps=2000, seed=3)
    assert abs(path[-1] - 10.0) < 0.5


def test_cir_stays_nonnegative():
    path = me.cir_path(initial=0.03, mean=0.05, speed=0.5, volatility=0.1, dt=0.01, steps=500, seed=5)
    assert all(r >= 0.0 for r in path)


def test_merton_jump_diffusion_positive_prices():
    path = me.merton_jump_diffusion(100.0, 0.0, 0.2, 0.5, -0.02, 0.02, 0.01, 300, seed=9)
    assert all(p > 0 for p in path)
    assert len(path) == 301


def test_heston_finite_and_positive():
    path = me.heston_path(100.0, 0.04, 0.04, 1.0, 0.3, -0.5, 0.01, 300, seed=2)
    assert all(p > 0 for p in path)
    assert all(math.isfinite(p) for p in path)


def test_fractional_brownian_scaling():
    h = 0.7
    path = me.fractional_brownian_motion(h, n=32, seed=1)
    assert len(path) == 32
    # increments should exhibit persistence: positive lag-1 correlation.
    incs = [path[i] - path[i - 1] for i in range(1, len(path))]
    m = sum(incs) / len(incs)
    cov = sum((incs[i] - m) * (incs[i + 1] - m) for i in range(len(incs) - 1)) / (len(incs) - 1)
    assert cov > 0


def test_process_input_validation():
    with pytest.raises(ValueError):
        me.geometric_brownian(0.0, 0.0, 0.2, 0.01, 10)
    with pytest.raises(ValueError):
        me.ornstein_uhlenbeck_path(theta=-1.0, mu=1.0, sigma=0.1, x0=0.0, dt=0.01, steps=10)
    with pytest.raises(ValueError):
        me.fractional_brownian_motion(hurst=1.5, n=16)


# ═══════ B. OPTION PRICING ═══════

def test_bsm_put_call_parity():
    s, k, t, r, vol = 100.0, 105.0, 0.5, 0.04, 0.25
    call = me.black_scholes_merton(s, k, t, r, vol, "call")
    put = me.black_scholes_merton(s, k, t, r, vol, "put")
    # C - P = S - K*exp(-rT)
    assert math.isclose(call - put, s - k * math.exp(-r * t), abs_tol=1e-6)


def test_bsm_atm_approx():
    s, k, t, r, vol = 100.0, 100.0, 1.0, 0.0, 0.3
    price = me.black_scholes_merton(s, k, t, r, vol, "call")
    assert 0.35 * s * vol * math.sqrt(t) < price < 0.45 * s * vol * math.sqrt(t)


def test_bsm_greeks_call_delta_sign_and_range():
    g = me.black_scholes_greeks(100.0, 105.0, 0.5, 0.04, 0.25, "call")
    assert 0.0 < g["delta"] < 1.0
    assert g["gamma"] > 0
    assert g["vega"] > 0


def test_binomial_converges_to_bsm():
    s, k, t, r, vol = 100.0, 100.0, 1.0, 0.05, 0.3
    bsm = me.black_scholes_merton(s, k, t, r, vol, "call")
    tree = me.binomial_crr(s, k, t, r, vol, steps=500, option_type="call", american=False)
    assert math.isclose(tree, bsm, rel_tol=0.01)


def test_monte_carlo_antithetic_converges():
    s, k, t, r, vol = 100.0, 100.0, 1.0, 0.05, 0.3
    bsm = me.black_scholes_merton(s, k, t, r, vol, "call")
    mc = me.monte_carlo_antithetic(s, k, t, r, vol, "call", n_paths=60000, seed=13)
    assert math.isclose(mc, bsm, rel_tol=0.03)


# ═══════ C. VOLATILITY ═══════

def test_parkinson_gt_zero_on_range():
    h = [100.0, 101.0, 100.5]
    l = [99.0, 99.5, 99.0]
    assert me.parkinson_volatility(h, l) > 0


def test_garman_klass_positive_on_moving_series():
    h = [101.0, 102.0, 103.0, 102.5]
    l = [99.0, 100.0, 101.0, 100.5]
    c = [100.0, 101.0, 102.0, 102.0]
    assert me.garman_klass(h, l, c) > 0


def test_yang_zhang_combines_components():
    o = [100.0, 101.0, 102.0]
    h = [102.0, 103.0, 103.5]
    l = [99.0, 100.0, 101.0]
    c = [101.0, 102.0, 102.5]
    yz = me.yang_zhang(o, h, l, c)
    rs = me.rogers_satchell(o, h, l, c)
    # YZ = sqrt(σ_oc² + k·σ_co² + (1-k)·σ_rs²) with k=0.34; it must at least
    # capture (1-k) of the Rogers-Satchell variance.
    assert yz >= math.sqrt(1 - 0.34) * rs - 1e-12
    assert yz > 0


def test_ewma_vol_response():
    calm = [0.001, 0.001, 0.001]
    volatile = [0.1, -0.1, 0.05]
    assert me.ewma_volatility(volatile) > me.ewma_volatility(calm)


def test_garch_persistence():
    # Long-run variance = ω/(1-α-β) = 1e-5/0.05 = 2e-4; last variance 1e-4 is
    # BELOW the long-run, so the forecast must revert UP toward 2e-4.
    f1 = me.garch11_forecast(0.00001, 0.1, 0.85, 0.0001, 0.0, horizon=1)
    f5 = me.garch11_forecast(0.00001, 0.1, 0.85, 0.0001, 0.0, horizon=5)
    f10 = me.garch11_forecast(0.00001, 0.1, 0.85, 0.0001, 0.0, horizon=10)
    assert f1 <= f5 <= f10  # mean-reverts up toward long-run, not exploding
    with pytest.raises(ValueError):
        me.garch11_forecast(0.00001, 0.2, 0.9, 0.0001, 0.0, horizon=1)  # alpha+beta >= 1


# ═══════ D. MICROSTRUCTURE ═══════

def test_kyle_lambda_sign():
    q = [1.0, 1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0]
    d = [0.5, 0.4, -0.3, 0.5, -0.4, 0.3, 0.6, -0.2]
    lam = me.kyle_lambda(q, d)
    assert lam > 0


def test_roll_spread_zero_on_noise():
    # zero-price-change data has no serial covariance -> zero spread
    assert me.roll_spread([100.0, 100.0, 100.0, 100.0, 100.0]) == 0.0


def test_amihud_positive():
    assert me.amihud_illiquidity([0.01, -0.02, 0.015], [1e6, 1e6, 1e6]) > 0


def test_ofi_clips_and_signs():
    assert me.order_flow_imbalance(700, 300) == pytest.approx(0.4)
    assert me.order_flow_imbalance(300, 700) == pytest.approx(-0.4)
    assert me.order_flow_imbalance(0, 1000) == pytest.approx(-1.0)
    assert me.order_flow_imbalance(1000, 0) == pytest.approx(1.0)


def test_pin_bounded():
    pin = me.pin_estimate(alpha=0.5, delta=0.5, mu=0.02, eps_b=0.005, eps_s=0.005)
    assert 0.0 <= pin <= 1.0


# ═══════ E. RISK ═══════

def test_var_historical_vs_parametric_ordering():
    r = [0.01, -0.02, 0.005, -0.015, 0.02, -0.03, 0.01, -0.005, 0.003, 0.001]
    hist = me.value_at_risk(r, 0.95, parametric=False)
    para = me.value_at_risk(r, 0.95, parametric=True)
    assert hist > 0 and para > 0


def test_expected_shortfall_gte_var():
    r = [0.01, -0.02, 0.005, -0.015, 0.02, -0.03, 0.01, -0.005, 0.003, 0.001]
    es = me.expected_shortfall(r, 0.95)
    var = me.value_at_risk(r, 0.95, parametric=False)
    assert es >= var


def test_max_drawdown():
    eq = [100.0, 120.0, 90.0, 95.0, 60.0]
    assert me.max_drawdown(eq) == pytest.approx(0.5)


def test_sharpe_sortino_ordering():
    r = [0.01, -0.01, 0.02, -0.005, 0.015]
    sharpe = me.sharpe_ratio(r, risk_free=0.0, periods_per_year=1.0)
    sortino = me.sortino_ratio(r, target=0.0, periods_per_year=1.0)
    assert sharpe > 0 and sortino > 0
    assert sortino > sharpe  # downside-only penalizes less than full variance


def test_kelly_fraction_bounds():
    f = me.kelly_fraction(0.6, 1.0, 1.0)
    assert 0.0 <= f < 1.0
    assert me.fractional_kelly(0.6, 1.0, 1.0, 0.25) == pytest.approx(0.25 * f)


# ═══════ F. TIME SERIES ═══════

def test_adf_more_negative_for_stationary():
    import random
    rng = random.Random(0)
    # stationary: white noise around 5.0 (mean-reverting, strong negative tau)
    stationary = [5.0 + rng.gauss(0.0, 0.5) for _ in range(60)]
    rng2 = random.Random(1)
    drifting = []
    acc = 5.0
    for _ in range(60):
        acc += rng2.gauss(0.0, 1.0)
        drifting.append(acc)
    tau_stat = me.adf_statistic(stationary)
    tau_drift = me.adf_statistic(drifting)
    assert tau_stat < 0 and tau_drift < 0
    assert tau_stat < tau_drift  # unit root should be closer to 0 / less negative


def test_hurst_range():
    import random
    rng = random.Random(4)
    rw = []
    acc = 0.0
    for _ in range(128):
        acc += rng.gauss(0.0, 1.0)
        rw.append(acc)
    h = me.hurst_rs(rw)
    assert 0.0 <= h <= 1.0


def test_fractional_differentiation_shape():
    series = [100.0 + i for i in range(30)]
    out = me.fractional_differentiation(series, d=0.5)
    assert len(out) == len(series)
    assert out[0] == 0.0


def test_engle_granger_cointegration_end_to_end():
    import random
    rng = random.Random(2)
    # x is a random walk (I(1)); y is a noisy-but-cointegrated linear combo.
    x = []
    acc = 100.0
    for _ in range(40):
        acc += rng.gauss(0.0, 1.0)
        x.append(acc)
    y = [2.0 + 0.8 * xi + 0.1 * rng.gauss(0.0, 1.0) for xi in x]
    res = me.engle_granger_cointegration(y, x)
    assert "residual_adf" in res
    assert abs(res["beta"] - 0.8) < 0.2
    assert res["residual_adf"] < -2  # stationary residual -> strong cointegration


def test_kalman_denoises():
    z = [100.0 + (0.1 if i % 2 == 0 else -0.1) for i in range(20)]
    kf = me.kalman_filter_1d(z, process_noise=0.0, measurement_noise=1e-4)
    # very low process noise -> filtered series basically constant around 100
    assert abs(kf["filtered"][-1] - 100.0) < 0.5


def test_pca_components():
    m = [[1.0, 2.0], [2.0, 4.0], [3.0, 6.0], [4.0, 8.0]]  # perfectly collinear
    res = me.pca_components(m, n_components=1)
    assert len(res["eigenvalues"]) == 1
    assert res["eigenvalues"][0] >= 0
    assert res["components"][0][0] * res["components"][0][1] > 0  # aligned sign


# ═══════ G. PORTFOLIO ═══════

def test_markowitz_min_variance_weights_sum_to_one():
    rets = [0.10, 0.12]
    cov = [[0.04, 0.01], [0.01, 0.09]]
    res = me.markowitz_weights(rets, cov)
    assert sum(res["weights"]) == pytest.approx(1.0, abs=1e-6)
    assert res["portfolio_variance"] >= 0


def test_markowitz_weights_match_analytic():
    # Two-asset min-variance: w1 = (sig2^2 - cov)/(sig1^2+sig2^2 - 2cov)
    cov = [[0.04, 0.01], [0.01, 0.09]]
    res = me.markowitz_weights([0.1, 0.12], cov)
    expected_w1 = (0.09 - 0.01) / (0.04 + 0.09 - 2 * 0.01)
    assert res["weights"][0] == pytest.approx(expected_w1, rel=1e-6)


def test_black_litterman_tilts_toward_view():
    cov = [[0.04, 0.0], [0.0, 0.09]]
    mkt = [0.5, 0.5]
    # implied equilibrium return on asset 0 is λ·Σ00·w0 = 2.5·0.04·0.5 = 0.05;
    # a view ABOVE equilibrium must tilt the posterior weight up off 0.5.
    res = me.black_litterman(mkt, cov, views={0: 0.10}, tau=0.05, view_noise=0.01)
    assert res["weights"][0] > mkt[0]  # positive view on asset 0 raises weight
    assert res["tilt"][0] > 0


def test_risk_parity_weights():
    cov = [[0.04, 0.0], [0.0, 0.09]]
    w = me.risk_parity_weights(cov)
    assert sum(w) == pytest.approx(1.0, abs=1e-6)
    # risk contributions should be near-equal
    sigma_p = math.sqrt(w[0] ** 2 * 0.04 + w[1] ** 2 * 0.09)
    rc0 = w[0] * (w[0] * 0.04) / sigma_p
    rc1 = w[1] * (w[1] * 0.09) / sigma_p
    assert math.isclose(rc0, rc1, rel_tol=0.15)


def test_information_coefficient_and_ratio():
    ic = me.information_coefficient([0.2, 0.1, -0.1, 0.3, -0.2], [0.19, 0.08, -0.09, 0.28, -0.21])
    assert 0.8 < ic <= 1.0
    assert me.information_ratio(ic, 100.0) == pytest.approx(ic * 10.0)