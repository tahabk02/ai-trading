"""Direct local OpenBB/FRED macro adapter.

OpenBB calls are synchronous, so the SDK request is run in a worker thread.
Observed FRED dates are retained as observation timestamps (date-only FRED
observations are represented at 00:00 UTC); they are never changed to fetch
time to make stale data appear fresh.
"""

from __future__ import annotations

import asyncio
import importlib
import math
import threading
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pandas as pd

from app.core.config import settings
from app.quant.contracts import (
    SCHEMA_VERSION,
    ConfluenceRequest,
    MacroDataPoint,
    MacroProviderResponse,
    ProviderResult,
    ProviderStatus,
)
from app.quant.providers.base import ConfluenceProvider, feature_freshness_error
from app.quant.providers.sentiment import direction_from_score

OpenBBFetcher = Callable[[str], list[MacroDataPoint]]

_PAIR_SERIES: dict[str, tuple[tuple[str, int], ...]] = {
    "EUR/USD": (("DEXUSEU", 1),),
    "USD/JPY": (("DEXJPUS", 1),),
    "USD/CHF": (("DEXSZUS", 1),),
    "USD/CAD": (("DEXCAUS", 1),),
    "AUD/USD": (("DEXUSAL", 1),),
    "EUR/JPY": (("DEXUSEU", 1), ("DEXJPUS", 1)),
    "EUR/CHF": (("DEXUSEU", 1), ("DEXSZUS", 1)),
    "EUR/AUD": (("DEXUSEU", 1), ("DEXUSAL", -1)),
    "EUR/CAD": (("DEXUSEU", 1), ("DEXCAUS", 1)),
    "AUD/JPY": (("DEXUSAL", 1), ("DEXJPUS", 1)),
    "CAD/JPY": (("DEXJPUS", 1), ("DEXCAUS", -1)),
    "CHF/JPY": (("DEXJPUS", 1), ("DEXSZUS", -1)),
    "AUD/CAD": (("DEXUSAL", 1), ("DEXCAUS", 1)),
    "AUD/NZD": (("DEXUSAL", 1), ("DEXUSNZ", -1)),
    "CAD/CHF": (("DEXCAUS", 1), ("DEXSZUS", -1)),
    "USD/MXN": (("DEXMXUS", 1),),
    "USD/SGD": (("DEXSIUS", 1),),
    "USD/NOK": (("DEXNOUS", 1),),
    "USD/PLN": (("DEXPOUS", 1),),
}
_MACRO_SERIES: dict[str, tuple[str, str]] = {
    "DFF": ("interest_rate", "percent"),
    "DGS2": ("yield_curve", "percent"),
    "DGS10": ("yield_curve", "percent"),
    "DTWEXBGS": ("fx_index", "index_points"),
    "DCOILWTICO": ("commodity", "USD_per_barrel"),
}
_RETURN_NORMALIZER = 0.01
_MAX_FETCH_DAYS = 30
_OPENBB_STATE_LOCK = threading.Lock()
_OPENBB_READY = threading.Event()
_OPENBB_INIT_STARTED = False
_OPENBB_CLIENT: Any | None = None
_OPENBB_LOAD_ERROR: str | None = None


class OpenBBUnavailableError(RuntimeError):
    """Local OpenBB/FRED integration is not configured or installed."""


def _initialize_openbb_client() -> None:
    global _OPENBB_CLIENT, _OPENBB_LOAD_ERROR
    try:
        module = importlib.import_module("openbb")
        obb = getattr(module, "obb")
        getattr(obb.economy, "fred_series")
    except Exception as exc:
        _OPENBB_LOAD_ERROR = type(exc).__name__
    else:
        _OPENBB_CLIENT = obb
    finally:
        _OPENBB_READY.set()


