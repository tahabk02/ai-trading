# restart_bridge.ps1 - rebuild + force-recreate the pocket-bridge container so the
# new POCKET_OPTION_SSID (with isOptimized) is actually picked up, then verify the
# logs show SSID loaded / FEED_LIVE / TICK_RECEIVED.
#
# WHY: docker-compose restart would NOT work here - compose env_file is re-read
# only on recreate, and `COPY . .` in the old Dockerfile baked .env into the image.

param(
  [int]$LogWaitSec = 15,
  [int]$ContainerLogLines = 30
)

$ErrorActionPreference = "Continue"
$ROOT = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ROOT

Write-Host "[restart_bridge] 1/3 freeing ports ..."
& (Join-Path $PSScriptRoot "free_ports.ps1")
if ($LASTEXITCODE -ne 0) { Write-Host "[restart_bridge] ports not free - continuing anyway (docker will reclaim on recreate)" }

Write-Host "[restart_bridge] 2/3 making sure Docker engine is up ..."
& (Join-Path $PSScriptRoot "start_docker.ps1")
if ($LASTEXITCODE -ne 0) {
  Write-Host "[restart_bridge] FATAL: Docker engine unavailable - cannot rebuild"
  exit 1
}

Write-Host "[restart_bridge] 3/3 rebuilding + force-recreating pocket-bridge ..."
docker-compose up -d --build --force-recreate pocket-bridge
if ($LASTEXITCODE -ne 0) {
  Write-Host "[restart_bridge] FATAL: docker-compose up failed (exit $LASTEXITCODE)"
  exit 1
}

Write-Host "[restart_bridge] sleeping ${LogWaitSec}s for the bridge to boot ..."
Start-Sleep -Seconds $LogWaitSec

Write-Host "[restart_bridge] --- docker logs pocket_option_bridge (tail ${ContainerLogLines}) ---"
docker logs --tail $ContainerLogLines pocket_option_bridge 2>&1

$logs = docker logs --tail 200 pocket_option_bridge 2>&1 | Out-String
$ssid = $logs -match "SSID loaded"
$live = $logs -match "FEED_LIVE"
$tick = $logs -match "TICK_RECEIVED"
Write-Host ("[restart_bridge] checks - SSID_LOADED={0} FEED_LIVE={1} TICK_RECEIVED={2}" -f $ssid, $live, $tick)
if ($ssid -and $live) {
  Write-Host "[restart_bridge] BRIDGE OK"
  exit 0
}
Write-Host "[restart_bridge] BRIDGE UNHEALTHY (SSID_LOADED=$ssid FEED_LIVE=$live TICK_RECEIVED=$tick)"
exit 1