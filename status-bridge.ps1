$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Output 'Bridge status: not configured (bridge.config.json is missing)'
    exit 1
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$runtimeDir = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
$pidPath = Join-Path $runtimeDir 'bridge.pid'
$stdoutPath = Join-Path $runtimeDir 'bridge.stdout.log'

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Output 'Bridge status: stopped'
    exit 1
}

$bridgePid = [int](Get-Content -Raw -LiteralPath $pidPath)
if (-not (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) {
    Write-Output "Bridge status: stopped (stale PID $bridgePid)"
    exit 1
}

$ready = (Test-Path -LiteralPath $stdoutPath) -and
    (Select-String -LiteralPath $stdoutPath -Pattern 'READY: Channel SDK connected' -Quiet)
Write-Output "Bridge status: running; PID=$bridgePid; connected=$ready"
