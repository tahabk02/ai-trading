#!/usr/bin/env bash
# =============================================================================
#  ALPHA.5 PRO — PRODUCTION DEPLOY
# =============================================================================
#  Idempotent deploy/update for a single Linux VPS (Hetzner 4 GB recommended).
#
#  What it does, in order:
#    1. preflight  — docker/compose present, root .env present, secrets set
#    2. (optional) — git pull --ff-only
#    3. build      — docker compose build --pull
#    4. data layer — start postgres + redis, wait until HEALTHY
#    5. migrate    — `prisma migrate deploy` in the built core-backend image
#    6. app layer  — start the services
#    7. (--edge)   — bootstrap a TLS certificate, then start nginx + certbot
#    8. verify     — curl the liveness endpoints and fail loud on any non-200
#
#  Usage:
#      cp .env.production.example .env    # then fill it in
#      ./deploy.sh --edge                 # full stack incl. bundled nginx+TLS
#      ./deploy.sh                        # app stack only (host-level proxy)
#
#  Flags:
#      --edge          also deploy + start the `edge` profile (nginx + certbot)
#      --pull          git pull --ff-only before building
#      --skip-build    reuse existing images (fast config-only redeploy)
#      --no-migrate    skip prisma migrate deploy (schema unchanged)
#      -h | --help     show this help
#
#  It NEVER runs `down -v` and never deletes named volumes: the database and
#  the captured Pocket Option session survive every deploy.
# =============================================================================
set -euo pipefail

# ── Resolve repo root (this script's directory) regardless of $PWD ───────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="docker-compose.prod.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

EDGE=0
DO_PULL=0
DO_BUILD=1
DO_MIGRATE=1

# ── Pretty output ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BOLD=''
fi
log()  { printf '%s==>%s %s\n' "$C_BLUE$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '%s ✓ %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s ! %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '%s ✗ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

# ── Helpers ──────────────────────────────────────────────────────────────────
# Defined before use (bash resolves functions at call time, but section 7 runs
# before section 8's checks — keep every helper here to avoid ordering traps).

# Poll a container's HEALTHCHECK until it reports `healthy`.
wait_healthy() {
  local container="$1" timeout="${2:-90}" waited=0 status=""
  while [ "$waited" -lt "$timeout" ]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [ "$status" = "healthy" ] && { ok "$container is healthy ($waited""s)."; return 0; }
    sleep 3; waited=$((waited + 3))
  done
  die "$container did not become healthy within ${timeout}s (last: ${status:-unknown}). Check: docker logs $container"
}

# Poll an HTTP liveness URL until it answers 2xx.
wait_http() {
  local url="$1" name="$2" timeout="${3:-90}" waited=0
  log "Health-checking ${name} (${url})"
  while [ "$waited" -lt "$timeout" ]; do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then
      ok "${name} OK ($waited""s)."; return 0
    fi
    sleep 3; waited=$((waited + 3))
  done
  die "${name} did not return 200 within ${timeout}s (${url}). Check: docker logs ${name}"
}

# Full name of a compose-managed named volume (project name is prefixed).
vol_name() { docker volume ls -q -f "name=$1" | head -n 1; }

# True when a Let's Encrypt lineage already exists for ${DOMAIN}.
cert_present() {
  local vol; vol="$(vol_name certbot_certs)"
  [ -n "$vol" ] || return 1
  docker run --rm -v "${vol}:/etc/letsencrypt:ro" alpine:3 \
    sh -c "test -s /etc/letsencrypt/live/${DOMAIN}/fullchain.pem" >/dev/null 2>&1
}

# ── Flag parsing ─────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --edge)        EDGE=1 ;;
    --pull)        DO_PULL=1 ;;
    --skip-build)  DO_BUILD=0 ;;
    --no-migrate)  DO_MIGRATE=0 ;;
    -h|--help)     usage; exit 0 ;;
    *) die "Unknown argument: $arg (try --help)" ;;
  esac
done

# =============================================================================
#  1. PREFLIGHT
# =============================================================================
log "Preflight checks"

command -v docker >/dev/null 2>&1 || die "docker is not installed."
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required (got: docker compose)."
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon (is it running / do you need sudo?)."

[ -f "$COMPOSE_FILE" ] || die "$COMPOSE_FILE not found in $SCRIPT_DIR"
[ -f ".env" ] || die "Root .env not found. Run: cp .env.production.example .env  (then fill it in)."

# Load the root .env exactly as compose would, so we can validate required keys.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

require_var() {
  local name="$1" hint="${2:-}"
  local val="${!name:-}"
  if [ -z "$val" ]; then
    die "$name is required but empty in .env${hint:+ — $hint}"
  fi
}
require_var DB_PASSWORD          "openssl rand -base64 24"
require_var REDIS_PASSWORD       "openssl rand -base64 32"
require_var JWT_SECRET           "openssl rand -base64 48 (must be >= 32 chars)"
require_var AI_ENGINE_API_KEY    "openssl rand -base64 48"
require_var CORS_ORIGIN          "the real public origin, e.g. https://trade.example.com"
[ "${#JWT_SECRET}" -ge 32 ] || die "JWT_SECRET must be at least 32 characters."

if [ "$EDGE" -eq 1 ]; then
  require_var DOMAIN             "the public hostname, e.g. trade.example.com"
  require_var LETSENCRYPT_EMAIL  "contact address for Let's Encrypt"
fi

# Validate compose interpolation before doing anything expensive.
"${COMPOSE[@]}" config >/dev/null || die "docker compose config failed — check .env and $COMPOSE_FILE."
ok "Configuration valid."

