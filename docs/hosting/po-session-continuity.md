# PO session continuity — hosted runbook (PART 43.6)

How to keep live Pocket Option ticks flowing in a hosted deployment **without
trusting a server with your password**, what the alarms mean, and how to recover
when the broker session dies.

- Posture: credential login is **OFF by default**; the supported steady state is
  the captured cookie **session** (`po_session.json`), which needs no password.
- Audience: the operator on call. Every command is copy-pasteable.
- Related: `pocket-bridge/session/README.md`,
  `docs/legal/po-automated-login-tos-consent.md`.

---

## 1. Threat model (what "without trusting a password" means)

| Concern | Control |
|---|---|
| Password sitting in the app's environment for its whole life | Credential is forwarded **only** to the `refresh_ssid.py` child that needs it; it is stripped from the bridge's env (`withoutPoCredentials()`), never in argv, logs or `/health`. |
| Password baked into an image layer | `.dockerignore` excludes `.env*`; credentials come from mounted **secret files** (`PO_EMAIL_FILE`/`PO_PASSWORD_FILE`) or the runtime env, never the image. |
| A stray remote caller triggering logins | `POST /health/po-auth/{refresh,reset}` are guard-gated and **fail closed** when hosted: with no `PO_HEALTH_ADMIN_KEY` they answer **404** (disabled) — never loopback-only. When a key is set, **every** caller (loopback included) must send `X-PO-Admin-Key` (401 absent / 403 wrong). `GET /health/po-auth` is read-only. |
| A brute-force login loop getting the account banned | Circuit breaker (3 failed logins → halt + alert) and a **never-retry** captcha/2FA interlock, both requiring a human reset. |
| Silent data loss when the session dies | Session-stale alerting after `PO_SESSION_STALE_ALERT_MIN` minutes (email + platform), plus one recovery alert. |

The session cookie itself is still a bearer credential — treat `po_session.json`
as a secret (it is gitignored; use `PO_SESSION_KEY` for at-rest encryption).

---

## 2. Deploy-time setup

1. **Capture once, on the host** (a real browser, your manual login):
   ```powershell
   .\.venv-1\Scripts\python.exe pocket-bridge\session\capture_session.py
   ```
   Produces `pocket-bridge/session/po_session.json` (+ `.meta.json`).

2. **Mount the session into the bridge** (read-only is fine for reuse):
   ```yaml
   # docker-compose.prod.yml (pocket-bridge service)
   volumes:
     - ./pocket-bridge/session:/app/session:ro
   ```

3. **Leave credentials OFF.** Confirm these are unset/false in the deployed
   config (the compose file already defaults them):
   ```dotenv
   PO_EMAIL_LOGIN=false
   PO_TOS_CONSENT=
   PO_AUTH_NODE_TRIGGER=false
   ```

4. **Keep the mutating routes fail-closed.** With `PO_HEALTH_HOSTED=true`
   (the production default) and no key, `POST /health/po-auth/{refresh,reset}`
   answer **404**. If you want them reachable at all, create the key — then
   **every** caller, loopback included, must present it:
   ```bash
   printf '%s' "$(openssl rand -hex 32)" | docker secret create po_health_admin_key -
   # expose it to core-backend as PO_HEALTH_ADMIN_KEY (and PO_HEALTH_HOSTED=true)
   ```

5. **Configure alerting** (email and/or a single external webhook):
   ```dotenv
   PO_SESSION_STALE_ALERT_MIN=15   # minutes dead before the first alert
   PO_ALERT_EMAIL=oncall@example.com
   # Slack-compatible / generic JSON POST receiver. Empty = disabled.
   PO_ALERT_WEBHOOK_URL=
   ```

6. **Verify** (read-only snapshot is always open):
   ```bash
   curl -s http://127.0.0.1:4000/health/po-auth | jq .
   ```

6a. **Verify the guard from OUTSIDE the host**, through the real stack (this is
   the "stray remote caller" check — run it against the published port / proxy,
   not from inside the container):
   ```bash
   BASE=https://<your-host>   # the same URL the reverse proxy serves
   # No key configured (hosted) → 404, indistinguishable from "no route":
   curl -s -o /dev/null -w 'refresh=%{http_code}\n' -X POST "$BASE/health/po-auth/refresh"
   # With PO_HEALTH_ADMIN_KEY set → 401 without the header, 403 with a wrong one,
   # 200/202 only with the correct key. A spoofed X-Forwarded-For must NOT help.
   curl -s -o /dev/null -w 'no-key=%{http_code}\n'  -X POST "$BASE/health/po-auth/refresh"
   curl -s -o /dev/null -w 'bad-key=%{http_code}\n' -X POST "$BASE/health/po-auth/refresh" -H "X-PO-Admin-Key: nope"
   curl -s -o /dev/null -w 'ok=%{http_code}\n'      -X POST "$BASE/health/po-auth/refresh" -H "X-PO-Admin-Key: $PO_HEALTH_ADMIN_KEY"
   # Expected: refresh/no-key = 404 (no key set) OR 401 (key set); bad-key = 403; ok = 2xx.
   ```
   The guard reads `req.ip` (not the raw socket), so it relies on
   `app.set("trust proxy", 1)` — exactly one trusted proxy hop. If you front the
   service with more than one proxy, update that setting or the derived client IP
   (and therefore the guard) is wrong.

