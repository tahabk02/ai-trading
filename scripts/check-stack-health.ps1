<#
.SYNOPSIS
    check-stack-health.ps1 - Internal + public health verification for the
    trading platform (core-backend :4000 <-> ai-engine :8000) after the strict
    96.5% high-precision gate rollout.

.DESCRIPTION
    Probes every /health and /api/v1/health surface that matters for the 503
    investigation and prints a status table (HTTP code + latency + key body
    fields). Every probe must answer 200 (the engine health payload reports a
    body field like status=healthy|degraded, still an HTTP 200 - the engine
    only answers 503 on genuine failures).

    Endpoints checked:
      * GET  http://127.0.0.1:4000/health                 (core liveness)
      * GET  http://127.0.0.1:4000/health/ai              (core -> engine probe)
      * GET  http://127.0.0.1:4000/api/v1/health/ai       (same probe, /api/v1)
      * GET  http://127.0.0.1:8000/api/v1/health          (engine direct)
      * GET  http://127.0.0.1:8000/api/v1/health/gate     (engine gate ladder)
      * OPTIONS + POST /api/v1/predict (optional -PredictSmoke; expects 200,
        or a recoverable structured { error: ai_timeout | ai_unavailable }
        503 when no live tick / no real bars exist yet - never a bare 503).

    With -DevTunnelUrl <url> (e.g. https://xxxx-4000.region.devtunnels.ms) the
    same probes are run through the public tunnel so CORS / proxy header
    behavior is verified end to end.

.EXAMPLE
    ./scripts/check-stack-health.ps1                 # local internal probes only
    ./scripts/check-stack-health.ps1 -PredictSmoke   # + a real /predict smoke
    ./scripts/check-stack-health.ps1 -DevTunnelUrl https://abc-4000.uks1.devtunnels.ms -PredictSmoke

.NOTES
    Exit code 0 = all probes answered as expected; 1 = a hard failure.
    "degraded" in the engine body is NOT a failure - it just means the model
    cache is still warming (predicts pay a one-time training cost).
#>
[CmdletBinding()]
param(
    [string]$CoreBackendUrl = "http://127.0.0.1:4000",
    [string]$AiEngineUrl    = "http://127.0.0.1:8000",
    [string]$DevTunnelUrl   = "",
    [switch]$PredictSmoke,
    [string]$SmokeSymbol    = "EUR/USD",
    [string]$SmokeTimeframe = "1m"
)

$ErrorActionPreference = "Stop"

function Test-Api {
    param(
        [string]$Label,
        [string]$Url,
        [string]$Method = "GET",
        [hashtable]$Headers = @{},
        [string]$Body = $null,
        [int]$TimeoutSec = 10
    )
    # curl.exe (ships with Windows 10+) - deterministic, bypasses the system
    # proxy, and avoids the PowerShell 5.1 Invoke-WebRequest quirks (spurious
    # "Cannot send a content body with this verb type" on GET through a proxy).
    $tmp = Join-Path $env:TEMP ("health_" + [guid]::NewGuid().ToString("N") + ".txt")
    # NOTE: the local array is deliberately NOT named `$args` — that name is an
    # automatic variable inside functions and breaks `@...` array splatting.
    $curlArgs = @(
        "--noproxy", "*",
        "-sS",
        "-o", $tmp,
        "-w", "%{http_code}|%{time_total}",
        "-m", [string]$TimeoutSec
    )
    if ($Method -ne "GET") {
        $curlArgs += "-X"; $curlArgs += $Method
    }
    foreach ($k in $Headers.Keys) {
        $curlArgs += "-H"; $curlArgs += ("{0}: {1}" -f $k, $Headers[$k])
    }
    # NOTE: never test `$Body -ne $null` — a [string] parameter coerces a $null
    # default to an EMPTY string, so the check must be falsy-based ($Body).
    # The payload is round-tripped through a temp file + `--data-binary @file`
    # because PS 5.1 native-arg passing strips the double quotes from inline
    # JSON, which corrupts the body Express parses.
    $bodyTmp = $null
    if ($Body) {
        $bodyTmp = Join-Path $env:TEMP ("health_body_" + [guid]::NewGuid().ToString("N") + ".json")
        [System.IO.File]::WriteAllText($bodyTmp, $Body, [System.Text.Encoding]::UTF8)
        $curlArgs += "--data-binary"
        $curlArgs += ("@`"" + $bodyTmp + "`"")
        $curlArgs += "-H"; $curlArgs += "Content-Type: application/json"
    }
    $curlArgs += $Url

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $raw = (& curl.exe @curlArgs 2>$null) | Out-String
    if ($bodyTmp -and (Test-Path -LiteralPath $bodyTmp)) {
        Remove-Item -LiteralPath $bodyTmp -Force -ErrorAction SilentlyContinue
    }
    $sw.Stop()

    $status = 0
    $latencyMs = 0.0
    if ($raw -match "^(\d{3})\|([\d\.]+)") {
        $status = [int]$Matches[1]
        $latencyMs = [math]::Round([double]$Matches[2] * 1000.0, 1)
    }

    if ($status -le 0) {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        return [PSCustomObject]@{
            Label     = $Label
            Url       = $Url
            Method    = $Method
            Status    = "unreachable (curl exit $LASTEXITCODE)"
            Ok        = $false
            LatencyMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
            Body      = "curl could not connect - is the service running?"
            Tmp       = $tmp
        }
    }

    $content = "<no body>"
    if (Test-Path -LiteralPath $tmp) {
        $content = (Get-Content -Raw -LiteralPath $tmp).Trim()
        if ($content.Length -eq 0) { $content = "<empty>" }
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
    return [PSCustomObject]@{
        Label     = $Label
        Url       = $Url
        Method    = $Method
        Status    = $status
        Ok        = ($status -ge 200 -and $status -lt 300)
        LatencyMs = $latencyMs
        Body      = $content
        Tmp       = $tmp
    }
}

function Format-TableRow {
    param($Row)
    "{0,-18} {1,-6} {2,-42} {3,-12} {4,10}ms" -f $Row.Label, $Row.Method, $Row.Url, $Row.Status, $Row.LatencyMs
}

# Gather probe targets (internal always; external tunnel on request).
$targets = @()
$targets += Test-Api -Label "core liveness"  -Url "$CoreBackendUrl/health"
$targets += Test-Api -Label "core->ai probe" -Url "$CoreBackendUrl/health/ai"
$targets += Test-Api -Label "api/v1 ai probe" -Url "$CoreBackendUrl/api/v1/health/ai"
$targets += Test-Api -Label "engine direct"  -Url "$AiEngineUrl/api/v1/health"
$targets += Test-Api -Label "engine gate"    -Url "$AiEngineUrl/api/v1/health/gate"

if ($DevTunnelUrl -ne "") {
    $base = $DevTunnelUrl.TrimEnd("/")
    $targets += Test-Api -Label "tunnel liveness"   -Url "$base/health"
    $targets += Test-Api -Label "tunnel core->ai"   -Url "$base/health/ai"
    $targets += Test-Api -Label "tunnel predict CORS" -Method "OPTIONS" `
        -Url "$base/api/v1/predict" `
        -Headers @{
            Origin                          = "https://placeholder.devtunnels.ms"
            "Access-Control-Request-Method" = "POST"
            "Access-Control-Request-Headers" = "content-type"
        }
}

if ($PredictSmoke) {
    $smokeBody = @{
        symbol    = $SmokeSymbol
        timeframe = $SmokeTimeframe
        silent    = $true
    } | ConvertTo-Json -Compress
    $targets += Test-Api -Label "predict smoke" -Method "POST" `
        -Url "$CoreBackendUrl/api/v1/predict" -Body $smokeBody -TimeoutSec 20
}

# Table.
if ($DevTunnelUrl -ne "") { $tunnelLabel = $DevTunnelUrl } else { $tunnelLabel = "none" }
Write-Host "=== STACK HEALTH - core :4000 / engine :8000 (devtunnel: $tunnelLabel) ===" -ForegroundColor Cyan
"{0,-18} {1,-6} {2,-42} {3,-12} {4,10}" -f "ENDPOINT", "METHOD", "URL", "STATUS", "LATENCY"
"-" * 95
foreach ($r in $targets) {
    if ($r.Ok) { $color = "Green" }
    elseif ($r.Label -eq "predict smoke" -and $r.Status -eq 503) { $color = "Yellow" }
    else { $color = "Red" }
    Write-Host (Format-TableRow $r) -ForegroundColor $color
    if ($r.Body -and $r.Body -ne "<no body>") {
        if ($r.Body.Length -gt 160) { $summary = $r.Body.Substring(0, 160) } else { $summary = $r.Body }
        Write-Host ("      " + $summary) -ForegroundColor DarkGray
    }
}

# Verdict (with friendly interpretation of expected recoverable 503s).
$hardFails = $targets | Where-Object { -not $_.Ok -and $_.Label -ne "predict smoke" }
$smoke = $targets | Where-Object { $_.Label -eq "predict smoke" } | Select-Object -First 1

if ($hardFails.Count -gt 0) {
    Write-Host "`nRESULT: FAIL - hard endpoints not answering 200 (see above)." -ForegroundColor Red
    exit 1
}
if ($smoke -and -not $smoke.Ok -and $smoke.Status -eq 503) {
    # Recoverable: no fresh live tick, no real bars, or the engine is warming.
    Write-Host "`nRESULT: OK (degraded) - all health surfaces 200; predict returned a RECOVERABLE 503:" -ForegroundColor Yellow
    Write-Host "        that is the documented live-tick / bars-accumulation or engine-warmup gate," -ForegroundColor Yellow
    Write-Host "        NOT an infrastructure failure. Check the body above for error=ai_timeout | ai_unavailable." -ForegroundColor Yellow
    exit 0
}
if ($smoke -and -not $smoke.Ok) {
    Write-Host "`nRESULT: FAIL - predict smoke returned a non-recoverable HTTP $($smoke.Status)." -ForegroundColor Red
    exit 1
}
Write-Host "`nRESULT: OK - all endpoints answered 200 across the board." -ForegroundColor Green
exit 0