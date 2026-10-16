#!/usr/bin/env bash
# =============================================================================
#  ALPHA.5 PRO — ONE-COMMAND VPS DEPLOY  (Hetzner: 91.99.71.111)
# =============================================================================
#  Zero-friction, idempotent deployment of the FULL stack to a single Linux VPS
#  and — for a bare IP with no domain — a plain-HTTP public gateway on :80.
#
#  WHAT IT DOES
#    1. SSH into the target and install Docker Engine + Compose v2, git, rsync
#       and openssl (Ubuntu; idempotent — safe to re-run).
#    2. rsync the current working tree (INCLUDING uncommitted changes) to the
#       VPS, excluding build junk, .git, node_modules, venvs and every .env.
#    3. Generate a production .env on the VPS with FRESH secrets on first run
#       (DB_PASSWORD, REDIS_PASSWORD, JWT_SECRET, AI_ENGINE_API_KEY) and a
#       CORS_ORIGIN of http://<ip>. An existing .env is NEVER overwritten.
#    4. Build images, start postgres+redis, apply Prisma migrations, start the
#       app, then bring up the plain-HTTP nginx gateway (profile: http).
#    5. Verify the live site from your machine with curl health probes.
#
#  ONE COMMAND (run from the repo root on YOUR local machine):
#      bash deploy-vps.sh
#
#  Override the target:
#      VPS_HOST=91.99.71.111 VPS_USER=root bash deploy-vps.sh
#      bash deploy-vps.sh --host root@91.99.71.111 --dir /opt/alpha5
#
#  RUN DIRECTLY ON THE VPS (code already present at the current directory):
#      bash deploy-vps.sh --remote
#
#  FLAGS
#      --host <user@ip>   target host (default: root@91.99.71.111)
#      --dir  <path>      remote checkout dir (default: /opt/alpha5)
#      --remote           run ON the VPS: skip SSH provisioning + rsync
#      --skip-rsync       do not sync code (deploy what is already on the VPS)
#      --skip-build       forwarded to deploy.sh (reuse existing images)
#      --no-migrate       forwarded to deploy.sh (schema unchanged)
#      --no-http          do NOT start the :80 HTTP gateway
#      -h | --help        show this help
#
#  SECURITY: this script never weakens a gate. EXECUTION_DRY_RUN stays true, the
#  honesty gates are untouched, and ONLY the HTTP gateway (80) faces the
#  internet — postgres/redis/backends stay on the internal Docker network.
#
#  For an HTTPS deploy on a real domain, use ./deploy.sh --edge instead (it adds
#  the TLS nginx + certbot). The two gateways both want :80 — run only one.
# =============================================================================
set -euo pipefail

# ── Defaults / configuration ─────────────────────────────────────────────────
VPS_HOST="${VPS_HOST:-91.99.71.111}"
VPS_USER="${VPS_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/alpha5}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HTTP_PROFILE="${HTTP_PROFILE:-http}"
HTTP_SERVICE="nginx-http"

MODE_REMOTE=0
DO_RSYNC=1
DO_HTTP=1
EXTRA=()                                   # flags forwarded to deploy.sh

LOCAL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30)

# Files never worth shipping to a server (and never delete these on the remote
# with --delete: excluded paths are protected automatically).
RSYNC_EXCLUDES=(
  --exclude='.git/'
  --exclude='node_modules/'
  --exclude='.next/'
  --exclude='dist/'
  --exclude='build/'
  --exclude='.venv/'
  --exclude='.venv-1/'
  --exclude='__pycache__/'
  --exclude='.pytest_cache/'
  --exclude='*.log'
  --exclude='*.zip'
  --exclude='.env'
  # Local-only overrides that must never reach a server (dev machine values).
  --exclude='.env.local'
  --exclude='.env.local.*'
  --exclude='.env.development'
  --exclude='.env.development.*'
  --exclude='pocket-bridge/session/'
)

# ── Pretty output ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BOLD=''
fi
log()  { printf '%s==>%s %s\n' "$C_BLUE$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '%s + %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s ! %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '%s x %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

usage() {
  sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'
}

# ── Flag parsing ─────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      arg="${2:?--host needs user@ip or ip}"; shift
      if [[ "$arg" == *@* ]]; then VPS_USER="${arg%%@*}"; VPS_HOST="${arg##*@}"; else VPS_HOST="$arg"; fi
      ;;
    --dir)        REMOTE_DIR="${2:?--dir needs a value}"; shift ;;
    --remote)     MODE_REMOTE=1 ;;
    --skip-rsync) DO_RSYNC=0 ;;
    --skip-build|--no-migrate) EXTRA+=("$1") ;;
    --no-http)    DO_HTTP=0 ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "Unknown argument: $1 (try --help)" ;;
  esac
  shift
