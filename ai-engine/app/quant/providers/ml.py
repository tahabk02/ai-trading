"""Local Qlib-factor inference against a trusted calibrated model artifact.

The adapter engineers a fixed, versioned factor vector from observed bars and
scores it with an operator-provisioned sklearn-compatible classifier artifact.
It never trains on the request, invents labels, substitutes a heuristic model,
or uses synthetic bars. Artifacts are pickle-based joblib files and MUST be
trusted deployment inputs.
"""

from __future__ import annotations

import asyncio
import math
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Protocol, Sequence, cast

import joblib
import numpy as np

from app.core.config import settings
from app.quant.contracts import (
    SCHEMA_VERSION,
    Candle,
    ConfluenceRequest,
    Direction,
    MLProviderResponse,
    ProviderResult,
    ProviderStatus,
    QlibArtifactMetadata,
)
from app.quant.providers.base import ConfluenceProvider
from app.quant.providers.technical import (
    candle_series_error,
    latest_candle_timestamp,
)

QLIB_FACTOR_NAMES = (
    "return_1",
    "return_3",
    "return_5",
    "return_10",
    "momentum_5",
    "momentum_20",
    "volatility_5",
    "volatility_20",
    "range_pct",
    "atr_14_pct",
    "close_vs_sma_5",
    "close_vs_sma_20",
)
MAX_MODEL_BYTES = 256 * 1024 * 1024
MIN_BARS_FOR_FACTORS = 21


class ProbabilisticClassifier(Protocol):
    classes_: Sequence[object]

    def predict_proba(self, features: np.ndarray) -> object: ...


class QlibArtifactTimeframeError(ValueError):
    """The configured model was trained for another candle interval."""


def _factor_values(candles: list[Candle]) -> dict[str, float]:
    if len(candles) < MIN_BARS_FOR_FACTORS:
        raise ValueError(f"at least {MIN_BARS_FOR_FACTORS} observed bars are required")

    closes = np.asarray([candle.close for candle in candles], dtype=np.float64)
    highs = np.asarray([candle.high for candle in candles], dtype=np.float64)
    lows = np.asarray([candle.low for candle in candles], dtype=np.float64)
    if not all(np.all(np.isfinite(values)) for values in (closes, highs, lows)):
        raise ValueError("input bars contain non-finite prices")
    if np.any(closes <= 0.0):
        raise ValueError("input bars contain non-positive closes")

    log_returns = np.diff(np.log(closes))
    true_ranges = np.maximum.reduce(
        (
            highs[1:] - lows[1:],
            np.abs(highs[1:] - closes[:-1]),
            np.abs(lows[1:] - closes[:-1]),
        )
    )
    atr_14 = float(np.mean(true_ranges[-14:]))
    latest_close = float(closes[-1])
    if not math.isfinite(atr_14) or atr_14 <= 0:
        raise ValueError("observed bars have no positive ATR")

    def return_over(period: int) -> float:
        return float(math.log(closes[-1] / closes[-period - 1]))

    factors = {
        "return_1": return_over(1),
        "return_3": return_over(3),
        "return_5": return_over(5),
        "return_10": return_over(10),
        "momentum_5": return_over(5),
        "momentum_20": return_over(20),
        "volatility_5": float(np.std(log_returns[-5:], ddof=0)),
        "volatility_20": float(np.std(log_returns[-20:], ddof=0)),
        "range_pct": float((highs[-1] - lows[-1]) / latest_close),
        "atr_14_pct": atr_14 / latest_close,
        "close_vs_sma_5": float(latest_close / np.mean(closes[-5:]) - 1.0),
        "close_vs_sma_20": float(latest_close / np.mean(closes[-20:]) - 1.0),
    }
    if not all(math.isfinite(value) for value in factors.values()):
        raise ValueError("factor extraction returned non-finite values")
    return factors


@lru_cache(maxsize=8)
def _load_trusted_artifact(
    path: str,
    modified_ns: int,
    size_bytes: int,
) -> tuple[QlibArtifactMetadata, ProbabilisticClassifier]:
    del modified_ns
    if size_bytes > MAX_MODEL_BYTES:
        raise ValueError("Qlib model artifact exceeds the configured size limit")
    bundle: object = joblib.load(path)
    if not isinstance(bundle, dict):
        raise ValueError("Qlib artifact must be a mapping with metadata and model")
    metadata_value = bundle.get("metadata")
    model_value = bundle.get("model")
    if not isinstance(metadata_value, dict):
        raise ValueError("Qlib artifact metadata is missing")
    metadata = QlibArtifactMetadata.model_validate(metadata_value)
    if not all(name in QLIB_FACTOR_NAMES for name in metadata.feature_names):
        raise ValueError("Qlib artifact requests unsupported factor names")
    if not callable(getattr(model_value, "predict_proba", None)):
        raise ValueError("Qlib artifact model must implement predict_proba")
    classes = getattr(model_value, "classes_", None)
    class_values = np.asarray(classes).tolist() if classes is not None else []
    if class_values != [0, 1]:
        raise ValueError("Qlib artifact classifier classes must be exactly [0, 1]")
    return metadata, cast(ProbabilisticClassifier, model_value)


def _load_artifact(path: str) -> tuple[QlibArtifactMetadata, ProbabilisticClassifier]:
    artifact_path = Path(path).expanduser().resolve(strict=True)
    if not artifact_path.is_file():
        raise ValueError("QLIB_MODEL_PATH must point to a regular model artifact file")
    stat = artifact_path.stat()
    return _load_trusted_artifact(
        str(artifact_path),
        stat.st_mtime_ns,
        stat.st_size,
    )


