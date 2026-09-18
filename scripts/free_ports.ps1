# free_ports.ps1 — EADDRINUSE rescue for the trading stack.
#
# Finds any process bound to the dev ports (3000=frontend, 4000=backend,
# 8000=ai-engine, 8788/8789=pocket-bridge), kills it, re-verifies, and prints
# a port/pid/status table. Safe to re-run. Uses netstat (fast, always present)
# instead of the slow WMI/Get-NetTCPConnection path.

$ErrorActionPreference = "Stop"

$ports = @(3000, 4000, 8000, 8788, 8789)

function Get-PidOnPort($port) {
    $netstat = netstat -ano -n
    foreach ($line in $netstat) {
        if ($line -match "\sTCP\s+\S+:${port}\s+\S+:0?\s+LISTENING\s+(\d+)\s*$") {
            return [int]$matches[1]
        }
    }
    return $null
}

$rows = @()
foreach ($p in $ports) {
    $pidOnPort = Get-PidOnPort $p
    if ($pidOnPort) {
        $proc = Get-Process -Id $pidOnPort -ErrorAction SilentlyContinue
        $rows += [PSCustomObject]@{
            port   = $p
            pid    = $pidOnPort
            status = "killing"
            note   = if ($proc) { $proc.ProcessName } else { "unknown" }
        }
        Stop-Process -Id $pidOnPort -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
    } else {
        $rows += [PSCustomObject]@{
            port   = $p
            pid    = $null
            status = "free"
            note   = ""
        }
    }
}

Start-Sleep -Milliseconds 500

foreach ($r in $rows) {
    if ($r.status -eq "killing") {
        $still = Get-PidOnPort $r.port
        if ($still) {
            $r.status = "STILL LISTENING"
            $r.note = "pid still alive: $still"
        } else {
            $r.status = "free"
            $r.note = "killed"
        }
    }
}

Write-Output "PORTS:"
$rows | Format-Table -AutoSize -Property port, pid, status, note | Out-String | Write-Output

$locked = @($rows | Where-Object { $_.status -ne "free" })
if ($locked.Count -gt 0) {
    Write-Error "Cannot free: $($locked.port -join ', '). Re-run as Administrator."
    exit 1
}
Write-Output "All ports free. Ready to start the stack."
exit 0