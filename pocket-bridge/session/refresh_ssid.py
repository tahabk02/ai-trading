"""Refresh the Pocket Option SSID using the captured browser session.

Runs HEADLESS, loads ``session/po_session.json`` into a browser context, opens
the cabinet, and captures the ``42["auth",{...}]`` Socket.IO frame the site
sends on connect. That frame carries the live ``session`` token. We then:

  * update the ``ssid`` cookie inside ``po_session.json`` (atomic write), and
  * write ``POCKET_OPTION_SSID`` into ``pocket-bridge/.env`` (atomic write),
    preserving every other line.

The bridge invokes this at startup, every 30 min, and once after an auth
failure. On ANY failure it exits non-zero and prints the exact actionable
line ``SESSION_EXPIRED — re-run capture_session.py`` — the bridge then stops
retrying to avoid an account/IP ban.

Usage:
    python session/refresh_ssid.py
    python session/refresh_ssid.py --session path --env pocket-bridge/.env
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SESSION_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SESSION_DIR.parent))

from pocket_bridge.config import (  # noqa: E402
    PO_SESSION_PATH,
    atomic_write_text,
    decrypt_session_data,
    encrypt_session_data,
    load_stored_session,
    mask_secret,
    write_env_ssid,
)

ENV_PATH = SESSION_DIR.parent / ".env"
CABINET_URL = "https://pocketoption.com/en/cabinet/"
AUTH_PREFIX = '42["auth"'


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def extract_ssid_from_frame(frame: str) -> "str | None":
    """Pull the ``session`` token out of a ``42["auth",{...}]`` Socket.IO frame.

    The payload is the JSON array after the Socket.IO ``42`` packet prefix, so
    we locate the first ``[`` and parse from there (handles the odd extra
    namespace byte without guessing).
    """
    if not frame or '"auth"' not in frame:
        return None
    start = frame.find("[")
    if start < 0:
        return None
    try:
        packet = json.loads(frame[start:])
    except json.JSONDecodeError:
        return None
    if not isinstance(packet, list) or len(packet) < 2:
        return None
    if packet[0] != "auth" or not isinstance(packet[1], dict):
        return None
    session = packet[1].get("session")
    return str(session) if session else None


def _fail(msg: str, code: int = 1) -> "None":
    print(f"FAILURE: {msg}", file=sys.stderr)
    print("SESSION_EXPIRED — re-run capture_session.py", file=sys.stderr)
    raise SystemExit(code)


def refresh(session_path: Path, env_path: Path, timeout: float) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001
        _fail(
            "Playwright is not installed. Run:\n"
            "    pip install playwright\n"
            "    python -m playwright install chromium\n"
            f"(import error: {exc})"
        )

    loaded = load_stored_session(session_path, fallback_env=False)
    if not loaded.exists:
        _fail(f"no session file at {session_path} — run capture_session.py")

    raw_text = Path(session_path).read_text(encoding="utf-8")
    data = decrypt_session_data(raw_text)
    if isinstance(data, str):
        data = json.loads(data)
    storage_state = {
        "cookies": data.get("cookies") or [],
        "origins": data.get("origins") or [],
    }
    user_agent = data.get("userAgent") or None

    captured: "list[str]" = []

    def _on_frame(frame) -> None:
        try:
            text = frame.text if hasattr(frame, "text") else str(frame)
        except Exception:  # noqa: BLE001
            return
        ssid = extract_ssid_from_frame(text)
        if ssid:
            captured.append(ssid)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            storage_state=storage_state,
            user_agent=user_agent,
        )
        page = context.new_page()
        page.on("websocket", lambda ws: ws.on("framesent", _on_frame))
        try:
            page.goto(CABINET_URL, wait_until="domcontentloaded", timeout=timeout * 1000)
        except Exception as exc:  # noqa: BLE001
            browser.close()
            _fail(f"navigation failed: {exc}")

        waited = 0.0
        step = 0.5
        while not captured and waited < timeout:
            page.wait_for_timeout(int(step * 1000))
            waited += step
        new_cookies = context.cookies()
        browser.close()

    if not captured:
        _fail(f"no auth frame captured within {timeout:.0f}s (session likely dead)")

    new_ssid = captured[-1]
    print(f"captured ssid={mask_secret(new_ssid, 4)} after {waited:.1f}s")

    # Rotate the ssid cookie in the stored session so the bridge's hot-reload
    # picks up the fresh token too (not just .env).
    for cookie in new_cookies:
        if cookie.get("name") == "ssid":
            cookie["value"] = new_ssid
    if not any(c.get("name") == "ssid" for c in new_cookies):
        new_cookies.append({
            "name": "ssid", "value": new_ssid,
            "domain": ".pocketoption.com", "path": "/",
        })
    data["cookies"] = new_cookies
    data["capturedAt"] = _now()
    data["refreshedBy"] = "refresh_ssid.py"
    try:
        atomic_write_text(
            Path(session_path), encrypt_session_data(json.dumps(data, indent=2))
        )
    except OSError as exc:  # noqa: BLE001
        print(
            f"WARNING: session file is read-only (container) — "
            f"SSID updated in {env_path} only ({exc})",
            file=sys.stderr,
        )

    write_env_ssid(Path(env_path), new_ssid)
    print(f"SUCCESS: updated {session_path.name} and {env_path}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh the Pocket Option SSID headlessly.")
    parser.add_argument("--session", default=str(PO_SESSION_PATH))
    parser.add_argument("--env", default=str(ENV_PATH))
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args()
    raise SystemExit(refresh(Path(args.session), Path(args.env), args.timeout))


if __name__ == "__main__":
    main()