done
VPS="${VPS_USER}@${VPS_HOST}"

PASSTHRU_STR=""
if [ "${#EXTRA[@]}" -gt 0 ]; then PASSTHRU_STR="${EXTRA[*]}"; fi

# ── HTTP liveness probe (curl, local or on-VPS) ──────────────────────────────
wait_http() {
  local url="$1" name="$2" timeout="${3:-90}" waited=0
  log "Health-checking ${name} (${url})"
  while [ "$waited" -lt "$timeout" ]; do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then ok "${name} OK (${waited}s)."; return 0; fi
    sleep 3; waited=$((waited + 3))
  done
  die "${name} did not return 200 within ${timeout}s (${url})."
}

# =============================================================================
#  FUNCTIONS THAT RUN ON THE VPS  (shipped over SSH via `declare -f`)
# =============================================================================

# Install/ensure Docker Engine + Compose v2 + git/rsync/openssl (idempotent).
provision_here() {
  export DEBIAN_FRONTEND=noninteractive
  local need_apt=0 c
  for c in docker git rsync openssl curl; do
    command -v "$c" >/dev/null 2>&1 || need_apt=1
  done
  if command -v docker >/dev/null 2>&1; then
    docker compose version >/dev/null 2>&1 || need_apt=1
  fi
  if [ "$need_apt" -eq 1 ]; then
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg rsync git openssl
  fi
  if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || { echo "docker compose v2 plugin is missing on the target" >&2; exit 1; }
  echo "docker ready: $(docker --version) | $(docker compose version --short 2>/dev/null || echo 'compose ok')"
}

# Create a production .env on first run only; never clobber an existing one.
ensure_env_here() {
  cd "$REMOTE_DIR"
  if [ -f .env ]; then
    echo "existing .env kept at $REMOTE_DIR/.env"
    return 0
  fi
  [ -f .env.production.example ] || { echo ".env.production.example missing in $REMOTE_DIR" >&2; exit 1; }
  cp .env.production.example .env
  local gen dbre dpw jw ak
  gen() { openssl rand -base64 "$1" | tr -d '\n'; }
  # DB_PASSWORD and REDIS_PASSWORD are embedded in URLs
  # (postgresql://user:PASS@host and redis://:PASS@host). base64 output often
  # contains '/' and '+', and a '/' terminates the URL authority — so these two
  # use URL-safe HEX. JWT_SECRET / AI_ENGINE_API_KEY are never URL-embedded.
  dbre="$(openssl rand -hex 24)"; dpw="$(openssl rand -hex 32)"
  jw="$(gen 48)"; ak="$(gen 48)"
  sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=${dbre}|"            .env
  sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${dpw}|"       .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${jw}|"                .env
  sed -i "s|^AI_ENGINE_API_KEY=.*|AI_ENGINE_API_KEY=${ak}|"  .env
  sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=${CORS_ORIGIN}|"     .env
  # DOMAIN must be non-empty for ANY `docker compose config` (the edge nginx
  # service is always interpolated). In HTTP/IP mode it is unused, so point it
  # at the host itself. For a real HTTPS deploy, edit this to your domain and
  # run ./deploy.sh --edge instead.
  sed -i "s|^DOMAIN=.*|DOMAIN=${PUBLIC_HOST}|"               .env
  echo "generated $REMOTE_DIR/.env (fresh secrets, CORS_ORIGIN=${CORS_ORIGIN}, DOMAIN=${PUBLIC_HOST})"
}

# Build + migrate + start the stack (via deploy.sh), then the HTTP gateway.
deploy_here() {
  cd "$REMOTE_DIR"
  # shellcheck disable=SC2086
  bash deploy.sh ${PASSTHRU:-}
  if [ "${DO_HTTP:-1}" -eq 1 ]; then
    echo "starting HTTP gateway: ${HTTP_SERVICE} (profile ${HTTP_PROFILE})"
    docker compose -f "$COMPOSE_FILE" --profile "$HTTP_PROFILE" up -d "$HTTP_SERVICE"
  fi
}

