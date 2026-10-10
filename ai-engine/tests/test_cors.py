"""CORS regression tests for the FastAPI engine.

Locks down the one pairing the Fetch spec forbids: a wildcard origin together
with credentials. Browsers reject `Access-Control-Allow-Origin: *` on a
credentialed request, and Starlette "resolves" that conflict by reflecting
whatever origin asked — an unauthenticated wildcard that lets any site a
logged-in operator visits drive the trading engine.
"""
import re

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import _DEV_TUNNEL_ORIGIN_RE, app

CLIENT = TestClient(app)

# The same regex the middleware was configured with, compiled for direct use.
TUNNEL_RE = re.compile(_DEV_TUNNEL_ORIGIN_RE)


def _preflight(origin):
    return CLIENT.options(
        "/api/v1/health",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )


class TestNoIllegalWildcardPairing:
    def test_credentials_are_enabled(self):
        # We still send credentials; only the wildcard is forbidden.
        assert app.user_middleware is not None
        for mw in app.user_middleware:
            if getattr(mw, "cls", None).__name__ == "CORSMiddleware":
                assert mw.kwargs.get("allow_credentials") is True
                return
        pytest.fail("CORSMiddleware is not installed on the app")

    def test_wildcard_is_never_combined_with_credentials(self):
        for mw in app.user_middleware:
            if getattr(mw, "cls", None).__name__ == "CORSMiddleware":
                assert "*" not in mw.kwargs.get("allow_origins", []), (
                    "allow_origins=['*'] with allow_credentials=True is the "
                    "illegal/broken pairing Starlette turns into a reflected "
                    "wildcard; use an explicit allowlist instead"
                )
                return
        pytest.fail("CORSMiddleware is not installed on the app")

    def test_allowlist_is_not_empty(self):
        assert settings.cors_origin_list, "an empty allowlist would block the app entirely"


class TestAllowlistReflectsExactOrigin:
    @pytest.mark.parametrize("origin", ["http://localhost:3000", "http://127.0.0.1:3001"])
    def test_configured_dev_origin_is_reflected(self, origin):
        r = _preflight(origin)
        assert r.headers.get("access-control-allow-origin") == origin
        assert r.headers.get("access-control-allow-credentials") == "true"

    def test_https_tunnel_origin_is_reflected(self):
        origin = "https://b3lrfrj9-3000.uks1.devtunnels.ms"
        r = _preflight(origin)
        assert r.headers.get("access-control-allow-origin") == origin

    def test_unlisted_origin_gets_no_allow_origin_header(self):
        r = _preflight("https://evil.example.com")
        assert r.headers.get("access-control-allow-origin") is None


class TestTunnelRegexShape:
    @pytest.mark.parametrize(
        "origin",
        [
            "https://abc-3000.uks1.devtunnels.ms",
            "https://xyz-3001.westus2.devtunnels.ms",
            "https://sometunnel.tunnels.api.visualstudio.com",
        ],
    )
    def test_accepts_https_tunnels(self, origin):
        assert TUNNEL_RE.match(origin)

    @pytest.mark.parametrize(
        "origin",
        [
            "http://abc-3000.uks1.devtunnels.ms",  # http must not be allowed
            "https://devtunnels.ms",  # bare apex
            "https://abc-3000.uks1.devtunnels.ms.evil.com",  # suffix trickery
            "https://abc-3000.uks1.devtunnels.msX",  # prefix trickery
            "https://evil.com/abc-3000.uks1.devtunnels.ms",
            "http://localhost:3000",  # http local is allowlisted, not matched
        ],
    )
    def test_rejects_non_tunnels(self, origin):
        assert not TUNNEL_RE.match(origin)


class TestNonBrowserRequests:
    def test_no_origin_header_is_fine(self):
        # curl / server-to-server / the Next.js rewrite: middleware is a no-op
        # and the real status stays visible.
        r = CLIENT.get("/api/v1/health")
        assert r.status_code == 200
