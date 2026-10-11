"""Refresh the Pocket Option SSID headlessly.

TWO-TIER RECOVERY, session first:

  1. SESSION (preferred, credential-free). Load ``session/po_session.json`` into
     a headless browser context, open the cabinet, and capture the
     ``42["auth",{...}]`` Socket.IO frame the site sends on connect. That frame
     carries the live ``session`` token. This is the normal path and never
     touches an email or password.

  2. CREDENTIAL LOGIN (LAST RESORT, opt-in). Only when tier 1 yields no auth
     frame AND ``PO_EMAIL_LOGIN`` is enabled with both ``PO_EMAIL`` and
     ``PO_PASSWORD`` present, drive the login form with those credentials to mint
     a brand-new authenticated browser session, then capture the auth frame from
     it. This is deliberately avoided while the session path works, so the steady
     state never sends email/password anywhere.

On success we:
  * update the ``ssid`` cookie inside ``po_session.json`` (atomic write),
  * write ``POCKET_OPTION_SSID`` into ``pocket-bridge/.env`` (atomic write),
    preserving every other line, and
  * print ``REFRESH_METHOD=session|credential_login`` so the caller can report
    HOW the token was obtained.

On ANY failure it exits non-zero and prints the exact actionable line
``SESSION_EXPIRED â€” re-run capture_session.py`` â€” the bridge then stops retrying
to avoid an account/IP ban. EXCEPTIONS (PART 43.6 [480]):
  * exit code 3 + ``CHALLENGE_DETECTED=captcha|2fa`` when a captcha/2FA
    challenge halted the login â€” the orchestrator must NEVER auto-retry and
    opens the challenge interlock until a human resets it;
  * ``LOGIN_ATTEMPTED=1`` is printed whenever the credential tier actually runs,
    so the orchestrator can enforce the circuit breaker on LOGIN attempts (not
    session-tier refreshes) and back off exponentially.

Usage:
    python session/refresh_ssid.py
    python session/refresh_ssid.py --session path --env pocket-bridge/.env
    python session/refresh_ssid.py --no-login     # session tier only
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

SESSION_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SESSION_DIR.parent))

from pocket_bridge.config import (  # noqa: E402
    PO_SESSION_PATH,
    CredentialLogin,
    atomic_write_text,
    decrypt_session_data,
    encrypt_session_data,
    load_credential_login,
    load_stored_session,
    mask_secret,
    parse_ssid,
    write_env_ssid,
)

ENV_PATH = SESSION_DIR.parent / ".env"
CABINET_URL = "https://pocketoption.com/en/cabinet/"
AUTH_PREFIX = '42["auth"'

# Anti-bot / 2FA challenge detection (PART 43.6 [480]): when a login form is
# met with a captcha/2FA challenge the automation STOPS and never retries â€” the
# orchestrator's challenge interlock halts auto-login until a human resets it.
# The detection is deliberately conservative: an unknown anti-bot signal counts
# as captcha (never retry).
CHALLENGE_SELECTORS: List[str] = [
    # Anti-bot widgets / iframes
    "iframe[src*='captcha']",
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='geetest']",
    "[class*='g-recaptcha']",
    "[class*='geetest']",
    "[class*='hcaptcha']",
    "[class*='captcha']",
    "[id*='captcha']",
    # 2FA / verification inputs
    "input[name*='2fa']",
    "input[name*='totp']",
    "input[name*='otp']",
    "input[name*='code']",
    "input[placeholder*='verification']",
]
CHALLENGE_KEYWORDS_2FA = (
    "two-factor",
    "two factor",
    "2fa",
    "totp",
    "authentication code",
    "verification code",
    "one-time password",
)
CHALLENGE_KEYWORDS_CAPTCHA = (
    "captcha",
    "recaptcha",
    "hcaptcha",
    "geetest",
    "security check",
    "are you a human",
    "verify you are human",
    "verify you are a human",
    "human verification",
)
CHALLENGE_TEXT_EVAL = (
    "() => document.body ? document.body.innerText.slice(0, 4000) : ''"
)

# Machine-readable markers the orchestrator parses (PART 43.6 [480]).
LOGIN_ATTEMPTED_MARKER = "LOGIN_ATTEMPTED=1"
CHALLENGE_MARKER = "CHALLENGE_DETECTED="

# Login-form selectors, tried in order â€” Pocket Option ships A/B markup, so the
# first VISIBLE match wins rather than assuming a single stable id.
LOGIN_EMAIL_SELECTORS: List[str] = [
    "input[name='email']",
    "input[type='email']",
    "input[name='username']",
    "#email",
    "form input[type='text']",
]
LOGIN_PASSWORD_SELECTORS: List[str] = [
    "input[name='password']",
    "input[type='password']",
    "#password",
]
LOGIN_SUBMIT_SELECTORS: List[str] = [
    "button[type='submit']",
    "button:has-text('Log in')",
    "button:has-text('Login')",
    "form button",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def extract_ssid_from_frame(frame: str) -> Optional[str]:
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


def should_attempt_credential_login(
    cfg: CredentialLogin, captured_ssid: Optional[str]
) -> bool:
    """Credential login is a LAST RESORT.

    It is attempted ONLY when the session tier produced no SSID AND the fallback
    is opted-in (``PO_EMAIL_LOGIN``) AND fully configured (email + password). A
    usable session therefore never triggers a credential login.
    """
    if captured_ssid:
        return False
    return bool(cfg and cfg.usable)


def _fail(msg: str, code: int = 1) -> "None":
    print(f"FAILURE: {msg}", file=sys.stderr)
    print("SESSION_EXPIRED â€” re-run capture_session.py", file=sys.stderr)
    raise SystemExit(code)


class _ChallengeDetected(Exception):
    """A captcha/2FA challenge stopped the automated login. NEVER auto-retried
    (PART 43.6 [480]): the orchestrator opens the challenge interlock."""

    def __init__(self, challenge_type: str) -> None:
        super().__init__(f"anti-bot challenge detected: {challenge_type}")
        self.challenge_type = challenge_type


def parse_challenge_text(text: str) -> Optional[str]:
    """Classify page/stream text as a captcha or 2FA challenge (heuristic).

    Returns ``"2fa"``, ``"captcha"``, or ``None``. An unknown anti-bot signal
    degrades to ``"captcha"`` â€” the never-retry bucket.
    """
    low = (text or "").lower()
    if any(k in low for k in CHALLENGE_KEYWORDS_2FA):
        return "2fa"
    if any(k in low for k in CHALLENGE_KEYWORDS_CAPTCHA):
        return "captcha"
    return None


def detect_challenge(page) -> Optional[str]:
    """Scan the live page for a captcha/2FA challenge; returns type or ``None``.

    Pure heuristics, never a guarantee: it exists to STOP retrying, and being
    wrong in the "detected" direction is the safe failure mode.
    """
    try:
        for sel in CHALLENGE_SELECTORS:
            count = page.locator(sel).count()
            if count and count > 0:
                if any(k in sel for k in ("2fa", "totp", "otp", "code", "verification")):
                    return "2fa"
                return "captcha"
    except Exception:  # noqa: BLE001 - detection is best-effort
        pass
    try:
        body = page.evaluate(CHALLENGE_TEXT_EVAL) or ""
    except Exception:  # noqa: BLE001
        body = ""
    return parse_challenge_text(body)


class _FrameCollector:
    """Collects every ``42["auth",{...}]`` frame sent by the page websocket."""

    def __init__(self) -> None:
        self.frames: List[str] = []

    def attach(self, page) -> None:
        def _on_frame(frame) -> None:  # noqa: ANN001 - Playwright frame object
            try:
                text = frame.text if hasattr(frame, "text") else str(frame)
            except Exception:  # noqa: BLE001
                return
            ssid = extract_ssid_from_frame(text)
            if ssid:
                self.frames.append(ssid)

        page.on("websocket", lambda ws: ws.on("framesent", _on_frame))

    @property
    def latest(self) -> Optional[str]:
        return self.frames[-1] if self.frames else None


def _wait_for_ssid(
    page, collector: _FrameCollector, timeout: float, detect=None
):
    """Poll the collector until an SSID arrives or ``timeout`` elapses.

    ``detect`` is an optional challenge probe: when it returns a type, the
    waiting is ABORTED with ``_ChallengeDetected`` (never retried).
    """
    waited = 0.0
    step = 0.5
    while collector.latest is None and waited < timeout:
        if detect is not None:
            challenge = detect(page)
            if challenge:
                raise _ChallengeDetected(challenge)
        page.wait_for_timeout(int(step * 1000))
        waited += step
    return collector.latest, waited


def _first_visible(page, selectors: List[str], per_timeout_ms: int = 5_000):
    """Return the first VISIBLE locator among ``selectors`` or ``None``."""
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            loc.wait_for(state="visible", timeout=per_timeout_ms)
            return loc
        except Exception:  # noqa: BLE001 - try the next candidate selector
            continue
    return None


def _load_storage_state(session_path: Path) -> Optional[Dict[str, Any]]:
    """Decrypt + parse the stored session into a Playwright storage_state."""
    if not Path(session_path).exists():
        return None
    raw_text = Path(session_path).read_text(encoding="utf-8")
    data = decrypt_session_data(raw_text)
    if isinstance(data, str):
        data = json.loads(data)
    return {
        "storage_state": {
            "cookies": data.get("cookies") or [],
            "origins": data.get("origins") or [],
        },
        "origins": data.get("origins") or [],
        "session_storage": data.get("sessionStorage") or {},
        "user_agent": data.get("userAgent") or None,
    }


def refresh_via_session(
    pw, session_path: Path, timeout: float
) -> Optional[Dict[str, Any]]:
    """Tier 1 â€” reuse the stored session headlessly and capture the auth frame."""
    state = _load_storage_state(session_path)
    if state is None:
        return None
    collector = _FrameCollector()
    browser = pw.chromium.launch(headless=True)
    try:
        context = browser.new_context(
            storage_state=state["storage_state"],
            user_agent=state["user_agent"],
        )
        page = context.new_page()
        collector.attach(page)
        page.goto(CABINET_URL, wait_until="domcontentloaded", timeout=timeout * 1000)
        ssid, waited = _wait_for_ssid(page, collector, timeout)
        if not ssid:
            return None
        return {
            "ssid": ssid,
            "cookies": context.cookies(),
            "origins": state["origins"],
            "session_storage": state["session_storage"],
            "user_agent": state["user_agent"],
            "waited": waited,
        }
    finally:
        browser.close()


def login_via_credentials(
    pw, cfg: CredentialLogin, timeout: float
) -> Optional[Dict[str, Any]]:
    """Tier 2 â€” LAST RESORT: drive the login form with the configured credential.

    The credential is never logged; only the masked outcome is printed. A
    captcha/2FA challenge ABORTS the attempt with ``_ChallengeDetected``
    (PART 43.6 [480]) â€” the orchestrator must never retry it.
    """
    collector = _FrameCollector()
    browser = pw.chromium.launch(headless=True)
    try:
        context = browser.new_context()
        page = context.new_page()
        collector.attach(page)
        page.goto(cfg.login_url, wait_until="domcontentloaded", timeout=timeout * 1000)

        # Pre-submit challenge check (e.g. an interstitial already present).
        pre = detect_challenge(page)
        if pre:
            raise _ChallengeDetected("2fa" if pre == "2fa" else "captcha")

        email_field = _first_visible(page, LOGIN_EMAIL_SELECTORS)
        password_field = _first_visible(page, LOGIN_PASSWORD_SELECTORS)
        if email_field is None or password_field is None:
            print(
                "credential login: login form not found (selectors missed)",
                file=sys.stderr,
            )
            return None
        email_field.fill(cfg.email)
        password_field.fill(cfg.password)
        submit = _first_visible(page, LOGIN_SUBMIT_SELECTORS)
        if submit is not None:
            submit.click()
        else:
            password_field.press("Enter")

        # Post-submit: wait for the auth frame WHILE probing for a challenge.
        ssid, waited = _wait_for_ssid(
            page, collector, timeout, detect=detect_challenge
        )
        if not ssid:
            return None
        try:
            user_agent = page.evaluate("() => navigator.userAgent")
        except Exception:  # noqa: BLE001
            user_agent = None
        storage = context.storage_state()
        return {
            "ssid": ssid,
            "cookies": context.cookies(),
            "origins": storage.get("origins", []),
            "session_storage": {},
            "user_agent": user_agent,
            "waited": waited,
        }
    finally:
        browser.close()


def _persist_session(session_path: Path, result: Dict[str, Any], source: str) -> None:
    """Atomically write the (possibly rotated) session file.

    On a read-only-mounted container the write is best-effort â€” the .env write
    below still carries the fresh SSID, which the bridge hot-reloads.
    """
    cookies = list(result.get("cookies") or [])
    new_ssid = result["ssid"]
    for cookie in cookies:
        if cookie.get("name") == "ssid":
            cookie["value"] = new_ssid
    if not any(c.get("name") == "ssid" for c in cookies):
        cookies.append(
            {
                "name": "ssid",
                "value": new_ssid,
                "domain": ".pocketoption.com",
                "path": "/",
            }
        )
    payload = {
        "cookies": cookies,
        "origins": result.get("origins") or [],
        "sessionStorage": result.get("session_storage") or {},
        "userAgent": result.get("user_agent") or "",
        "capturedAt": _now(),
        "refreshedBy": "refresh_ssid.py",
        "source": source,
        "raw_ssid": new_ssid,
    }
    try:
        atomic_write_text(
            Path(session_path),
            encrypt_session_data(json.dumps(payload, ensure_ascii=False, indent=2)),
        )
    except OSError as exc:  # noqa: BLE001
        print(
            f"WARNING: session file is read-only (container) â€” "
            f"SSID updated in .env only ({exc})",
            file=sys.stderr,
        )


def refresh(
    session_path: Path,
    env_path: Path,
    timeout: float,
    allow_login: Optional[bool] = None,
) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001
        _fail(
            "Playwright is not installed. Run:\n"
            "    pip install playwright\n"
            "    python -m playwright install chromium\n"
            f"(import error: {exc})"
        )

    cfg = load_credential_login()
    if allow_login is not None:
        cfg = replace(cfg, enabled=cfg.enabled and allow_login)
    if cfg.enabled and not cfg.configured:
        print(
            "credential login enabled but PO_EMAIL/PO_PASSWORD incomplete â€” "
            "session tier only",
            file=sys.stderr,
        )
    if cfg.enabled and cfg.configured and not cfg.tos_consent:
        print(
            "credential login opted-in + configured but PO_TOS_CONSENT is not "
            "recorded (PART 43.6 [482]) â€” credential tier disabled, session "
            "tier only. See docs/legal/po-automated-login-tos-consent.md",
            file=sys.stderr,
        )

    result: Optional[Dict[str, Any]] = None
    method = "none"

    with sync_playwright() as pw:
        # â”€â”€ Tier 1: session (preferred) â”€â”€
        if Path(session_path).exists():
            result = refresh_via_session(pw, Path(session_path), timeout)
            if result and result.get("ssid"):
                method = "session"

        # â”€â”€ Tier 2: credential login (LAST RESORT) â”€â”€
        if should_attempt_credential_login(cfg, result.get("ssid") if result else None):
            # Machine-readable trigger so the orchestrator can count LOGIN
            # attempts separately from session-tier refreshes (circuit breaker).
            print(LOGIN_ATTEMPTED_MARKER)
            print(
                "SESSION UNAVAILABLE â€” attempting last-resort credential login",
                file=sys.stderr,
            )
            try:
                result = login_via_credentials(pw, cfg, timeout)
            except _ChallengeDetected as exc:
                # PART 43.6 [480]: captcha/2FA â€” STOP, never retry. Exit code 3
                # distinguishes this from a generic SESSION_EXPIRED failure so
                # the orchestrator (a) does NOT auto-retry and (b) opens the
                # challenge interlock for a human reset.
                print(f"{CHALLENGE_MARKER}{exc.challenge_type}")
                print(f"COMPROMISE: {exc}", file=sys.stderr)
                print(
                    "SELF_HEALING_STOPPED â€” automated login halted, human "
                    "required (reset circuit)",
                    file=sys.stderr,
                )
                return 3
            if result and result.get("ssid"):
                method = "credential_login"

    if not result or not result.get("ssid"):
        _fail(f"no auth frame captured within {timeout:.0f}s (session likely dead)")

    new_ssid = result["ssid"]
    print(f"captured ssid={mask_secret(new_ssid, 4)} after {result.get('waited', 0):.1f}s")

    _persist_session(Path(session_path), result, source=method)
    write_env_ssid(Path(env_path), new_ssid)
    # Machine-readable method so the bridge / backend can report HOW the token
    # was obtained (session reuse vs last-resort credential login).
    print(f"REFRESH_METHOD={method}")
    print(f"SUCCESS: updated {Path(session_path).name} and {env_path}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh the Pocket Option SSID headlessly.")
    parser.add_argument("--session", default=str(PO_SESSION_PATH))
    parser.add_argument("--env", default=str(ENV_PATH))
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument(
        "--login",
        dest="login",
        action="store_true",
        default=None,
        help="force-enable the last-resort credential login (requires PO_EMAIL/PO_PASSWORD)",
    )
    parser.add_argument(
        "--no-login",
        dest="login",
        action="store_false",
        help="disable the last-resort credential login (session tier only)",
    )
    args = parser.parse_args()
    raise SystemExit(
        refresh(Path(args.session), Path(args.env), args.timeout, allow_login=args.login)
    )


if __name__ == "__main__":
    main()
