# dev_stack.ps1 - ONE command that fixes everything and starts the full dev stack:
#   free ports -> Docker engine up -> rebuild/restart bridge -> autopilot start
# (autopilot spawns `npm run dev` = backend + ai-engine + client, and only exits
# after the relay PROVES it streams live ticks).
#
# Run from repo root:  powershell -ExecutionPolicy Bypass -File scripts\dev_stack.ps1

$ErrorActionPreference = "Continue"
$ROOT = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ROOT

Write-Host "[dev_stack] 1/4 freeing ports (3000/4000/8000/8788/8789) ..."
& (Join-Path $PSScriptRoot "free_ports.ps1")

Write-Host "[dev_stack] 2/4 Docker engine ..."
& (Join-Path $PSScriptRoot "start_docker.ps1")
if ($LASTEXITCODE -ne 0) {
  Write-Host "[dev_stack] FATAL: Docker engine never came up - aborting before starting the stack"
  exit 1
}

Write-Host "[dev_stack] 3/4 rebuild + recreate pocket-bridge with fresh SSID ..."
& (Join-Path $PSScriptRoot "restart_bridge.ps1")

Write-Host "[dev_stack] 4/4 autopilot: spawn npm run dev + verify live ticks ..."
if (Test-Path (Join-Path $ROOT "node_modules\.bin\concurrently.cmd")) {
  node scripts\bridge-autopilot.mjs start
  exit $LASTEXITCODE
}

Write-Host "[dev_stack] FATAL: node_modules missing at repo root - run npm install first"
exit 1