from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import joblib
import numpy as np
import pandas as pd
import pytest
from pydantic import ValidationError
from sklearn.linear_model import LogisticRegression

from app.core.config import settings
from app.quant.providers import macro as macro_module
from app.quant.contracts import (
    SCHEMA_VERSION,
    Candle,
    ConfluenceRequest,
    Direction,
    MacroDataPoint,
    ProviderStatus,
    SentimentTextInput,
)
from app.quant.providers.macro import (
    MacroProvider,
    OpenBBUnavailableError,
    _fetch_openbb_observations,
)
from app.quant.providers.ml import MLProvider
from app.quant.providers.sentiment import SentimentProvider


def _request(
    *,
    timeframe: str = "1h",
    bars: list[Candle] | None = None,
    sentiment: list[SentimentTextInput] | None = None,
    symbol: str = "EUR/USD",
) -> ConfluenceRequest:
    return ConfluenceRequest(
        schema_version=SCHEMA_VERSION,
        symbol=symbol,
        timeframe=timeframe,
        candles=bars or [],
        sentiment_evidence=sentiment or [],
    )


def _candles(
    *,
    timeframe_seconds: int = 3_600,
    count: int = 30,
    age_seconds: int = 30,
) -> list[Candle]:
    latest = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
    result: list[Candle] = []
    for index in range(count):
        close = 1.1 + index * 0.0001
        result.append(
            Candle(
                timestamp=(
                    latest - timedelta(seconds=(count - index - 1) * timeframe_seconds)
                ).isoformat(),
                open=close - 0.00005,
                high=close + 0.001,
                low=close - 0.001,
                close=close,
            )
        )
    return result


def _sentiment(
    text: str,
    *,
    symbol: str = "EUR/USD",
    as_of: datetime | None = None,
) -> SentimentTextInput:
    return SentimentTextInput(
        schema_version=SCHEMA_VERSION,
        kind="news",
        symbol=symbol,
        source="unit-test-source",
        reference_id="article-1",
        text=text,
        as_of=as_of or datetime.now(timezone.utc),
    )


def _macro_point(
    name: str,
    value: float,
    as_of: datetime,
    *,
    category: str = "fx_rate",
) -> MacroDataPoint:
    return MacroDataPoint(
        schema_version=SCHEMA_VERSION,
        category=category,
        name=name,
        value=value,
        unit="provider_units",
        source="unit-test",
        as_of=as_of,
    )


def _macro_fetcher(points: list[MacroDataPoint]):
    return lambda symbol: points if symbol else []


def test_sentiment_analyzes_only_fresh_evidence_for_requested_symbol() -> None:
    result = asyncio.run(
        SentimentProvider().evaluate(
            _request(
                sentiment=[
                    _sentiment("The euro outlook is strongly bullish with a rally."),
                    _sentiment("The unrelated asset suffered a crash.", symbol="USD/JPY"),
                ]
            )
        )
    )

    assert result.status == ProviderStatus.OK
    assert result.direction == Direction.BUY
    assert result.score == pytest.approx(1.0)
    assert 0.0 <= result.confidence <= 100.0
    assert result.evidence["model"] == "local-financial-lexicon-v1"
    assert len(result.evidence["evidence"]) == 1


def test_sentiment_negation_reverses_polarity_and_unknown_text_is_unavailable() -> None:
    provider = SentimentProvider()
    negated = asyncio.run(
        provider.evaluate(_request(sentiment=[_sentiment("The outlook is not bullish.")]))
    )
    unrecognized = asyncio.run(
        provider.evaluate(_request(sentiment=[_sentiment("Central bank meeting tomorrow.")]))
    )

    assert negated.status == ProviderStatus.OK
    assert negated.direction == Direction.SELL
    assert unrecognized.status == ProviderStatus.UNAVAILABLE
    assert unrecognized.score is None


def test_sentiment_rejects_stale_and_missing_timezone_evidence() -> None:
    stale = datetime.now(timezone.utc) - timedelta(minutes=16)
    result = asyncio.run(
        SentimentProvider().evaluate(
            _request(sentiment=[_sentiment("Markets rally.", as_of=stale)])
        )
    )

    assert result.status == ProviderStatus.DEGRADED
    assert result.score is None
    assert "stale evidence" in (result.reason or "")
    with pytest.raises(ValidationError, match="timezone"):
        _sentiment("Markets rally.", as_of=datetime.now())


