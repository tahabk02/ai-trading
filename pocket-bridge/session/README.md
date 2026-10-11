# Pocket Option browser session (capture once, reuse automatically)

The bridge authenticates with a live Pocket Option login **session**, not a
hardcoded credential. Because the broker only issues the `ssid` cookie to a
logged-in browser (no API key), we capture the session **once** with a real
browser and reuse it forever — refreshing it automatically until the account
signs out.

## Files

| Path | What it is |
|---|---|
| `capture_session.py` | **Manual, one-time** capture. Opens a real browser where YOU log in. Writes `po_session.json`. |
| `refresh_ssid.py` | **Headless** auto-refresh. Reuses `po_session.json`, extracts the fresh `42["auth",{...}]` SSID, rotates the stored cookie AND writes it to `pocket-bridge/.env`. |
| `po_session.json` | The captured session (cookies, localStorage, sessionStorage, user-agent). **Gitignored — never commit.** |
| `po_session.meta.json` | Non-secret metadata (masked values only) a human can inspect. |
| `po_session.json.tmp` | Atomic-write temp; transient. |

## First capture (run ONCE, by a human)

```powershell
.\.venv-1\Scripts\python.exe pocket-bridge\session\capture_session.py
```

1. A Chromium window opens at the Pocket Option login page.
2. **Log in manually with your email + password** — the script never asks for
   or stores them.
3. Once the cabinet loads, the script snapshots the session and exits `0`
   printing `SUCCESS: session captured -> ...`.

Verify: `pocket-bridge\tests\test_session.py` in the suite, and
`pocket-bridge\verify_env.py` for a live auth probe.

## Automatic refresh

The bridge runs `refresh_ssid.py`:
- once at startup (only when a session file exists),
- every `PO_SESSION_REFRESH_INTERVAL` seconds (default 1800 = 30 min),
- once immediately after an auth failure.

On success the SSID is rotated into `po_session.json` (atomic) and
`pocket-bridge/.env`, and the bridge hot-reloads it (`SESSION_RELOADED`). A
`REFRESH_METHOD=session|credential_login` line reports HOW the token was
obtained. On failure the bridge logs **CRITICAL `SESSION_EXPIRED — re-run
capture_session.py`** and **stops retrying** to avoid an account/IP ban;
`/health` reports `"session_expired": true`.

## Last-resort credential login (optional, opt-in)

`refresh_ssid.py` has a TWO-TIER recovery. Tier 1 is the session reuse above —
credential-free and always preferred. **Tier 2 (credential login) is ONLY used
when tier 1 produced no auth frame**, i.e. the stored session is dead, AND ALL
of these gates are set:

- `PO_EMAIL_LOGIN=1` (opt-in),
- an email + password (via the plain `PO_EMAIL`/`PO_PASSWORD`, or the preferred
  secret files `PO_EMAIL_FILE`/`PO_PASSWORD_FILE` — file wins over env), **and**
- `PO_TOS_CONSENT` recorded (your written acknowledgement of Pocket Option's
  terms on automated login — see
  `docs/legal/po-automated-login-tos-consent.md`). Without it the tier is inert.

In that state it drives the login form headlessly to mint a brand-new session,
writes a fresh `po_session.json`, and rotates the SSID into `.env` exactly as
tier 1. While a session works, the credential is never sent anywhere.

- Opt-in and masked: logs/health show only the first 3 characters of the email,
  never the password.
- **Credential isolation (PART 43.6 [480]):** the core-backend forwards the
  credential to the `refresh_ssid.py` child process ONLY. It is stripped from
  the bridge's own environment (`withoutPoCredentials()`), never placed in
  process argv, and never exposed on `/health` or in logs.
- **Circuit breaker:** 3 consecutive failed logins OPEN the circuit — auto-refresh
  halts and an alert fires. Auto-refresh also backs off exponentially (60 s base,
  2×, capped at 30 min). A human resets it via
  `POST /health/po-auth/reset` (guard-gated).
- **Challenge interlock:** a captcha/2FA prompt stops the automated login
  immediately (`CHALLENGE_DETECTED=...`, exit code 3) and it is **never
  auto-retried** until a human resets the breaker — after a manual login.
- Ban-safety: the Node backend's own `PO_AUTH_NODE_TRIGGER` is OFF by default so
  two browser logins can never run concurrently.

Set the credential either in `pocket-bridge/.env` (read by the bridge's own
scheduler) or in `core-backend/.env` (forwarded to the `refresh_ssid.py` child
spawned by `core-backend/src/services/poAuthManager.ts`).

## Runtime states (what the logs mean)

| Line | Meaning |
|---|---|
| `NO_SESSION — run capture_session.py first` | No `po_session.json` AND no `POCKET_OPTION_SSID`. Bridge is idle, **never invents prices**. |
| `SESSION_OLD ... /health` `session_age_days > 7` | Captured session is stale; consider re-capturing (harmless until auth actually fails). |
| `SESSION_RELOADED captured_at=...` | The 10s hot-reloader noticed a changed `po_session.json` and reconnected. |
| `SSID_EXPIRED — run capture_session.py to refresh` | Auth failed; terminal state reached. |
| `SESSION_EXPIRED — re-run capture_session.py` | Auth failed AND the automatic refresh failed too. |
| `LOGIN_ATTEMPTED=1` | The last-resort credential login is being attempted (orchestrator counts these separately from session refreshes). |
| `CHALLENGE_DETECTED=captcha\|2fa\|unknown` (exit 3) | Anti-bot/2FA hit; automated login halted. **Never auto-retried** — human reset required. |

## Security

- `po_session.json` is gitignored and written 0600 on POSIX hosts.
- Secrets are never printed: logs and `po_session.meta.json` show only the
  first 8 characters (masked).
- Optional at-rest encryption: set `PO_SESSION_KEY` (Fernet) — the session
  file is then stored as `FERNET:<base64>` and only this service can read it.
- The bridge never sends email/password anywhere while a session works; the
  credential login is an opt-in last resort used only after the session tier
  fails, gated by a recorded `PO_TOS_CONSENT`, and masked in every log/health
  surface.
- The credential is delivered to the `refresh_ssid.py` child ONLY — never the
  bridge or a sibling process, never argv, never `/health` or logs. Prefer the
  mounted secret files (`PO_EMAIL_FILE`/`PO_PASSWORD_FILE`) over plain env in
  production.
- The `POST /health/po-auth/{refresh,reset}` routes are gated: when
  `PO_HEALTH_ADMIN_KEY` is set a non-loopback caller must present it in the
  `X-PO-Admin-Key` header; when unset, only loopback callers are accepted.
  `GET /health/po-auth` is read-only and ungated.
- Session-stale alerting: once the PO session has been dead for
  `PO_SESSION_STALE_ALERT_MIN` (default 15) minutes, the backend raises ONE
  alert (email to `PO_ALERT_EMAIL` + platform sink) and a matching recovery
  alert. No alert storm.

## Container notes

`docker-compose.yml` mounts `./pocket-bridge/session` into the container
read-only — **capture must happen on the host**. `refresh_ssid.py` can run
inside the container; if the session file is read-only it warns and updates
the `.env` SSID only, which the bridge adopts on the next reload.

## Manual one-liners

```powershell
# Live auth probe (uses session file first, then .env, then core-backend/.env)
.\.venv-1\Scripts\python.exe pocket-bridge\verify_env.py

# Full test suite (session tests included)
.\.venv-1\Scripts\python.exe -m pytest pocket-bridge\tests -v
```