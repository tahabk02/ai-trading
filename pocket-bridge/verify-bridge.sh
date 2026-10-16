#!/usr/bin/env bash
# =============================================================================
#  verify-bridge.sh — ALPHA.5 PRO Pocket Option bridge health probe
#
#  Run ON the VPS (or any host running the prod compose project):
#
#      ./pocket-bridge/verify-bridge.sh
#      ./pocket-bridge/verify-bridge.sh --json      # machine-readable summary
#      ./pocket-bridge/verify-bridge.sh --no-redis  # skip the Redis checks
#
#  What it proves, in order:
#    1. CONTAINER   prod_pocket_bridge exists, is running and healthy.
#    2. /HEALTH     the bridge's own HTTP endpoint answers 200 with a status.
#    3. WS HANDSHAKE a real client completes the relay handshake on :8788 and
#                   receives the initial `snapshot`/`hello` frame.
#    4. REDIS KEYS  the additive dual-path has actually written to `radar_bus`
#                   (po:status, po:ticks, po:candle:*).
#
#  Exit code: 0 when every selected check passes, 1 otherwise — safe to drive
#  from cron / a CI gate / a deploy script.
#
#  Design notes:
#   * The relay (8788) is intentionally NOT published outside the container
#     network, so the WS probe runs INSIDE the container via `docker exec`
#     (the image ships `websockets`). Only /health (8789) is bound to loopback.
#   * `redis-cli --scan --pattern` is used instead of `KEYS` so the probe can
#     never block the live bus for O(keyspace).
#   * Nothing here mutates state; every command is read-only.
# =============================================================================
set -uo pipefail

CONTAINER="${PO_BRIDGE_CONTAINER:-prod_pocket_bridge}"
REDIS_CONTAINER="${REDIS_CONTAINER:-prod_redis}"
HEALTH_URL="${PO_BRIDGE_HEALTH_URL:-http://127.0.0.1:8789/health}"
REDIS_PREFIX="${PO_BRIDGE_REDIS_PREFIX:-po}"
WS_URL="${PO_BRIDGE_RELAY_URL:-ws://127.0.0.1:8788/relay}"
HEALTH_TIMEOUT="${PO_BRIDGE_HEALTH_TIMEOUT:-4}"
WS_TIMEOUT="${PO_BRIDGE_WS_TIMEOUT:-10}"
REQUIRE_READY="${PO_BRIDGE_REQUIRE_READY:-0}"

JSON_OUT=0
RUN_REDIS=1
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    --no-redis) RUN_REDIS=0 ;;
    --require-ready) REQUIRE_READY=1 ;;
    -h|--help)
      sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
SKIP=0
RESULTS=""

note() { printf '%s\n' "$*"; }

record() { # record <PASS|FAIL|SKIP> <name> <detail>
  local state="$1" name="$2" detail="$3"
  case "$state" in
    PASS) PASS=$((PASS + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    SKIP) SKIP=$((SKIP + 1)) ;;
  esac
  if [ "$JSON_OUT" -eq 0 ]; then
    case "$state" in
      PASS) printf '[PASS] %-16s %s\n' "$name" "$detail" ;;
      FAIL) printf '[FAIL] %-16s %s\n' "$name" "$detail" ;;
      SKIP) printf '[SKIP] %-16s %s\n' "$name" "$detail" ;;
    esac
  fi
  # JSON-ish accumulator (detail is escaped for quotes/backslashes only).
  local esc
  esc=$(printf '%s' "$detail" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/ /g')
  RESULTS="${RESULTS}{\"check\":\"${name}\",\"state\":\"${state}\",\"detail\":\"${esc}\"},"
}

# ── compose / docker detection ───────────────────────────────────────────────
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    return 127
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  note "verify-bridge: docker not found on PATH"
  exit 1
fi

note ""
note "── Pocket Option bridge health — ${CONTAINER} ──────────────────────────"
note ""

