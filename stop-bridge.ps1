$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json not found.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$runtimeDir = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
$pidPath = Join-Path $runtimeDir 'bridge.pid'
$stopPath = Join-Path $runtimeDir 'stop.request'

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Output 'Bridge is not running.'
    exit 0
}

$bridgePid = [int](Get-Content -Raw -LiteralPath $pidPath)
$process = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
if (-not $process) {
    Remove-Item -LiteralPath $pidPath -Force
    Write-Output 'Bridge was not running; removed the stale PID file.'
    exit 0
}

New-Item -ItemType File -Force -Path $stopPath | Out-Null
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) {
        Write-Output "Bridge stopped gracefully (PID $bridgePid)."
        exit 0
    }
    Start-Sleep -Milliseconds 250
}

throw "Bridge did not stop within 20 seconds; no forced termination was attempted."
