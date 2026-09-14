"""Live Pocket Option auth + first-tick probe (real network, real SSID).

Runs ONLY when a real SSID is available — from ``POCKET_OPTION_SSID`` (env),
``core-backend/.env``, or ``pocket-bridge/.env``. Without credentials the
pytest case is SKIPPED so ``pytest tests/ -v`` stays green in credential-less
CI; the standalone run still reports ``SSID_FOUND=false`` and exits 1.

Standalone (real proof):
    python tests/test_auth_live.py

Prints, in order:
    SSID_FOUND=true/false
    AUTH_OK session_len=.. uid=.. isDemo=..            (or AUTH_FAILED reason=..)
    TICK_RECEIVED symbol=.. price=.. ts=..             (or NO_TICKS waited_s=15)

Exit code:
    0 = SSID found + auth OK + at least one real tick received
    1 = missing SSID / auth failed / no tick within 15s
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
POCKET_BRIDGE_DIR = TESTS_DIR.parent
CORE_BACKEND_ENV = POCKET_BRIDGE_DIR / ".." / "core-backend" / ".env"
CORE_BACKEND_ENV = CORE_BACKEND_ENV.resolve()
BRIDGE_ENV = POCKET_BRIDGE_DIR / ".env"

# Allow importing the bridge package from a standalone invocation.
if str(POCKET_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(POCKET_BRIDGE_DIR))

logging.basicConfig(level=logging.ERROR, format="%(levelname)s:%(name)s:%(message)s")

import pytest  # noqa: E402

from pocket_bridge.config import BridgeSettings, parse_ssid  # noqa: E402

WAIT_SECONDS = 15


def _read_env_file(path: Path) -> dict:
    data: dict = {}
    if not path.exists():
        return data
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        data[key.strip()] = value.strip().strip("'").strip('"')
    return data


def _resolve_ssid() -> tuple[str, str]:
    """Return ``(ssid, origin)`` — env, then core-backend/.env, then bridge .env."""
    raw = os.getenv("POCKET_OPTION_SSID", "").strip()
    if raw:
        return raw, "env:POCKET_OPTION_SSID"
    ssid = _read_env_file(CORE_BACKEND_ENV).get("POCKET_OPTION_SSID")
    if ssid:
        return ssid, "core-backend/.env"
    ssid = _read_env_file(BRIDGE_ENV).get("POCKET_OPTION_SSID")
    if ssid:
        return ssid, "pocket-bridge/.env"
    return "", "none"


def _session_len(ssid: str) -> int:
    try:
        return len(str(parse_ssid(ssid).get("session", "")))
    except Exception:
        return 0


async def _probe() -> int:
    ssid, origin = _resolve_ssid()
    if not ssid:
        print("SSID_FOUND=false")
        return 1
    print(f"SSID_FOUND=true session_len={_session_len(ssid)} origin={origin}")

    try:
        from BinaryOptionsToolsV2.pocketoption import PocketOptionAsync
    except Exception as exc:  # NOQA: BLE001 - report and exit cleanly
        print(f"AUTH_FAILED reason=BinaryOptionsToolsV2 unavailable: {exc}")
        return 1

    settings = BridgeSettings(ssid=ssid)
    client = None
    try:
        client = PocketOptionAsync(settings.auth_payload)
    except Exception as exc:  # NOQA: BLE001
        print(f"AUTH_FAILED reason=construction failed: {exc}")
        return 1

    try:
        await asyncio.wait_for(client.wait_for_assets(timeout=60), timeout=60)
        print(
            f"AUTH_OK session_len={_session_len(ssid)} "
            f"uid={settings.auth.get('uid')} isDemo={settings.auth.get('isDemo')}"
        )
    except Exception as exc:  # NOQA: BLE001 - auth failure
        print(f"AUTH_FAILED reason={str(exc)[:200]}")
        return 1

    try:
        stream = await client.subscribe_symbol("EURUSD_otc")
        try:
            tick = await asyncio.wait_for(stream.__anext__(), timeout=WAIT_SECONDS)
        except (asyncio.TimeoutError, StopAsyncIteration):
            print(f"NO_TICKS waited_s={WAIT_SECONDS}")
            return 1
        ts = tick.get("timestamp", tick.get("time"))
        price = tick.get("price", tick.get("close"))
        print(f"TICK_RECEIVED symbol=EURUSD_otc price={price} ts={ts}")
        return 0
    except Exception as exc:  # NOQA: BLE001 - subscribe failure
        print(f"AUTH_FAILED reason=subscribe_failure: {str(exc)[:200]}")
        return 1
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:  # NOQA: BLE001 - best-effort close
                pass


def test_auth_and_first_tick_live():
    """Real SSID present -> must authenticate and receive >=1 tick (exit 0)."""
    ssid, _origin = _resolve_ssid()
    if not ssid:
        pytest.skip(
            "POCKET_OPTION_SSID not set (env, core-backend/.env or "
            "pocket-bridge/.env) — live auth probe skipped"
        )
    assert asyncio.run(_probe()) == 0


def main() -> int:
    return asyncio.run(_probe())


if __name__ == "__main__":
    sys.exit(main())