### 2a. If you must enable auto-refresh inside the container

`refresh_ssid.py` writes a rotated `po_session.json` (and `.env`). The read-only
mount above **cannot be written**. Pick ONE:

- **Keep it read-only (default):** auto-refresh persists nothing; re-run
  `capture_session.py` on the host when the session dies. Simplest, no
  credential on the server.
- **Make it writable:** replace the bind mount with a writable named volume
  **and** seed it with the captured file out-of-band. Only then does the
  session/credential tier self-heal in place.

The rest of this runbook assumes the default (host re-capture) unless stated.

---

## 3. Observability

`GET /health/po-auth` (and `/api/v1/health/po-auth`) — read-only, ungated:

```json
{
  "credentialFallback": { "enabled": false, "configured": false,
                          "available": false, "tosConsent": false,
                          "emailMasked": null },
  "session":       { "filePresent": true, "ageDays": 1.2 },
  "refreshScript": { "present": true, "path": "...", "python": "..." },
  "refresh":       { "inFlight": false, "lastAt": "...", "lastOk": true,
                     "lastMethod": "session", "lastReason": "startup",
                     "lastError": null },
  "circuit":       { "open": false, "reason": null,
                     "consecutiveLoginFailures": 0, "challengeDetected": false,
                     "autoRetryAt": null, "backoffMs": 120000 },
  "nodeTriggerEnabled": false,
  "timestamp": "..."
}
```

Key fields to watch:

| Field | Healthy | Act on |
|---|---|---|
| `session.filePresent` | `true` | `false` → capture missing; bridge is "awaiting_ssid". |
| `refresh.lastOk` / `lastMethod` | `true` / `session` | repeated `false` → session tier failing. |
| `circuit.open` | `false` | `true` → auto-refresh halted; see §5. |
| `circuit.challengeDetected` | `false` | `true` → captcha/2FA; **human only**. |
| `credentialFallback.available` | `false` (desired) | `true` → credential tier is live; confirm this is intended + consented. |

---

## 4. Incident: SSID dead (the common case)

**Symptom:** alert `[PO Session] SSID dead — live Pocket Option ticks stopped`;
`session_expired` on the bridge relay; `/health/po-auth` shows `session.filePresent`
but PO ticks frozen.

1. **Confirm** live PO ticks are actually off (do not guess) — check
   `/health/ticks` or the feed banner.
2. **Refresh (guarded):**
   ```bash
   curl -s -X POST http://127.0.0.1:4000/health/po-auth/refresh \
     -H "X-PO-Admin-Key: $PO_HEALTH_ADMIN_KEY"
   ```
   From loopback you may omit the header. Response is a `PoAuthRefreshResult`
   (`ok`, `method`, `durationMs`, `error`).
3. If `ok:true`, the recovery alert clears on the next monitor tick (≤ 60 s).
4. If `ok:false` and `error` mentions `not found`, the refresher script is not
   reachable from this host — re-capture on the host that has the session.
5. If `ok:false` with `SESSION_EXPIRED`, the cookie is truly dead: run
   `capture_session.py` on the host and restart the bridge.

---

## 5. Incident: circuit breaker OPEN / challenge interlock

**Symptom:** `/health/po-auth` → `circuit.open: true`, `reason` is
`max_login_failures` or `captcha_or_2fa` (the latter also
`challengeDetected: true`). Auto-refresh is halted; you got a `critical` alert.

`max_login_failures` (3 consecutive failed credential logins):
1. Check the credential is valid **out of band** (log into Pocket Option
   manually in a browser).
2. Fix the cause (rotated password, secret file typo, IP block).
3. Reset the breaker:
   ```bash
   curl -s -X POST http://127.0.0.1:4000/health/po-auth/reset \
     -H "X-PO-Admin-Key: $PO_HEALTH_ADMIN_KEY"
   ```

`captcha_or_2fa` — the broker presented an anti-bot or 2FA challenge:
1. **Do not retry in a loop.** The interlock exists precisely to prevent a ban.
2. Log into Pocket Option **manually** and complete the challenge / 2FA.
3. Capture a fresh session on the host (`capture_session.py`).
4. Only then reset the breaker (same command). A successful session-tier
   refresh does **not** clear the interlock on its own — that is deliberate.

> The manual `refresh` route may run while the breaker is open (that is the
> "human" path). The **automatic** path (`maybeAutoRefresh`) refuses while the
> breaker is open or a challenge is latched.

---

## 6. Network checklist: `Connection initialization timed out` / region rotation