def test_sentiment_without_matching_symbol_is_unavailable() -> None:
    result = asyncio.run(
        SentimentProvider().evaluate(
            _request(sentiment=[_sentiment("Markets rally.", symbol="USD/JPY")])
        )
    )
    assert result.status == ProviderStatus.UNAVAILABLE
    assert result.score is None


def test_openbb_fetcher_maps_real_dataframe_observations(monkeypatch) -> None:
    now = datetime.now(timezone.utc).isoformat()
    seen: dict[str, object] = {}

    class FakeResponse:
        def to_df(self) -> pd.DataFrame:
            return pd.DataFrame(
                {
                    "date": [now],
                    "symbol": ["DEXUSEU"],
                    "value": [1.12],
                }
            )

    class FakeFred:
        def fred_series(self, **kwargs: object) -> FakeResponse:
            seen.update(kwargs)
            return FakeResponse()

    fake_openbb = SimpleNamespace(
        obb=SimpleNamespace(
            user=SimpleNamespace(credentials=SimpleNamespace()),
            economy=FakeFred(),
        )
    )
    monkeypatch.setattr(macro_module, "_get_openbb_client", lambda: fake_openbb.obb)
    monkeypatch.setattr(settings, "FRED_API_KEY", "unit-test-key")

    points = _fetch_openbb_observations("EUR/USD")

    assert seen["provider"] == "fred"
    assert "DEXUSEU" in seen["symbol"]
    assert points[0].name == "DEXUSEU"
    assert points[0].value == pytest.approx(1.12)
    assert points[0].as_of.tzinfo is not None
    assert points[0].timestamp_precision == "date"
    assert points[0].source == "FRED via OpenBB"


def test_openbb_requires_credential_and_maps_missing_sdk_as_unavailable(
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "FRED_API_KEY", None)
    with pytest.raises(OpenBBUnavailableError, match="FRED_API_KEY"):
        _fetch_openbb_observations("EUR/USD")

    def unavailable(symbol: str) -> list[MacroDataPoint]:
        del symbol
        raise OpenBBUnavailableError("OpenBB SDK is not installed")

    result = asyncio.run(
        MacroProvider(fetcher=unavailable).evaluate(_request(symbol="EUR/USD"))
    )
    assert result.status == ProviderStatus.UNAVAILABLE
    assert result.score is None


def test_openbb_sdk_warmup_is_nonblocking_and_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr(settings, "FRED_API_KEY", "unit-test-key")

    def warming() -> object:
        raise OpenBBUnavailableError("OpenBB SDK is initializing; retry shortly")

    monkeypatch.setattr(macro_module, "_get_openbb_client", warming)
    result = asyncio.run(
        MacroProvider().evaluate(_request(symbol="EUR/USD"))
    )
    assert result.status == ProviderStatus.UNAVAILABLE
    assert "initializing" in (result.reason or "")
    assert result.score is None


def test_macro_provider_scores_aligned_fresh_fx_and_preserves_observations() -> None:
    now = datetime.now(timezone.utc)
    points = [
        _macro_point("DEXUSEU", 1.10, now - timedelta(minutes=2)),
        _macro_point("DEXUSEU", 1.11, now - timedelta(minutes=1)),
        _macro_point(
            "DFF",
            5.25,
            now - timedelta(minutes=1),
            category="interest_rate",
        ),
    ]
    result = asyncio.run(
        MacroProvider(fetcher=_macro_fetcher(points)).evaluate(
            _request(symbol="EUR/USD")
        )
    )

    assert result.status == ProviderStatus.OK
    assert result.direction == Direction.BUY
    assert result.score is not None and result.score > 0
    assert result.confidence_unit == "percent"
    assert len(result.evidence["data_points"]) == 3
    assert result.evidence["source"] == "FRED via OpenBB"


def test_macro_provider_degrades_stale_fred_data_without_direction() -> None:
    stale = datetime.now(timezone.utc) - timedelta(days=1)
    result = asyncio.run(
        MacroProvider(
            fetcher=_macro_fetcher([
                _macro_point("DEXUSEU", 1.10, stale),
                _macro_point("DEXUSEU", 1.11, stale + timedelta(minutes=1)),
            ])
        ).evaluate(_request(symbol="EUR/USD"))
    )

    assert result.status == ProviderStatus.DEGRADED
    assert result.direction is None
    assert result.score is None
    assert "stale evidence" in (result.reason or "")


