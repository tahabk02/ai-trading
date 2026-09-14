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
`pocket-bridge/.env`, and the bridge hot-reloads it (`SESSION_RELOADED`).
On failure the bridge logs **CRITICAL `SESSION_EXPIRED — re-run
capture_session.py`** and **stops retrying** to avoid an account/IP ban;
`/health` reports `"session_expired": true`.

## Runtime states (what the logs mean)

| Line | Meaning |
|---|---|
| `NO_SESSION — run capture_session.py first` | No `po_session.json` AND no `POCKET_OPTION_SSID`. Bridge is idle, **never invents prices**. |
| `SESSION_OLD ... /health` `session_age_days > 7` | Captured session is stale; consider re-capturing (harmless until auth actually fails). |
| `SESSION_RELOADED captured_at=...` | The 10s hot-reloader noticed a changed `po_session.json` and reconnected. |
| `SSID_EXPIRED — run capture_session.py to refresh` | Auth failed; terminal state reached. |
| `SESSION_EXPIRED — re-run capture_session.py` | Auth failed AND the automatic refresh failed too. |

## Security

- `po_session.json` is gitignored and written 0600 on POSIX hosts.
- Secrets are never printed: logs and `po_session.meta.json` show only the
  first 8 characters (masked).
- Optional at-rest encryption: set `PO_SESSION_KEY` (Fernet) — the session
  file is then stored as `FERNET:<base64>` and only this service can read it.
- The bridge never sends email/password anywhere; there is no auto-login.

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