**Symptom:** bridge logs `auth_response=PocketOptionError, General error:
Connection initialization timed out (class=...) urls=[...] rotate=N` and the
feed stays DEGRADED. Per PART 44 [498], every failure line logs the **exception
class**, the **regional WS URLs** attempted and the current **endpoint rotation**
(`rotate=0` on attempt 1 = SDK default order; it increments once per failed
attempt, so a blocked EU host is bypassed onto `api-asia`/`api-us-south`).

A handshake timeout is **transport, not credential** — the bridge keeps readers
armed and retries (never `session_expired`). If it *never* heals, work this
checklist from the host that runs `pocket-bridge`:

1. **Reachability of the regional hosts** (the exact `wss://` hosts from the
   log line):
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 https://api-eu.po.market/
   ```
   Repeat for `api-asia.po.market`, `api-us-south.po.market`. Expect `200/4xx`
   — a hard timeout = outbound WebSocket blocked.
2. **Raw WebSocket handshake** (drives `PocketOptionError ... timed out`):
   ```bash
   npx -y wscat -c 'wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket' -x '{"cmd":"hello"}'
   ```
3. **DNS + egress path:** `nslookup api-eu.po.market` resolves; no corporate
   proxy / firewall is selectively blocking `wss://` (check `HTTPS_PROXY`,
   `NO_PROXY` on the host and in `docker-compose.prod.yml`).
4. **Egress IP reputation:** if the box is a datacenter/VPS, the broker may
   filter its IP block. Confirm by reaching PO from a residential/mobile link.
5. **SDK budget vs. your rotation:** keep `PO_INIT_TIMEOUT` above the SDK
   default of 60s (see `connection_initialization_timeout_secs` in the bridge's
   `connecting urls=...` line) so the rotation has time to walk a dead host to
   a live one instead of aborting.
6. **Verify the rotation is actually moving** — the log line's `rotate` field
   must increment across attempts (0 → 1 → 2): a constant `rotate=0` with the
   env URL list set means the setting is not being read (check
   `POCKET_OPTION_WS_URLS`).
7. **Packet drop / idle reaping:** MTU/fragmentation and NAT timeouts on
   `socket.io` long-poll + websocket — a silent mid-session drop shows up as
   `channelreceiver(closed)` followed by a reconnect, not a timeout.

Unit coverage: `pocket-bridge/tests/test_connect_handshake.py`
(`test_init_timeout_logs_exception_class_region_and_rotation`,
`test_rotated_attempt_surfaces_next_regional_host`,
`test_endpoints_rotate_between_attempts`).

---

## 7. Measuring session lifetime (operator timeline)

We cannot measure real broker expiry in CI — there is no live account there.
Use the timestamps the bridge already writes to build the number for your own
account, then size `PO_SESSION_REFRESH_INTERVAL` and alert thresholds around it.

`po_session.meta.json` records `captured_at`; `/health/po-auth` reports
`session.ageDays`; the bridge logs `SESSION_RELOADED captured_at=...` on each
rotation. Fill this in on the live host:

```
# PO session lifetime — observed
Account:                         <email>
Capture #1 (manual):   captured_at = ______ (UTC)
First auth failure:    ts          = ______ (UTC)
Observed session life:             ______ h  (failure - capture)
Method that failed:                session | credential_login
Renewed by:                        capture_session.py | auto-refresh
Capture #2 captured_at = ______
Notes (IP change / broker change / 2FA seen?): ______________________________
```

Derived settings:

- `PO_SESSION_REFRESH_INTERVAL` = ~½ of the shortest observed life (so a rotation
  happens before expiry), e.g. observed 24 h → `43200`.
- `PO_SESSION_STALE_ALERT_MIN` = comfortably below the time you are willing to
  run blind, e.g. 15.

Record the longest and shortest observations over a few weeks; alert on the
short end.

---

## 8. Verification commands

```bash
# Posture (no secret exposed)
curl -s http://127.0.0.1:4000/health/po-auth | jq '{session,circuit,credentialFallback}'

# The gated refresh from a remote host. No key set (hosted) → 404; with a key
# set → 401 without the header (never a login either way).
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:4000/health/po-auth/refresh -X POST

# Guard present and reachable only with the key (expect 200/403, never a login)
curl -s -X POST http://127.0.0.1:4000/health/po-auth/reset -H "X-PO-Admin-Key: $PO_HEALTH_ADMIN_KEY"
```

Backend unit coverage for all of the above: `core-backend` →
`poAuthManager.test.ts`, `healthRoot.routes.test.ts`, `poSessionMonitor.test.ts`;
Python → `pocket-bridge/tests/test_credential_login.py`.

---

## 9. Rollback

- **Disable the credential tier now:** set `PO_TOS_CONSENT=` and
  `PO_EMAIL_LOGIN=false`, restart. No credential is submitted; the session tier
  still runs.
- **Stop all automation:** `PO_REFRESH_AT_STARTUP=0` and lengthen / disable the
  refresh interval; the bridge then only uses whatever session it is handed.
- **Full stop:** unset `POCKET_OPTION_SSID` and remove the session mount; the
  bridge runs in a clean `awaiting_ssid` state and never fabricates prices.