def _get_openbb_client() -> Any:
    global _OPENBB_INIT_STARTED, _OPENBB_LOAD_ERROR
    if not _OPENBB_READY.is_set():
        with _OPENBB_STATE_LOCK:
            if not _OPENBB_INIT_STARTED:
                _OPENBB_INIT_STARTED = True
                initializer = threading.Thread(
                    target=_initialize_openbb_client,
                    name="openbb-sdk-initializer",
                    daemon=True,
                )
                try:
                    initializer.start()
                except (RuntimeError, OSError) as exc:
                    _OPENBB_LOAD_ERROR = type(exc).__name__
                    _OPENBB_READY.set()
        raise OpenBBUnavailableError("OpenBB SDK is initializing; retry shortly")
    if _OPENBB_LOAD_ERROR is not None or _OPENBB_CLIENT is None:
        error = _OPENBB_LOAD_ERROR or "OpenBB SDK initialization failed"
        raise OpenBBUnavailableError(f"OpenBB economy/FRED SDK unavailable ({error})")
    return _OPENBB_CLIENT


def _consume_task_exception(task: asyncio.Task[list[MacroDataPoint]]) -> None:
    if not task.cancelled():
        task.exception()


def _observation_datetime(value: object) -> datetime | None:
    if isinstance(value, pd.Timestamp):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time(), timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            try:
                parsed_date = date.fromisoformat(value)
            except ValueError:
                return None
            return datetime.combine(parsed_date, datetime.min.time(), timezone.utc)
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    return None


def _macro_freshness_error(point: MacroDataPoint) -> str | None:
    if point.timestamp_precision != "instant":
        return "macro observation has date-only timestamp precision"
    return feature_freshness_error(point.as_of)


def _fetch_openbb_observations(symbol: str) -> list[MacroDataPoint]:
    if not settings.FRED_API_KEY or not settings.FRED_API_KEY.strip():
        raise OpenBBUnavailableError("FRED_API_KEY is not configured")
    try:
        obb = _get_openbb_client()
        obb.user.credentials.fred_api_key = settings.FRED_API_KEY.strip()
        series_ids = sorted(
            {series for series, _ in _PAIR_SERIES.get(symbol, ())}
            | set(_MACRO_SERIES)
        )
        response = obb.economy.fred_series(
            symbol=series_ids,
            start_date=(datetime.now(timezone.utc) - timedelta(days=_MAX_FETCH_DAYS))
            .date()
            .isoformat(),
            provider="fred",
        )
        frame = response.to_df()
    except (ImportError, AttributeError) as exc:
        raise OpenBBUnavailableError(
            "OpenBB economy/FRED SDK extensions are not installed"
        ) from exc

    if not isinstance(frame, pd.DataFrame) or frame.empty:
        raise RuntimeError("OpenBB returned no macro observations")

    columns = {str(column).lower(): column for column in frame.columns}
    date_column = columns.get("date") or columns.get("datetime")
    symbol_column = columns.get("symbol") or columns.get("series_id")
    value_column = columns.get("value")
    if date_column is None or value_column is None:
        raise RuntimeError("OpenBB response lacks date/value columns")
    if symbol_column is None and len(series_ids) != 1:
        raise RuntimeError("OpenBB response lacks a series identifier column")

    points: list[MacroDataPoint] = []
    for row in frame.to_dict(orient="records"):
        series_id = str(row[symbol_column]).upper() if symbol_column else series_ids[0]
        if series_id not in series_ids:
            continue
        as_of = _observation_datetime(row[date_column])
        try:
            value = float(row[value_column])
        except (TypeError, ValueError):
            continue
        if as_of is None or not math.isfinite(value):
            continue
        category, unit = _MACRO_SERIES.get(series_id, ("fx_rate", "provider_units"))
        points.append(
            MacroDataPoint(
                schema_version=SCHEMA_VERSION,
                category=category,
                name=series_id,
                value=value,
                unit=unit,
                source="FRED via OpenBB",
                timestamp_precision="date",
                as_of=as_of.astimezone(timezone.utc),
            )
        )
    if not points:
        raise RuntimeError("OpenBB returned no usable timestamped observations")
    return points


