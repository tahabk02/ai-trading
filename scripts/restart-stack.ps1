<#
.SYNOPSIS
    restart-stack.ps1 — ONE-COMMAND recovery for the trading stack after a
    crash / stale-cache / flaky-relay episode (EADDRINUSE-safe).

.DESCRIPTION
    Runs the full restart sequence in a safe, idempotent order:

      1. FREE PORTS (3000/4000/8000/8788/8789)   — kills whatever is squatting
         on a dev port, so "EADDRINUSE" can never block a restart.
      2. FLUSH REDIS                              — the engine's quote cache,
         model TTL cache and the execution bus all sit in Redis; a stale cached
         verdict is the #1 cause of a phantom "NO ACTIONABLE SIGNAL" after a
         partial crash. Native: redis-cli FLUSHALL (if on PATH) else the
         compose `radar_bus` container. Harmless empty-set when no Redis runs.
      3. PURGE NEXT CACHES                        — `.next` (dev) + `client-app/.next`
         so a rebuilt dashboard never re-serves a stale prerender or a stale
         hydration snapshot.
      4. RESTART THE STACK
           Docker mode (-Docker):  docker compose down --remove-orphans
             -> docker compose up -d --build --force-recreate (fresh images,
             recreated containers, engine reachable via ai-engine:8000).
           Native mode (default):  node scripts\bridge-autopilot.mjs start
             (spawns npm run dev = backend + ai-engine + client and exits only
             after the relay PROVES it streams live ticks).
      5. HEALTH POLL  — runs check-stack-health.ps1 until core + engine answer
         200 (bounded), then a final report.

    Safe to re-run at any point; every step is idempotent.

.EXAMPLE
    .\scripts\restart-stack.ps1                      # native npm stack
    .\scripts\restart-stack.ps1 -Docker              # docker compose stack
    .\scripts\restart-stack.ps1 -SkipRedis -SkipPurge   # quick bounce only

.NOTES
    PowerShell 5.1 compatible. Run from anywhere; resolves repo root from
    $PSScriptRoot. Requires Docker Desktop running for -Docker (see
    scripts\start_docker.ps1).
#>
[CmdletBinding()]
param(
    [switch]$Docker,
    [switch]$SkipRedis,
    [switch]$SkipPurge,
    [switch]$SkipHealth,
    [int]$HealthPollSec = 120
)

$ErrorActionPreference = "Continue"
$ROOT = Resolve-Path (Join-Path $PSScriptRoot "..")
$CLIENT = Join-Path $ROOT "client-app"
$MAX_REDIS_WAIT_SEC = 20

function Write-Step($msg) {
    Write-Host ""
    Write-Host ("[restart-stack] " + $msg) -ForegroundColor Cyan
}

function Invoke-FreePorts {
    Write-Step "STEP 1/5  freeing dev ports (3000/4000/8000/8788/8789) - EADDRINUSE guard ..."
    & (Join-Path $PSScriptRoot "free_ports.ps1")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[restart-stack] FATAL: ports still locked - re-run from an ELEVATED PowerShell." -ForegroundColor Red
        exit 1
    }
}

function Invoke-FlushRedis {
    if ($SkipRedis) { Write-Step "STEP 2/5  SKIPPED (SkipRedis)."; return }
    Write-Step "STEP 2/5  flushing Redis caches (quote cache, model TTL, execution bus) ..."

    $native = Get-Command redis-cli -ErrorAction SilentlyContinue
    if ($native) {
        $out = (& redis-cli FLUSHALL 2>&1 | Out-String).Trim()
        Write-Host "    native redis-cli -> $out"
        return
    }

    # No native client: flush inside the compose `radar_bus` container if up.
    $deadline = (Get-Date).AddSeconds($MAX_REDIS_WAIT_SEC)
    while ((Get-Date) -lt $deadline) {
        $c = (& docker ps -q -f "name=radar_bus" 2>$null | Out-String).Trim()
        if ($c) {
            $out = (& docker exec radar_bus redis-cli FLUSHALL 2>$null | Out-String).Trim()
            Write-Host "    docker radar_bus -> $out"
            return
        }
        Start-Sleep -Seconds 2
    }
    Write-Host "    no redis-cli and no radar_bus container -> nothing to flush (OK)."
}

