from fastapi import Depends, Header, HTTPException
from typing import Optional
from app.core.config import settings
import secrets as _secrets


def _configured_key() -> Optional[str]:
    key = settings.AI_ENGINE_API_KEY
    if key and key.strip():
        return key.strip()
    return None


async def get_api_key(
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    api_key: Optional[str] = Header(None, include_in_schema=False),
):
    """
    Validate internal service communication via API key.

    Notes:
    * The expected value comes from AI_ENGINE_API_KEY (set on both sides), never
      from a hardcoded constant -- the previous literal was a public, known key.
    * Accepts both ``X-API-Key`` (what core-backend actually sends) and the
      legacy ``api_key`` header.
    * SECURE BY DEFAULT: the engine authenticates every caller. The old gate
      trusted ANY caller whenever ``ENVIRONMENT != "production"`` -- so an unset
      or misspelled ENVIRONMENT silently disabled service auth, and the
      fail-closed 503 only existed under the exact string "production". The
      posture no longer branches on that free-text label. The single escape
      hatch is the explicit ``ALLOW_INSECURE_DEV_DEFAULTS`` flag, which local
      tooling sets and production never does (and which a production posture
      ignores regardless).
    * Fails CLOSED when no key is configured: an unconfigured engine rejects
      service traffic (503) rather than trusting it.
    * Compared with ``compare_digest`` to avoid timing leaks.
    """
    provided = x_api_key or api_key
    expected = _configured_key()

    if settings.ALLOW_INSECURE_DEV_DEFAULTS and settings.ENVIRONMENT != "production":
        return provided

    if not expected:
        raise HTTPException(
            status_code=503,
            detail="AI_ENGINE_API_KEY is not configured on the engine",
        )

    if not provided or not _secrets.compare_digest(provided.strip(), expected):
        raise HTTPException(status_code=403, detail="Invalid Service API Key")

    return provided
