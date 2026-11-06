"""Bounded async HTTP transport for optional external quant providers."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlparse

import httpx


class ProviderTransportError(RuntimeError):
    """Sanitized upstream failure safe to expose in provider diagnostics."""


class AsyncJSONProviderClient:
    """Pooled JSON POST client with bounded rate-limit/server-error handling.

    Endpoints are operator-configured trusted service URLs. Responses are
    validated by provider-specific Pydantic models before they enter the
    confluence aggregate. This client never returns stale cached content.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        api_key: str | None = None,
        timeout_seconds: float = 2.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("provider endpoint must be an absolute HTTP(S) URL")
        if api_key and parsed.scheme != "https":
            raise ValueError("provider API keys require an HTTPS endpoint")
        if timeout_seconds <= 0:
            raise ValueError("provider timeout must be positive")

        self.endpoint = endpoint
        self.timeout_seconds = timeout_seconds
        self._api_key = api_key.strip() if api_key and api_key.strip() else None
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
            follow_redirects=False,
        )
        self._owns_client = client is None

    async def post_json(self, payload: dict[str, Any]) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        for attempt in range(2):
            try:
                response = await self._client.post(
                    self.endpoint,
                    json=payload,
                    headers=headers,
                    timeout=self.timeout_seconds,
                )
            except httpx.TimeoutException as exc:
                raise ProviderTransportError("upstream request timed out") from exc
            except httpx.RequestError as exc:
                raise ProviderTransportError(
                    f"upstream network error ({type(exc).__name__})"
                ) from exc

            if response.status_code == 429:
                retry_after = _retry_after_seconds(response)
                if attempt == 0 and retry_after is not None and retry_after <= 0.2:
                    await asyncio.sleep(retry_after)
                    continue
                raise ProviderTransportError("upstream rate limited the request")

            if response.status_code >= 500:
                if attempt == 0:
                    await asyncio.sleep(0.1)
                    continue
                raise ProviderTransportError(
                    f"upstream server error (HTTP {response.status_code})"
                )

            if response.status_code >= 400:
                raise ProviderTransportError(
                    f"upstream rejected the request (HTTP {response.status_code})"
                )

            try:
                body = response.json()
            except ValueError as exc:
                raise ProviderTransportError("upstream returned invalid JSON") from exc
            if not isinstance(body, dict):
                raise ProviderTransportError("upstream response must be a JSON object")
            return body

        raise ProviderTransportError("upstream retry budget exhausted")

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()


def _retry_after_seconds(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return seconds if 0.0 <= seconds <= 60.0 else None