function Invoke-PurgeNext {
    if ($SkipPurge) { Write-Step "STEP 3/5  SKIPPED (SkipPurge)."; return }
    Write-Step "STEP 3/5  purging Next.js caches (stale prerenders / hydration snapshots) ..."
    foreach ($dir in @(Join-Path $ROOT ".next", (Join-Path $CLIENT ".next"))) {
        if (Test-Path -LiteralPath $dir) {
            $size = (Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
            $mb = if ($size) { [math]::Round($size / 1MB, 1) } else { 0 }
            Write-Host "    removed $dir (was $mb MB)"
        }
    }
    # Speed layer keeps its own volatile swap/cache dirs.
    $speed = Join-Path $CLIENT ".next/cache"
    if (Test-Path -LiteralPath $speed) {
        Remove-Item -LiteralPath $speed -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-RestartDocker {
    Write-Step "STEP 4/5  docker compose up -d --build --force-recreate ..."
    Push-Location $ROOT
    try {
        & docker compose down --remove-orphans
        if ($LASTEXITCODE -ne 0) { Write-Host "    compose down had warnings - continuing." -ForegroundColor DarkYellow }
        & docker compose up -d --build --force-recreate
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[restart-stack] FATAL: compose up failed. Run scripts\start_docker.ps1 first." -ForegroundColor Red
            exit 1
        }
    } finally {
        Pop-Location
    }
    Write-Host "    containers recreated. Waiting for services to stabilise ..."
    Start-Sleep -Seconds 12
}

function Invoke-RestartNative {
    Write-Step "STEP 4/5  starting the native dev stack (bridge-autopilot.mjs start) ..."
    if (-not (Test-Path -LiteralPath (Join-Path $ROOT "node_modules\.bin\concurrently.cmd"))) {
        Write-Host "[restart-stack] node_modules missing at repo root - run npm install first." -ForegroundColor Red
        exit 1
    }
    & node (Join-Path $ROOT "scripts\bridge-autopilot.mjs") start
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[restart-stack] autopilot exited non-zero - check the bridge relay / SSID." -ForegroundColor Red
        exit 1
    }
}

function Invoke-HealthPoll {
    if ($SkipHealth) { Write-Step "STEP 5/5  SKIPPED (SkipHealth)."; return }
    Write-Step "STEP 5/5  polling stack health (core :4000 + engine :8000) ..."
    $deadline = (Get-Date).AddSeconds($HealthPollSec)
    while ((Get-Date) -lt $deadline) {
        $core = (Get-PidOnPort 4000) -ne $null
        $engine = (Get-PidOnPort 8000) -ne $null
        if ($core -and $engine) { break }
        Start-Sleep -Seconds 3
    }
    & (Join-Path $PSScriptRoot "check-stack-health.ps1") -PredictSmoke
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n[restart-stack] DONE - stack healthy." -ForegroundColor Green
    } elseif ($LASTEXITCODE -eq 1) {
        Write-Host "`n[restart-stack] DONE - stack up but health check found issues (see report above)." -ForegroundColor Yellow
    }
}

function Get-PidOnPort($port) {
    $netstat = netstat -ano -n
    foreach ($line in $netstat) {
        if ($line -match "\sTCP\s+\S+:${port}\s+\S+:0?\s+LISTENING\s+(\d+)\s*$") {
            return [int]$matches[1]
        }
    }
    return $null
}

$mode = if ($Docker) { "docker compose" } else { "native npm" }
Write-Host "=== restart-stack -- mode: $mode ===" -ForegroundColor Cyan
Invoke-FreePorts
Invoke-FlushRedis
Invoke-PurgeNext
if ($Docker) { Invoke-RestartDocker } else { Invoke-RestartNative }
Invoke-HealthPoll
exit 0