# =============================================================================
#  2. OPTIONAL PULL
# =============================================================================
if [ "$DO_PULL" -eq 1 ]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "git pull --ff-only"
    git pull --ff-only || die "git pull failed (local changes?). Resolve, then re-run."
    ok "Repository updated."
  else
    warn "Not a git work tree — skipping --pull."
  fi
fi

# =============================================================================
#  3. BUILD
# =============================================================================
if [ "$DO_BUILD" -eq 1 ]; then
  log "Building images (this can take several minutes on first run)"
  "${COMPOSE[@]}" build --pull || die "Image build failed."
  ok "Images built."
else
  warn "--skip-build: reusing existing images."
fi

# =============================================================================
#  4. DATA LAYER
# =============================================================================
log "Starting data layer (postgres, redis)"
"${COMPOSE[@]}" up -d --no-deps postgres redis

wait_healthy() {
  local container="$1" timeout="${2:-90}" waited=0 status=""
  while [ "$waited" -lt "$timeout" ]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [ "$status" = "healthy" ] && { ok "$container is healthy ($waited""s)."; return 0; }
    sleep 3; waited=$((waited + 3))
  done
  die "$container did not become healthy within ${timeout}s (last: ${status:-unknown}). Check: docker logs $container"
}
wait_healthy prod_postgres 120
wait_healthy prod_redis 60

# =============================================================================
#  5. DATABASE MIGRATIONS
# =============================================================================
if [ "$DO_MIGRATE" -eq 1 ]; then
  log "Applying Prisma migrations (prisma migrate deploy)"
  # --no-deps: postgres/redis are already healthy above; don't drag the whole
  # dependency graph in. The runner image ships node_modules + prisma/ so the
  # CLI and migrations are present.
  "${COMPOSE[@]}" run --rm --no-deps core-backend npx prisma migrate deploy \
    || die "Migration failed. Database left untouched by this script."
  ok "Migrations applied."
else
  warn "--no-migrate: skipping prisma migrate deploy."
fi

# =============================================================================
#  6. APP LAYER
# =============================================================================
log "Starting application services"
"${COMPOSE[@]}" up -d
ok "Application services started."

# =============================================================================
#  7. EDGE (nginx + TLS) — optional
# =============================================================================
vol_name() { docker volume ls -q -f "name=$1" | head -n 1; }
cert_present() {
  local vol; vol="$(vol_name certbot_certs)"
  [ -n "$vol" ] || return 1
  docker run --rm -v "${vol}:/etc/letsencrypt:ro" alpine:3 \
    sh -c "test -s /etc/letsencrypt/live/${DOMAIN}/fullchain.pem" >/dev/null 2>&1
}

if [ "$EDGE" -eq 1 ]; then
  # Create the volumes the certbot/nginx services share, without starting.
  "${COMPOSE[@]}" up -d --no-start >/dev/null 2>&1 || true

  if ! cert_present; then
    log "Requesting TLS certificate for ${DOMAIN} (Let's Encrypt standalone)"
    warn "This needs DNS for ${DOMAIN} → this host and TCP/80 reachable from the internet."
    # Standalone bind on :80 must be free — the edge nginx is intentionally not
    # up yet. The renewal loop uses webroot, so first issuance via standalone
    # must be a distinct authenticator — this is expected and fine.
    "${COMPOSE[@]}" run --rm --entrypoint certbot --publish 80:80 certbot \
      certonly --standalone --non-interactive --agree-tos --no-eff-email \
      --email "$LETSENCRYPT_EMAIL" -d "$DOMAIN" \
      || die "Certificate issuance failed. Verify DNS + port 80, then re-run ./deploy.sh --edge"
    ok "Certificate issued."
  else
    ok "Existing certificate found for ${DOMAIN} — skipping issuance."
  fi

  log "Starting edge (nginx + certbot renewal loop)"
  "${COMPOSE[@]}" --profile edge up -d nginx certbot

  wait_http "http://127.0.0.1/nginx-health" "nginx (edge)" 60
  ok "Edge is serving."
else
  warn "Edge profile not requested — run './deploy.sh --edge' to start bundled nginx + TLS."
fi

# =============================================================================
#  8. VERIFY
# =============================================================================
wait_http() {
  local url="$1" name="$2" timeout="${3:-90}" waited=0
  log "Health-checking ${name} (${url})"
  while [ "$waited" -lt "$timeout" ]; do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then
      ok "${name} OK ($waited""s)."; return 0
    fi
    sleep 3; waited=$((waited + 3))
  done
  die "${name} did not return 200 within ${timeout}s (${url}). Check: ${COMPOSE[*]} logs ${name}"
}

# These are published to 127.0.0.1 by the compose file, so they are reachable
# from the host without exposing them publicly.
wait_http "http://127.0.0.1:4000/health"      "core-backend" 90
wait_http "http://127.0.0.1:3000/api/healthz" "client-app"   90
wait_http "http://127.0.0.1:8000/health/live" "ai-engine"    120

if [ "$EDGE" -eq 1 ]; then
  wait_http "https://${DOMAIN}/nginx-health" "edge (TLS)" 60 || \
    warn "TLS check failed — if DNS is not propagated yet, retry once it is."
fi

# =============================================================================
#  DONE
# =============================================================================
echo
ok "${C_BOLD}Deploy complete.${C_RESET}"
echo "   Status : ${COMPOSE[*]} ps"
echo "   Logs   : ${COMPOSE[*]} logs -f core-backend"
if [ "$EDGE" -eq 1 ]; then
  echo "   Public : https://${DOMAIN}"
else
  echo "   Public : (terminate TLS with your host-level reverse proxy → 127.0.0.1:3000)"
fi
echo
echo "   NOTE: the board reports HONESTLY. Empty/SCORED/WAITING states are real"
echo "         results, not failures to 'fix'. Do not add force/override flags."