# =============================================================================
#  LOCAL ORCHESTRATION
# =============================================================================
run_local_orchestration() {
  log "ALPHA.5 PRO -> ${VPS}   (remote dir: ${REMOTE_DIR})"
  command -v ssh  >/dev/null 2>&1 || die "ssh not found on this machine."
  command -v curl >/dev/null 2>&1 || die "curl not found on this machine."
  ssh "${SSH_OPTS[@]}" "$VPS" true || die "Cannot SSH to ${VPS}. Check the IP, your SSH key, and the firewall."

  log "Step 1/4 — provisioning Docker toolchain on ${VPS}"
  ssh "${SSH_OPTS[@]}" "$VPS" bash -s <<PAYLOAD
$(declare -f provision_here)
set -euo pipefail
provision_here
PAYLOAD

  if [ "$DO_RSYNC" -eq 1 ]; then
    log "Step 2/4 — syncing working tree -> ${VPS}:${REMOTE_DIR}"
    command -v rsync >/dev/null 2>&1 || die "rsync not found locally (install it, or pass --skip-rsync)."
    ssh "${SSH_OPTS[@]}" "$VPS" "mkdir -p '$REMOTE_DIR'"
    rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${RSYNC_EXCLUDES[@]}" \
      "${LOCAL_DIR}/" "${VPS}:${REMOTE_DIR}/"
    ok "Code synced."
  else
    warn "Step 2/4 — --skip-rsync: using the code already on ${VPS}."
  fi

  log "Step 3/4 — env + build + migrate + start (+ HTTP gateway)"
  ssh "${SSH_OPTS[@]}" "$VPS" bash -s <<PAYLOAD
$(declare -f ensure_env_here deploy_here)
set -euo pipefail
export REMOTE_DIR='${REMOTE_DIR}'
export CORS_ORIGIN='http://${VPS_HOST}'
export PUBLIC_HOST='${VPS_HOST}'
export COMPOSE_FILE='${COMPOSE_FILE}'
export HTTP_PROFILE='${HTTP_PROFILE}'
export HTTP_SERVICE='${HTTP_SERVICE}'
export DO_HTTP='${DO_HTTP}'
export PASSTHRU='${PASSTHRU_STR}'
ensure_env_here
deploy_here
PAYLOAD
  ok "Stack deployed."

  log "Step 4/4 — verifying the live site"
  wait_http "http://${VPS_HOST}/nginx-health" "public gateway :80" 60
  wait_http "http://${VPS_HOST}/health"       "core-backend via gateway" 90
}

# =============================================================================
#  ON-VPS EXECUTION
# =============================================================================
run_on_vps() {
  export REMOTE_DIR="$LOCAL_DIR"
  export CORS_ORIGIN="http://${VPS_HOST}"
  export PUBLIC_HOST="${VPS_HOST}"
  export COMPOSE_FILE HTTP_PROFILE HTTP_SERVICE DO_HTTP
  export PASSTHRU="$PASSTHRU_STR"
  log "Running directly on the VPS (${LOCAL_DIR})"
  provision_here
  ensure_env_here
  deploy_here
  wait_http "http://127.0.0.1/nginx-health" "public gateway :80" 60
  wait_http "http://127.0.0.1/health"       "core-backend via gateway" 90
}

# =============================================================================
#  MAIN
# =============================================================================
if [ "$MODE_REMOTE" -eq 1 ]; then run_on_vps; else run_local_orchestration; fi

echo
ok "${C_BOLD}Deploy complete.${C_RESET}"
echo "   App       : http://${VPS_HOST}/"
if [ "$DO_HTTP" -eq 1 ]; then
  echo "   Gateway   : ${HTTP_SERVICE} (profile ${HTTP_PROFILE}) listening on :80"
fi
echo "   Status    : ssh ${VPS} 'cd ${REMOTE_DIR} && docker compose -f ${COMPOSE_FILE} ps'"
echo "   Logs      : ssh ${VPS} 'cd ${REMOTE_DIR} && docker compose -f ${COMPOSE_FILE} logs -f core-backend'"
echo
echo "   NOTE: the board reports HONESTLY. Empty/SCORED/WAITING states are real"
echo "         results, not failures to 'fix'. EXECUTION_DRY_RUN stays true — do"
echo "         not add force/override flags."
