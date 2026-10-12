"""PART 44.1 [503] — the AI engine's HTTP fallback must authenticate to
POST /signals/receive with the shared service key (X-API-Key).

The receiver is now gated by `requireAiEngineKey` (core-backend
`internalAuth.middleware.ts`). The publisher is the only legitimate caller of
that fallback, so it must present `X-API-Key: AI_ENGINE_API_KEY` — otherwise the
gated receiver would reject the engine's own fallback in production.
"""

from __future__ import annotations

import asyncio
import types

import pytest


class _Resp:
    status_code = 200


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list = []

    async def post(self, url, json=None, headers=None):  # noqa: A002
        self.calls.append({"url": url, "json": json, "headers": headers})
        return _Resp()

    async def aclose(self) -> None:
        pass


def _publisher_with(monkeypatch, api_key):
    import app.messaging.publisher as pubmod

    stub = types.SimpleNamespace(
        BACKEND_API_URL="http://backend:4000/api/v1",
        AI_ENGINE_API_KEY=api_key,
        redis_connection_url="redis://localhost:6379",
    )
    monkeypatch.setattr(pubmod, "settings", stub)

    pub = pubmod.RedisPublisher()
    fake = _FakeClient()
    pub.http_client = fake
    pub.redis_client = None  # force the HTTP fallback path
    return pub, fake


def test_http_fallback_sends_the_shared_service_key(monkeypatch):
    pub, fake = _publisher_with(monkeypatch, "shared-service-secret")

    asyncio.run(pub.publish_signal("signals", {"symbol": "EUR/USD"}))

    assert fake.calls, "HTTP fallback did not POST"
    call = fake.calls[0]
    assert call["url"] == "http://backend:4000/api/v1/signals/receive"
    assert call["headers"]["X-API-Key"] == "shared-service-secret"


def test_http_fallback_omits_the_header_when_no_key_configured(monkeypatch):
    pub, fake = _publisher_with(monkeypatch, None)

    asyncio.run(pub.publish_signal("signals", {"symbol": "EUR/USD"}))

    assert fake.calls, "HTTP fallback did not POST"
    assert "X-API-Key" not in (fake.calls[0]["headers"] or {})