class MacroProvider(ConfluenceProvider):
    """Fetch actual FRED observations through the installed OpenBB SDK."""

    name = "macro"
    weight = 0.15
    description = "OpenBB/FRED FX, rates, yield curve, dollar index and oil data"

    def __init__(
        self,
        fetcher: OpenBBFetcher | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        self._fetcher = (
            _fetch_openbb_observations if fetcher is None else fetcher
        )
        self._timeout_seconds = (
            timeout_seconds
            if timeout_seconds is not None
            else settings.QUANT_PROVIDER_TIMEOUT_SECONDS
        )
        if self._timeout_seconds <= 0:
            raise ValueError("OpenBB timeout must be positive")
        self._active_fetch: asyncio.Task[list[MacroDataPoint]] | None = None

    async def evaluate(self, request: ConfluenceRequest) -> ProviderResult:
        if request.symbol not in _PAIR_SERIES:
            return self.unavailable(
                "OpenBB/FRED FX mapping is not configured for this symbol"
            )
        if self._fetcher is _fetch_openbb_observations:
            if not settings.FRED_API_KEY or not settings.FRED_API_KEY.strip():
                return self.unavailable("FRED_API_KEY is not configured")
            try:
                _get_openbb_client()
            except OpenBBUnavailableError as exc:
                return self.unavailable(str(exc))
        if self._active_fetch is not None and not self._active_fetch.done():
            return self.unavailable("an OpenBB request is still in progress")
        fetch_task = asyncio.create_task(asyncio.to_thread(self._fetcher, request.symbol))
        self._active_fetch = fetch_task
        fetch_task.add_done_callback(_consume_task_exception)
        try:
            points = await asyncio.wait_for(
                asyncio.shield(fetch_task),
                timeout=self._timeout_seconds,
            )
        except asyncio.TimeoutError:
            return self.error(
                f"OpenBB request timed out after {self._timeout_seconds:.1f}s"
            )
        except OpenBBUnavailableError as exc:
            return self.unavailable(str(exc))
        except Exception as exc:
            return self.error(f"OpenBB request failed ({type(exc).__name__})")
        finally:
            if fetch_task.done() and self._active_fetch is fetch_task:
                self._active_fetch = None

        freshness_error = next(
            (
                error
                for point in points
                if (error := _macro_freshness_error(point)) is not None
            ),
            None,
        )
        if freshness_error is not None:
            return ProviderResult(
                name=self.name,
                status=ProviderStatus.DEGRADED,
                weight=self.weight,
                reason=f"stale or invalid macro observations: {freshness_error}",
                evidence={
                    "source": "FRED via OpenBB",
                    "observations_received": len(points),
                },
            )

        change = self._pair_log_return(request.symbol, points)
        if change is None:
            return self.unavailable(
                "OpenBB lacks two aligned real FX observations for the requested pair"
            )
        score = math.tanh(change / _RETURN_NORMALIZER)
        confidence = min(100.0, abs(change / _RETURN_NORMALIZER) * 100.0)
        assessment = MacroProviderResponse(
            schema_version=SCHEMA_VERSION,
            score=score,
            confidence=confidence,
            confidence_unit="percent",
            source="FRED via OpenBB",
            methodology="signed_fx_log_return_1d_normalized_by_1pct_v1",
            data_points=points,
            as_of=min(point.as_of for point in points),
        )
        return ProviderResult(
            name=self.name,
            status=ProviderStatus.OK,
            weight=self.weight,
            direction=direction_from_score(assessment.score),
            score=assessment.score,
            confidence=assessment.confidence,
            evidence={
                **assessment.model_dump(mode="json"),
                "return_normalizer": _RETURN_NORMALIZER,
                "pair_log_return": change,
            },
        )

    def is_requested(self, request: ConfluenceRequest) -> bool:
        del request
        return True

    @staticmethod
    def _pair_log_return(
        symbol: str, points: list[MacroDataPoint]
    ) -> float | None:
        series_legs = _PAIR_SERIES.get(symbol)
        if not series_legs:
            return None
        by_series: dict[str, dict[datetime, float]] = {}
        for point in points:
            if point.name in {series for series, _ in series_legs}:
                by_series.setdefault(point.name, {})[point.as_of] = point.value
        common_dates: set[datetime] | None = None
        for series, _ in series_legs:
            dates = set(by_series.get(series, {}))
            common_dates = dates if common_dates is None else common_dates & dates
        if common_dates is None or len(common_dates) < 2:
            return None
        latest_dates = sorted(common_dates)[-2:]
        previous_date, current_date = latest_dates
        log_return = 0.0
        for series, sign in series_legs:
            previous = by_series[series][previous_date]
            current = by_series[series][current_date]
            if previous <= 0.0 or current <= 0.0:
                return None
            log_return += sign * math.log(current / previous)
        return log_return if math.isfinite(log_return) else None

    async def close(self) -> None:
        return None
