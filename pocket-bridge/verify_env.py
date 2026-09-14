"""Verify the local Pocket Option session/SSID against the live WebSocket.

Credential resolution order (first match wins):
  1. `session/po_session.json`  (captured browser session — PRIMARY)
  2. `pocket-bridge/.env`         (automatic refresh target)
  3. `core-backend/.env`          (legacy location)

When sourced from the session file, the Cookie + User-Agent headers are sent
along on the raw socket too (the library cannot inject headers; the SSID cookie
remains the actual auth credential).
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import websockets
from dotenv import dotenv_values

from pocket_bridge.bridge import DEFAULT_PO_WS_URL
from pocket_bridge.config import (
    PO_SESSION_PATH,
    auth_message,
    load_stored_session,
    mask_secret,
    parse_ssid,
)

BASE = Path(__file__).resolve().parent
ENV_PATH = BASE / ".env"
CORE_ENV_PATH = BASE.parent / "core-backend" / ".env"


async def _probe_via_library(auth: dict) -> bool:
    """Authenticate + first live tick through the SAME path the bridge uses
    (BinaryOptionsToolsV2). This is the authoritative probe — the raw-socket
    handshake above is only a connectivity diagnostic."""
    try:
        from BinaryOptionsToolsV2.pocketoption import PocketOptionAsync
    except Exception as exc:  # noqa: BLE001
        print(f"AUTH_FAILED reason=BinaryOptionsToolsV2 unavailable: {exc}")
        return False
    client = None
    try:
        client = PocketOptionAsync(auth_message(auth))
        await asyncio.wait_for(client.wait_for_assets(timeout=60), timeout=60)
        print(f"AUTH_OK session_len={len(auth.get('session', ''))} "
              f"uid={auth.get('uid')} isDemo={auth.get('isDemo')}")
    except Exception as exc:  # noqa: BLE001
        print(f"AUTH_FAILED reason={str(exc)[:200]}")
        return False
    try:
        stream = await client.subscribe_symbol("EURUSD_otc")
        try:
            tick = await asyncio.wait_for(stream.__anext__(), timeout=15)
        except (asyncio.TimeoutError, StopAsyncIteration):
            print("NO_TICKS waited_s=15")
            return False
        print(f"TICK_RECEIVED symbol=EURUSD_otc price={tick.get('price', tick.get('close'))} "
              f"ts={tick.get('timestamp', tick.get('time'))}")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"AUTH_FAILED reason=subscribe_failure: {str(exc)[:200]}")
        return False
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001 - best-effort close
                pass


async def verify(auth: dict, cookie_header: str = "", user_agent: str = "") -> bool:
    kwargs: dict = {}
    if cookie_header:
        kwargs["extra_headers"] = {"Cookie": cookie_header}
    if user_agent:
        kwargs.setdefault("extra_headers", {})["User-Agent"] = user_agent
    try:
        async with websockets.connect(
            DEFAULT_PO_WS_URL, open_timeout=15, **kwargs
        ) as ws:
            handshake = await asyncio.wait_for(ws.recv(), timeout=15)
            print(f"HANDSHAKE {str(handshake)[:200]}")
            # Socket.IO v4 over websocket: acknowledge the open packet with the
            # "40" connect packet BEFORE sending the auth message (matches what
            # the BinaryOptionsToolsV2 client does internally).
            await ws.send("40")
            await ws.send(auth_message(auth))
            deadline = asyncio.get_running_loop().time() + 15
            authenticated = False
            while asyncio.get_running_loop().time() < deadline:
                remaining = max(0.1, deadline - asyncio.get_running_loop().time())
                message = await asyncio.wait_for(ws.recv(), timeout=remaining)
                text = message.decode("utf-8", "replace") if isinstance(message, bytes) else message
                print(f"RECV {text[:200]}")
                lower = text.lower()
                if "success" in lower:
                    authenticated = True
                    print("AUTH_OK")
                if authenticated and "tick" in lower:
                    print("TICK_RECEIVED")
                    return True
            if authenticated:
                print("NO_TICKS (auth OK, no tick within the window)")
                return False
            # The raw Socket.IO framing may diverge from the broker's web client;
            # the real bridge authenticates through BinaryOptionsToolsV2, so fall
            # back to that authoritative probe before declaring failure.
            print("RAW_SOCKET_AUTH_FAILED — falling back to library probe")
            return await _probe_via_library(auth)
    except Exception as exc:
        print(f"AUTH_FAILED {exc.__class__.__name__}: {exc}")
        print("RAW_SOCKET_AUTH_FAILED — falling back to library probe")
        return await _probe_via_library(auth)


def main() -> int:
    print(f"SESSION_DEFAULT {PO_SESSION_PATH}")
    print(f"ENV_PATH {ENV_PATH}")
    print(f"CORE_ENV_PATH {CORE_ENV_PATH}")

    # 1. Captured browser session (PRIMARY).
    stored = load_stored_session(PO_SESSION_PATH)
    if stored.exists and stored.has_ssid:
        auth = stored.as_auth()
        auth["session"] = auth.get("session") or ""
        origin = f"session:{PO_SESSION_PATH}"
        print(f"SSID_FOUND true origin={origin} session_len={len(auth['session'])}")
        print(f"SESSION_CAPTURED_AT {stored.captured_at or 'n/a'}")
        print(f"SESSION_AGE_DAYS {round(stored.age_days, 2)}")
        print(f"COOKIE_HEADER_SENT {mask_secret(stored.cookie_header(), 8)}")
        print(f"USER_AGENT_SENT {mask_secret(stored.user_agent, 8)}")
        return 0 if asyncio.run(verify(auth, stored.cookie_header(), stored.user_agent)) else 1

    # 2. pocket-bridge/.env then 3. core-backend/.env (legacy fallbacks).
    for path, label in ((ENV_PATH, "env:pocket-bridge/.env"), (CORE_ENV_PATH, "env:core-backend/.env")):
        if not path.is_file():
            continue
        raw = dotenv_values(path).get("POCKET_OPTION_SSID") or ""
        raw = raw.strip()
        if not raw:
            continue
        try:
            auth = parse_ssid(raw)
        except ValueError as exc:
            print(f"AUTH_FAILED invalid SSID: {exc}")
            return 1
        normalized = raw.strip().strip("'\"").strip()
        print(f"ssid_present={bool(auth.get('session'))}")
        print(f"ssid_format={'full' if normalized.startswith('42[') else 'raw'}")
        print(f"ssid_length={len(auth.get('session', ''))}")
        print(f"uid={auth.get('uid')}")
        print(f"is_demo={auth.get('isDemo')}")
        return 0 if asyncio.run(verify(auth)) else 1

    print("AUTH_FAILED no session file and no POCKET_OPTION_SSID in any .env")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())