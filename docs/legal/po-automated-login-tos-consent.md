# Pocket Option automated login — ToS consent record (PART 43.6 [482])

This document records the operator's acknowledgement that the **last-resort
credential login** path — `pocket-bridge/session/refresh_ssid.py` driving the
Pocket Option login form headlessly — is used **at the operator's own risk**, and
that turning it on is an explicit, deliberate act.

It is a *policy + audit* record, not legal advice. Confirm the current terms on
the broker's site before relying on any statement here.

## What the consent gate does

The credential tier is **inert unless all three gates are satisfied**:

1. `PO_EMAIL_LOGIN=1` — opt-in.
2. an email + password — via `PO_EMAIL`/`PO_PASSWORD`, or the preferred mounted
   secret files `PO_EMAIL_FILE`/`PO_PASSWORD_FILE`.
3. `PO_TOS_CONSENT` — **this record**. Without it, `credential_login_available`
   is `false` and no credential is ever submitted.

Both layers enforce the gate independently:

- Node: `PoAuthManager.isCredentialFallbackAvailable()` / `hasTosConsent()`
  (`core-backend/src/services/poAuthManager.ts`), surfaced read-only on
  `GET /health/po-auth` as `credentialFallback.tosConsent`.
- Python: `CredentialLogin.usable` and `credential_login_tos_consent`
  (`pocket-bridge/pocket_bridge/config.py`).

## Operator acknowledgement

By setting `PO_TOS_CONSENT=true` you state that:

- You **own or are authorised to operate** the Pocket Option account being
  logged in.
- You have **read Pocket Option's Terms of Service and any automated-access /
  bot policy**, and you accept that headless automated login may conflict with
  them.
- You accept the **risk** of account restriction, suspension, or ban, and any
  IP-level throttling, as a consequence of enabling this tier.
- You understand automated login is a **last resort** used only after the
  cookie-session tier fails, and that the platform's default is **OFF**.
- You will **keep the credential out of the image and out of git** (use Docker
  secrets / mounted files; never commit `PO_EMAIL`/`PO_PASSWORD`).

If you cannot make these statements, leave `PO_TOS_CONSENT` unset. The session
tier (`po_session.json`) needs no credentials and is the supported steady state.

## How to record consent

Prefer the secret-file form in production:

```bash
# docker secret or a read-only mounted file whose CONTENTS are "true"
printf 'true' | docker secret create po_tos_consent -
# then set PO_TOS_CONSENT from that secret in your orchestration
```

Or, for a single-host dev/staging stack:

```dotenv
# core-backend/.env or pocket-bridge/.env  (gitignored)
PO_EMAIL_LOGIN=false      # keep OFF until you are ready
PO_TOS_CONSENT=true       # this acknowledgement
```

## Revoking consent

Set `PO_TOS_CONSENT` empty (or `false`) and restart. The credential tier is
immediately inert; no credential will be submitted. Rotate the credential
afterwards if it was ever enabled.

## Audit trail

`GET /health/po-auth` is unauthenticated and read-only, so an external monitor
can record the posture without exposing a secret. The response includes the
masked email (`*@...` — first 3 chars only), `tosConsent`, and the circuit
state, but **never** the password.