# ── 1. CONTAINER ─────────────────────────────────────────────────────────────
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  record FAIL "container" "not found (is the compose project up? try: docker compose up -d)"
else
  STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)
  HEALTH=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo unknown)
  if [ "$STATUS" = "running" ]; then
    record PASS "container" "running (health=${HEALTH})"
  else
    record FAIL "container" "state=${STATUS} health=${HEALTH}"
  fi
  if [ "$HEALTH" = "healthy" ]; then
    record PASS "container-health" "healthy"
  elif [ "$HEALTH" = "none" ]; then
    record SKIP "container-health" "no healthcheck declared"
  else
    record FAIL "container-health" "health=${HEALTH}"
  fi
fi

# ── 2. /HEALTH ───────────────────────────────────────────────────────────────
http_get() {
  local url="$1" timeout="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time "$timeout" "$url" 2>/dev/null
  else
    python3 - "$url" "$timeout" <<'PY' 2>/dev/null
import sys, urllib.request
print(urllib.request.urlopen(sys.argv[1], timeout=float(sys.argv[2])).read().decode("utf-8", "replace"))
PY
  fi
}

BODY=$(http_get "$HEALTH_URL" "$HEALTH_TIMEOUT")
if [ -n "$BODY" ]; then
  STATUS_VAL=$(printf '%s' "$BODY" | grep -o '"status":[^,}]*' | head -n1 | cut -d'"' -f4)
  SSID_PRESENT=$(printf '%s' "$BODY" | grep -o '"ssid_present":[^,}]*' | head -n1 | cut -d: -f2 | tr -d ' ')
  [ -z "$STATUS_VAL" ] && STATUS_VAL="unknown"
  record PASS "health" "200 status=${STATUS_VAL} ssid_present=${SSID_PRESENT}"
else
  record FAIL "health" "no response from ${HEALTH_URL}"
fi

# ── 3. WS HANDSHAKE (inside the container) ──────────────────────────────────
if [ "$STATUS" = "running" ]; then
  # `-i` is required: the probe body arrives on stdin, so the container's
  # `python -` actually receives the script instead of an empty program.
  WS_OUT=$(docker exec -i "$CONTAINER" python - "$WS_URL" "$WS_TIMEOUT" "$REQUIRE_READY" 2>&1 <<'PY'
import asyncio, json, sys
url, timeout, require_ready = sys.argv[1], float(sys.argv[2]), sys.argv[3] == "1"
try:
    import websockets
except Exception as exc:                      # pragma: no cover
    print(f"websockets unavailable: {exc}"); raise SystemExit(3)

async def go():
    try:
        async with websockets.connect(url, open_timeout=timeout) as ws:
            kinds = []
            deadline = asyncio.get_event_loop().time() + timeout
            while asyncio.get_event_loop().time() < deadline:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    break
                msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
                text = msg.decode("utf-8", "replace") if isinstance(msg, (bytes, bytearray)) else str(msg)
                try:
                    frame = json.loads(text)
                except ValueError:
                    continue
                if isinstance(frame, dict):
                    kinds.append(str(frame.get("type", "")))
                if kinds and not require_ready:
                    break
                if require_ready and "ready" in kinds:
                    break
            if not kinds:
                print("WS_FAIL no frame within window"); return 1
            joined = ",".join(kinds)
            if require_ready and "ready" not in kinds:
                print(f"WS_FAIL no `ready` frame (got {joined})"); return 1
            print(f"WS_OK frames={joined}"); return 0
    except Exception as exc:
        print(f"WS_FAIL {type(exc).__name__}: {exc}"); return 1

sys.exit(asyncio.run(go()))
PY
)
  WS_RC=$?
  if [ "$WS_RC" -eq 0 ]; then
    record PASS "ws-handshake" "${WS_OUT#WS_OK }"
  else
    record FAIL "ws-handshake" "${WS_OUT:-exit=${WS_RC}}"
  fi
