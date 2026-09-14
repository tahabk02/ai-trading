# start_docker.ps1 - make sure the Docker engine responds, else launch Docker Desktop
# and wait up to 120s for it to come up. Exit 0 = engine ready, 1 = still down.
#
# The raw `docker ps` call hangs forever when the daemon is dead, so the probe
# runs inside a background job with an 8s ceiling.

param(
  [string]$DockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe",
  [int]$MaxWaitSec = 120,
  [int]$ProbeTimeoutSec = 8
)

$ErrorActionPreference = "Stop"

function Test-DockerEngine {
  $job = Start-Job -ScriptBlock {
    $head = & docker ps -q 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { "UP" } else { "DOWN:$LASTEXITCODE" }
  }
  if (Wait-Job -Job $job -Timeout $ProbeTimeoutSec) {
    $res = Receive-Job -Job $job | Select-Object -Last 1
    Remove-Job -Job $job -Force
    return ($res -eq "UP")
  }
  Remove-Job -Job $job -Force
  return $false
}

if (Test-DockerEngine) {
  Write-Host "[start_docker] Docker engine already responding"
  exit 0
}

Write-Host "[start_docker] Docker engine NOT responding - resetting the WSL backend first ..."
# The classic cause of a dead engine pipe is a wedged WSL VM. A normal
# `wsl --shutdown` also hangs when WSL is stuck, so run it under the same job
# ceiling. If WSL refuses to answer at all then even this returns fast (job
# timeout) and we fall through to a plain Docker Desktop relaunch.
$wslJob = Start-Job -ScriptBlock { & wsl --shutdown 2>$null; exit $LASTEXITCODE }
if (Wait-Job -Job $wslJob -Timeout $ProbeTimeoutSec) {
  Remove-Job -Job $wslJob -Force
  Write-Host "[start_docker] wsl --shutdown issued"
} else {
  Remove-Job -Job $wslJob -Force
  Write-Host "[start_docker] wsl is unresponsive (--shutdown hung) - trying Docker Desktop relaunch anyway"
}

Write-Host "[start_docker] launching Docker Desktop ..."
if (-not (Test-Path -LiteralPath $DockerDesktop)) {
  Write-Host "[start_docker] FATAL: Docker Desktop not found at $DockerDesktop"
  exit 1
}
try {
  Start-Process -FilePath $DockerDesktop
} catch {
  Write-Host "[start_docker] failed to launch Docker Desktop: $($_.Exception.Message)"
  exit 1
}
Write-Host "[start_docker] waiting up to ${MaxWaitSec}s for the engine ..."
$deadline = (Get-Date).AddSeconds($MaxWaitSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 5
  if (Test-DockerEngine) {
    Write-Host ("[start_docker] engine UP after {0}s" -f ($MaxWaitSec - [int]($deadline - (Get-Date)).TotalSeconds))
    exit 0
  }
  Write-Host "[start_docker] ...not yet"
}
Write-Host "[start_docker] FATAL: engine did not come up within ${MaxWaitSec}s"
Write-Host "[start_docker] RECOVERY (elevated PowerShell):"
Write-Host "  Restart-Service WSLService -Force"
Write-Host "  Stop-Process -Id (Get-Process vmmemWSL).Id -Force   # wedged WSL VM blocks wsl.exe"
Write-Host "  (or simply reboot), then re-run:  scripts\dev_stack.ps1"
exit 1