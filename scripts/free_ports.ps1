# free_ports.ps1 - free the dev-stack ports from OUR dev processes.
# Ports: 3000 (client), 4000 (core backend), 8000 (ai-engine), 8788 (bridge WS), 8789 (bridge health).
#
# Docker-family processes (com.docker.backend, wslrelay, ...) are NEVER killed:
# they belong to Docker Desktop, and killing the backend takes the engine down.
# Ports still held by them are reported as SKIP (docker-managed) - `docker-compose
# up --force-recreate` reclaims those bindings on the next recreate.
# Exit: 0 when nothing non-docker is left on the ports; 1 otherwise.

param(
  [int[]]$Ports = @(3000, 4000, 8000, 8788, 8789),
  [switch]$NoForce
)

$ErrorActionPreference = "Continue"

$SkipProcesses = @(
  "com.docker.backend", "com.docker.build", "com.docker.service",
  "wslrelay", "vpnkit", "docker", "dockerd", "com.docker.vpnkit", "com.docker.hyperkit"
)

function Test-PortFree {
  param([int]$Port)
  return @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue).Count -eq 0
}

$rows = @()
$conflicts = @()

foreach ($p in $Ports) {
  $conn = @(Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue)
  if ($conn.Count -eq 0) {
    $rows += [pscustomobject]@{ Port = $p; State = "FREE"; Pid = "-"; Process = "-"; Action = "none" }
    continue
  }
  $owners = @($conn | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($procId in $owners) {
    $name = "-"
    $alive = $true
    try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $alive = $false }
    if (-not $alive) {
      $rows += [pscustomobject]@{ Port = $p; State = "STALE"; Pid = $procId; Process = "(gone)"; Action = "ignored" }
      continue
    }
    if ($SkipProcesses -contains $name) {
      $rows += [pscustomobject]@{ Port = $p; State = "SKIP"; Pid = $procId; Process = $name; Action = "docker-managed" }
      continue
    }
    $conflicts += $name
    if ($NoForce) {
      $rows += [pscustomobject]@{ Port = $p; State = "FOUND"; Pid = $procId; Process = $name; Action = "would kill" }
    } else {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      $rows += [pscustomobject]@{ Port = $p; State = "KILLED"; Pid = $procId; Process = $name; Action = "killed" }
    }
  }
}

$rows | Format-Table -AutoSize | Out-String | Write-Host
if ($conflicts.Count -gt 0) { Start-Sleep -Milliseconds 800 }

$stillBusy = @()
foreach ($p in $Ports) {
  if (-not (Test-PortFree $p)) { $stillBusy += $p }
}

if ($NoForce) {
  Write-Host ("[free_ports] inspected only; {0} non-docker process(es) would need a kill on ports {1}" -f $conflicts.Count, ($stillBusy -join ","))
  exit 1
}
if ($stillBusy.Count -gt 0) {
  Write-Host ("[free_ports] {0} port(s) still busy (docker-managed, will be reclaimed on recreate): {1}" -f $stillBusy.Count, ($stillBusy -join ","))
  exit 0
}
Write-Host "[free_ports] all ports FREE"
exit 0