def _score_model(
    model: ProbabilisticClassifier,
    feature_names: list[str],
    factors: dict[str, float],
) -> float:
    vector = np.asarray(
        [[factors[name] for name in feature_names]],
        dtype=np.float64,
    )
    probabilities = np.asarray(model.predict_proba(vector), dtype=np.float64)
    if probabilities.shape != (1, 2) or not np.all(np.isfinite(probabilities)):
        raise ValueError("Qlib classifier returned invalid probability dimensions")
    row = probabilities[0]
    if np.any(row < 0.0) or np.any(row > 1.0) or not math.isclose(
        float(np.sum(row)), 1.0, rel_tol=1e-6, abs_tol=1e-6
    ):
        raise ValueError("Qlib classifier returned invalid class probabilities")
    return float(row[1])


def _run_local_inference(
    path: str,
    timeframe: str,
    candles: list[Candle],
) -> tuple[QlibArtifactMetadata, dict[str, float], float]:
    metadata, model = _load_artifact(path)
    if metadata.timeframe != timeframe:
        raise QlibArtifactTimeframeError
    factors = _factor_values(candles)
    probability_up = _score_model(model, metadata.feature_names, factors)
    return metadata, factors, probability_up


def _consume_inference_exception(
    task: asyncio.Task[tuple[QlibArtifactMetadata, dict[str, float], float]],
) -> None:
    if not task.cancelled():
        task.exception()


class MLProvider(ConfluenceProvider):
    """Run local factor extraction and inference from a calibrated artifact."""

    name = "ml"
    weight = 0.30
    description = "Local Qlib factors scored by an operator-provisioned model"

    def __init__(
        self,
        model_path: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        self._model_path = (
            model_path if model_path is not None else settings.QLIB_MODEL_PATH
        )
        self._model_path = self._model_path.strip() if self._model_path else None
        self._timeout_seconds = (
            timeout_seconds
            if timeout_seconds is not None
            else settings.QUANT_PROVIDER_TIMEOUT_SECONDS
        )
        if self._timeout_seconds <= 0:
            raise ValueError("Qlib inference timeout must be positive")
        self._active_inference: asyncio.Task[
            tuple[QlibArtifactMetadata, dict[str, float], float]
        ] | None = None

    async def evaluate(self, request: ConfluenceRequest) -> ProviderResult:
        if not self._model_path:
            return self.unavailable("QLIB_MODEL_PATH is not configured")
        if not request.candles:
            return self.unavailable("Qlib inference requires observed candles")
        freshness_error = candle_series_error(request.candles, request.timeframe)
        if freshness_error is not None:
            return self.unavailable(f"Qlib input bars rejected: {freshness_error}")

        input_as_of = latest_candle_timestamp(request.candles)
        if input_as_of is None:
            return self.unavailable("Qlib input bars have no valid latest timestamp")

        if self._active_inference is not None and not self._active_inference.done():
            return self.unavailable("local Qlib inference is still in progress")
        inference_task = asyncio.create_task(
            asyncio.to_thread(
                _run_local_inference,
                self._model_path,
                request.timeframe,
                request.candles,
            )
        )
        self._active_inference = inference_task
        inference_task.add_done_callback(_consume_inference_exception)
        try:
            metadata, factors, probability_up = await asyncio.wait_for(
                asyncio.shield(inference_task),
                timeout=self._timeout_seconds,
            )
        except asyncio.TimeoutError:
            return self.error(
                f"Qlib local inference timed out after {self._timeout_seconds:.1f}s"
            )
        except QlibArtifactTimeframeError:
            return self.error("Qlib model timeframe does not match the request")
        except FileNotFoundError:
            return self.unavailable("configured Qlib model artifact does not exist")
        except (ValueError, OSError, TypeError, ImportError) as exc:
            return self.error(f"Qlib local inference rejected ({type(exc).__name__})")
        except Exception as exc:
            return self.error(f"Qlib local inference failed ({type(exc).__name__})")
        finally:
            if inference_task.done() and self._active_inference is inference_task:
                self._active_inference = None

        if probability_up > 0.5:
            direction = Direction.BUY
            confidence = probability_up
        elif probability_up < 0.5:
            direction = Direction.SELL
            confidence = 1.0 - probability_up
        else:
            direction = Direction.NEUTRAL
            confidence = 0.5

        score = 2.0 * probability_up - 1.0
        inference = MLProviderResponse(
            schema_version=SCHEMA_VERSION,
            direction=direction,
            probability=confidence,
            probability_unit="fraction",
            timeframe=metadata.timeframe,
            input_as_of=input_as_of,
            model=metadata.model,
            version=metadata.version,
            as_of=datetime.now(timezone.utc),
        )
        return ProviderResult(
            name=self.name,
            status=ProviderStatus.OK,
            weight=self.weight,
            direction=inference.direction,
            score=score,
            confidence=inference.probability * 100.0,
            evidence={
                **inference.model_dump(mode="json"),
                "trained_at": metadata.trained_at.isoformat(),
                "probability_calibrated": True,
                "probability_up": probability_up,
                "factor_names": metadata.feature_names,
                "factors": factors,
            },
        )

    def is_requested(self, request: ConfluenceRequest) -> bool:
        del request
        return True

    async def close(self) -> None:
        return None
