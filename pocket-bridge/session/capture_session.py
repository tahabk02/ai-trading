"""Capture a full Pocket Option browser session ONCE — for a human to run.

You log in MANUALLY in the window that opens (this script never sees, types or
stores your email/password). Once the cabinet is loaded, the complete session
is written to ``session/po_session.json``:

  * cookies (including the ``ssid`` cookie the bridge authenticates with),
  * localStorage (all origins),
  * sessionStorage,
  * the exact browser User-Agent.

The bridge then reuses that file — no re-login on every restart. When the
session eventually expires, the bridge tries ``refresh_ssid.py``; if that also
fails you simply re-run THIS script.

Usage:
    python session/capture_session.py            # interactive
    python session/capture_session.py --wait 20  # wait up to 20 min for login

NEVER commit po_session.json — it is a live credential (gitignored).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Fix Windows Proactor event loop conflict with Playwright/Asyncio in Python 3.10+
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

SESSION_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SESSION_DIR.parent))

from pocket_bridge.config import (  # noqa: E402
    PO_SESSION_PATH,
    atomic_write_text,
    encrypt_session_data,
    mask_secret,
    parse_ssid,
    write_env_ssid,
)

LOGIN_URL = "https://pocketoption.com/en/login"
CABINET_MARKERS = ("/cabinet", "/en/cabinet", "cabinet")


def _fail(msg: str, code: int = 1) -> "None":
    print(f"FAILURE: {msg}", file=sys.stderr)
    raise SystemExit(code)


def _require_playwright():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        _fail(
            "Playwright is not installed in this environment. Run:\n"
            "    pip install playwright\n"
            "    python -m playwright install chromium\n"
            f"(import error: {exc})"
        )
    from playwright.sync_api import sync_playwright

    return sync_playwright


def _is_cabinet(url: str) -> bool:
    low = (url or "").lower()
    return "/cabinet" in low


def _extract_auth_ssid(frame_text: str) -> str:
    if not frame_text or '"auth"' not in frame_text:
        return ""
    start = frame_text.find("[")
    if start < 0:
        return ""
    try:
        packet = json.loads(frame_text[start:])
    except json.JSONDecodeError:
        return ""
    if not isinstance(packet, list) or len(packet) < 2 or packet[0] != "auth":
        return ""
    payload = packet[1]
    if not isinstance(payload, dict):
        return ""
    session = payload.get("session")
    return str(session) if session else ""


def capture(wait_minutes: float, output: Path) -> int:
    sync_playwright = _require_playwright()
    output = Path(output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    auth_values: list[str] = []

    def _on_frame(frame) -> None:
        try:
            text = frame.text if hasattr(frame, "text") else str(frame)
        except Exception:  # noqa: BLE001
            return
        if '"auth"' not in text:
            return
        ssid = _extract_auth_ssid(text)
        if ssid:
            auth_values.append(ssid)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        page.on("websocket", lambda ws: ws.on("framesent", _on_frame))
        page.goto(LOGIN_URL, wait_until="domcontentloaded")

        print("=" * 66)
        print(" LOG IN MANUALLY in the opened window.")
        print(" This script NEVER asks for or stores your email/password.")
        print(" Waiting for the cabinet to load ...")
        print("=" * 66)

        deadline = time.time() + max(30.0, wait_minutes * 60.0)
        while time.time() < deadline:
            if _is_cabinet(page.url):
                break
            time.sleep(2.0)
        else:
            browser.close()
            _fail(
                f"login not detected within {wait_minutes:.0f} min "
                f"(url={page.url!r}). Re-run and log in faster."
            )

        time.sleep(3.0)
        cookies = context.cookies()
        storage = context.storage_state()
        try:
            session_storage = page.evaluate(
                "() => Object.fromEntries(Object.entries(window.sessionStorage))"
            )
        except Exception:  # noqa: BLE001
            session_storage = {}
        try:
            user_agent = page.evaluate("() => navigator.userAgent")
        except Exception:  # noqa: BLE001
            user_agent = context._impl_obj._options.get("userAgent", "")
        auth_ssid = auth_values[-1] if auth_values else ""
        if auth_ssid:
            try:
                parse_ssid(auth_ssid)
            except ValueError:
                auth_ssid = ""

        payload = {
            "cookies": cookies,
            "origins": storage.get("origins", []),
            "sessionStorage": session_storage,
            "userAgent": user_agent,
            "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": "capture_session.py",
            "raw_ssid": auth_ssid,
        }
        browser.close()

    ssid = auth_ssid or next((c.get("value") for c in payload["cookies"] if c.get("name") == "ssid"), "")
    raw = encrypt_session_data(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False))
    atomic_write_text(output, raw)

    meta = output.with_name(output.stem + ".meta.json")
    atomic_write_text(
        meta,
        json.dumps(
            {
                "captured_at": payload["capturedAt"],
                "user_agent": mask_secret(payload["userAgent"]),
                "cookie_count": len(payload["cookies"]),
                "ssid_present": bool(ssid),
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=False,
        )
        + "\n",
    )

    env_path = SESSION_DIR.parent / ".env"
    if ssid:
        write_env_ssid(env_path, ssid)

    print(f"SUCCESS: session captured -> {output}")
    print(f"SUCCESS: env updated -> {env_path}")
    print(f"SUCCESS: meta -> {meta}")
    print(f"        ssid={mask_secret(ssid or '', 4) or '(none found!)'}")
    print(f"        cookies={len(payload['cookies'])} origins={len(payload['origins'])}")
    if not ssid:
        print("WARNING: no usable SSID captured — re-run after logging in and waiting for auth", file=sys.stderr)
        return 2
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture a Pocket Option session once.")
    parser.add_argument("--wait", type=float, default=10.0,
                        help="minutes to wait for manual login (default 10)")
    parser.add_argument("--output", default=str(PO_SESSION_PATH),
                        help="destination po_session.json (default session/po_session.json)")
    args = parser.parse_args()
    print(f"capture output path: {Path(args.output).resolve()}")
    raise SystemExit(capture(args.wait, Path(args.output)))


if __name__ == "__main__":
    main()