def test_macro_provider_rejects_date_only_timestamps_even_if_midnight_is_recent() -> None:
    now = datetime.now(timezone.utc)
    points = [
        _macro_point(
            "DEXUSEU",
            1.10,
            now - timedelta(minutes=2),
        ).model_copy(update={"timestamp_precision": "date"}),
        _macro_point(
            "DEXUSEU",
            1.11,
            now - timedelta(minutes=1),
        ).model_copy(update={"timestamp_precision": "date"}),
    ]
    result = asyncio.run(
        MacroProvider(fetcher=_macro_fetcher(points)).evaluate(
            _request(symbol="EUR/USD")
        )
    )
    assert result.status == ProviderStatus.DEGRADED
    assert result.score is None
    assert "date-only timestamp precision" in (result.reason or "")


def test_macro_provider_requires_two_aligned_real_fx_observations() -> None:
    now = datetime.now(timezone.utc)
    result = asyncio.run(
        MacroProvider(
            fetcher=_macro_fetcher([
                _macro_point("DEXUSEU", 1.10, now - timedelta(minutes=1))
            ])
        ).evaluate(_request(symbol="EUR/USD"))
    )
    assert result.status == ProviderStatus.UNAVAILABLE
    assert result.score is None


def _write_model_artifact(path, *, timeframe: str = "1h") -> None:
    features = np.asarray(
        [
            [-0.20, 0.10],
            [-0.10, 0.05],
            [-0.05, 0.10],
            [0.02, 0.05],
            [0.10, 0.10],
            [0.20, 0.15],
        ],
        dtype=np.float64,
    )
    labels = np.asarray([0, 0, 0, 1, 1, 1], dtype=np.int64)
    classifier = LogisticRegression(random_state=7).fit(features, labels)
    joblib.dump(
        {
            "metadata": {
                "schema_version": SCHEMA_VERSION,
                "timeframe": timeframe,
                "model": "unit-test-logistic",
                "version": "test-1",
                "trained_at": datetime.now(timezone.utc).isoformat(),
                "feature_names": ["return_1", "volatility_5"],
                "probability_calibrated": True,
            },
            "model": classifier,
        },
        path,
    )


def test_local_qlib_inference_scores_real_fresh_bars_from_trusted_artifact(tmp_path) -> None:
    path = tmp_path / "model.joblib"
    _write_model_artifact(path)

    result = asyncio.run(
        MLProvider(model_path=str(path)).evaluate(
            _request(timeframe="1h", bars=_candles())
        )
    )

    assert result.status == ProviderStatus.OK
    assert result.direction in (Direction.BUY, Direction.SELL, Direction.NEUTRAL)
    assert result.score is not None and -1.0 <= result.score <= 1.0
    assert result.confidence_unit == "percent"
    assert result.confidence is not None and 0.0 <= result.confidence <= 100.0
    assert result.evidence["schema_version"] == SCHEMA_VERSION
    assert result.evidence["probability_calibrated"] is True
    assert result.evidence["timeframe"] == "1h"


def test_local_qlib_inference_fails_closed_for_missing_artifact_and_stale_bars(
    tmp_path,
) -> None:
    missing = asyncio.run(
        MLProvider(model_path=str(tmp_path / "missing.joblib")).evaluate(
            _request(timeframe="1h", bars=_candles())
        )
    )
    stale = asyncio.run(
        MLProvider(model_path=str(tmp_path / "not-loaded.joblib")).evaluate(
            _request(
                timeframe="1h",
                bars=_candles(age_seconds=3 * 3_600),
            )
        )
    )

    assert missing.status == ProviderStatus.UNAVAILABLE
    assert missing.score is None
    assert stale.status == ProviderStatus.UNAVAILABLE
    assert stale.score is None
    assert "stale candles" in (stale.reason or "")


def test_local_qlib_inference_rejects_timeframe_mismatch(tmp_path) -> None:
    path = tmp_path / "model.joblib"
    _write_model_artifact(path, timeframe="5m")

    result = asyncio.run(
        MLProvider(model_path=str(path)).evaluate(
            _request(timeframe="1h", bars=_candles())
        )
    )
    assert result.status == ProviderStatus.ERROR
    assert result.score is None


def test_local_qlib_inference_is_unavailable_without_configured_model() -> None:
    result = asyncio.run(
        MLProvider(model_path="").evaluate(
            _request(timeframe="1h", bars=_candles())
        )
    )
    assert result.status == ProviderStatus.UNAVAILABLE
    assert result.score is None