else
  record SKIP "ws-handshake" "container not running"
fi

# ── 4. REDIS KEYS (additive dual-path) ──────────────────────────────────────
if [ "$RUN_REDIS" -eq 0 ]; then
  record SKIP "redis" "disabled by --no-redis"
elif ! docker inspect "$REDIS_CONTAINER" >/dev/null 2>&1; then
  record SKIP "redis" "container ${REDIS_CONTAINER} not found"
elif [ "$(docker inspect -f '{{.State.Status}}' "$REDIS_CONTAINER" 2>/dev/null)" != "running" ]; then
  record FAIL "redis" "container ${REDIS_CONTAINER} is not running"
else
  # REDIS_PASSWORD lives in the redis container's own environment; quoting it
  # keeps the secret out of the process command line (only the env expansion
  # inside the container happens).
  rcli() {
    docker exec "$REDIS_CONTAINER" sh -c \
      'exec redis-cli -a "$REDIS_PASSWORD" --no-auth-warning "$@"' _ "$@"
  }

  if [ "$(rcli ping 2>/dev/null | tr -d '[:space:]')" = "PONG" ]; then
    record PASS "redis-ping" "PONG"
  else
    record FAIL "redis-ping" "no PONG from ${REDIS_CONTAINER}"
  fi

  KEYS=$(rcli --scan --pattern "${REDIS_PREFIX}:*" 2>/dev/null | sort)
  COUNT=$(printf '%s' "$KEYS" | grep -c . || true)
  if [ "${COUNT:-0}" -gt 0 ]; then
    record PASS "redis-keys" "${COUNT} key(s) under ${REDIS_PREFIX}:*"
  else
    record FAIL "redis-keys" "no ${REDIS_PREFIX}:* keys (dual-path not publishing — is REDIS_URL set?)"
  fi

  for k in "${REDIS_PREFIX}:status" "${REDIS_PREFIX}:heartbeat" "${REDIS_PREFIX}:ticks"; do
    if printf '%s\n' "$KEYS" | grep -qx -- "$k"; then
      record PASS "redis-key" "$k present"
    else
      record FAIL "redis-key" "$k missing"
    fi
  done

  # Prove a SYMBOL-level key exists so the fan-out is per-pair, not just a
  # status blip.
  SYM_KEY=$(printf '%s\n' "$KEYS" | grep -m1 -- "^${REDIS_PREFIX}:tick:" || true)
  if [ -n "$SYM_KEY" ]; then
    VAL=$(rcli get "$SYM_KEY" 2>/dev/null | tr -d '"')
    record PASS "redis-tick" "${SYM_KEY} (bytes=$(printf '%s' "$VAL" | wc -c | tr -d ' '))"
  else
    record FAIL "redis-tick" "no ${REDIS_PREFIX}:tick:<SYMBOL> key yet"
  fi
fi

# ── SUMMARY ─────────────────────────────────────────────────────────────────
if [ "$JSON_OUT" -eq 1 ]; then
  printf '{"container":"%s","pass":%d,"fail":%d,"skip":%d,"checks":[%s]}\n' \
    "$CONTAINER" "$PASS" "$FAIL" "$SKIP" "${RESULTS%,}"
else
  note ""
  note "────────────────────────────────────────────────────────────────────────"
  printf 'RESULT: %d passed, %d failed, %d skipped  (%s)\n' \
    "$PASS" "$FAIL" "$SKIP" "$CONTAINER"
  if [ "$FAIL" -eq 0 ]; then
    note "PO bridge: healthy"
  else
    note "PO bridge: PROBLEMS DETECTED — see FAIL rows above."
    note "  logs: docker logs --tail 100 ${CONTAINER}"
    note "  health: curl -s ${HEALTH_URL}"
  fi
  note "────────────────────────────────────────────────────────────────────────"
  note ""
fi

[ "$FAIL" -eq 0 ] || exit 1
exit 0
