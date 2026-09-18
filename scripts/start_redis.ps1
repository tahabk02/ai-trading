# start_redis.ps1 — bring up the radar_bus Redis container and prove it answers.
#
#   docker-compose up -d redis   → start (or keep running) the redis service
#   wait ~10s                    → let Redis finish binding
#   docker exec radar_bus redis-cli ping
#                                 → must print PONG
# Exit 0 on PONG, 1 otherwise.

$ErrorActionPreference = "Stop"

Write-Output "==> docker-compose up -d redis"
docker-compose up -d redis
if ($LASTEXITCODE -ne 0) {
    Write-Error "docker-compose up -d redis failed (exit $LASTEXITCODE)"
    exit 1
}

Write-Output "==> waiting 10s for redis to bind"
Start-Sleep -Seconds 10

Write-Output "==> docker exec radar_bus redis-cli ping"
$ping = docker exec radar_bus redis-cli ping 2>&1
Write-Output $ping

if (($ping -join " ").TrimEnd() -eq "PONG") {
    Write-Output "REDIS OK (PONG)"
    exit 0
}
Write-Error "Redis did not answer PONG. Is radar_bus running? (docker ps | findstr radar_bus)"
exit 1