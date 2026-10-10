"""test_health.py — PART 43 [432] WARM-START HEALTH CONTRACT.

The go-live stack boots the engine and immediately probes
``GET /api/v1/health`` from two angles:

  * the container healthcheck (``docker-compose.prod.yml`` — urllib raises on
    any non-2xx, so the probe MUST see 200 even mid-warmup), and
  * core-backend, which gates live predict traffic on the engine being up.

Warming the model cache can take minutes. The contract this file locks is:

    cold / warming  → HTTP 200, status "degraded", healthy false
    hot              → HTTP 200, status "healthy",  healthy true

i.e. "degraded" is an availability state, NOT an HTTP failure. A 503-while-
warming would flap the healthcheck red on every cold start and take the stack
down with it.
"""

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.api.v1.health import health_report
from app.core import runtime_state
from app.main import app
from app.services import ml_predictor
from app.services.ml_predictor import ModelCache

CLIENT = TestClient(app)


@pytest.fixture(autouse=True)
def _reset_warmup_state():
    """No warmup / health-error state survives a test (both are process-global)."""
    runtime_state.set_warmup_running(False)
    runtime_state.set_warmup_progress(0, 0)
    runtime_state.set_last_health_error(None)
    yield
    runtime_state.set_warmup_running(False)
    runtime_state.set_warmup_progress(0, 0)
    runtime_state.set_last_health_error(None)


def _force_cache_size(monkeypatch, size: int) -> None:
    """ModelCache.size is a read-only property; override it for the test only."""
    monkeypatch.setattr(ModelCache, "size", property(lambda self: size))


class TestHealthPayloadContract:
    def test_cold_cache_is_degraded_not_healthy(self, monkeypatch):
        _force_cache_size(monkeypatch, 0)
        runtime_state.set_warmup_running(False)

        report = health_report()

        assert report["status"] == "degraded"
        assert report["healthy"] is False
        assert report["model_cache_size"] == 0

    def test_warming_with_models_still_degraded(self, monkeypatch):
        _force_cache_size(monkeypatch, 5)
        runtime_state.set_warmup_running(True)
        runtime_state.set_warmup_progress(3, 12)

        report = health_report()

        assert report["status"] == "degraded"
        assert report["healthy"] is False
        assert report["warmup_running"] is True
        assert report["warmup_progress"] == {"completed": 3, "total": 12}

    def test_hot_cache_is_healthy(self, monkeypatch):
        _force_cache_size(monkeypatch, 5)
        runtime_state.set_warmup_running(False)

        report = health_report()

        assert report["status"] == "healthy"
        assert report["healthy"] is True

    def test_surfaces_last_health_error(self, monkeypatch):
        _force_cache_size(monkeypatch, 0)
        runtime_state.set_last_health_error("warmup aborted")

        assert health_report()["last_error"] == "warmup aborted"


class TestHealthRouteStatus:
    """The probe status is the contract — degraded must never become non-2xx."""

    def test_degraded_while_warming_is_http_200(self, monkeypatch):
        _force_cache_size(monkeypatch, 0)
        runtime_state.set_warmup_running(True)

        r = CLIENT.get("/api/v1/health")

        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "degraded"
        assert body["healthy"] is False

    def test_cold_is_http_200(self, monkeypatch):
        _force_cache_size(monkeypatch, 0)
        runtime_state.set_warmup_running(False)

        r = CLIENT.get("/api/v1/health")

        assert r.status_code == 200
        assert r.json()["status"] == "degraded"

    def test_healthy_is_http_200(self, monkeypatch):
        _force_cache_size(monkeypatch, 5)
        runtime_state.set_warmup_running(False)

        r = CLIENT.get("/api/v1/health")

        assert r.status_code == 200
        assert r.json()["status"] == "healthy"

    def test_report_timestamp_is_utc_iso(self, monkeypatch):
        _force_cache_size(monkeypatch, 5)
        parsed = datetime.fromisoformat(health_report()["timestamp"])
        assert parsed.tzinfo == UTC
