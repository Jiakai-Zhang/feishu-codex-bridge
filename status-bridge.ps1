$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Output 'Bridge status: not configured (bridge.config.json is missing)'
    exit 1
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$runtimeDir = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
$pidPath = Join-Path $runtimeDir 'bridge.pid'
$stdoutPath = Join-Path $runtimeDir 'bridge.stdout.log'
$bridge = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'channel-bridge.mjs'))

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Output 'Bridge status: stopped'
    exit 1
}

$bridgePid = [int](Get-Content -Raw -LiteralPath $pidPath)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid" -ErrorAction SilentlyContinue
$isBridge = $process -and $process.Name -eq 'node.exe' -and [string]$process.CommandLine -like "*$bridge*"
if (-not $isBridge) {
    Write-Output "Bridge status: stopped (stale PID $bridgePid)"
    exit 1
}

$ready = (Test-Path -LiteralPath $stdoutPath) -and
    (Select-String -LiteralPath $stdoutPath -Pattern 'READY: Channel SDK connected' -Quiet)
Write-Output "Bridge status: running; PID=$bridgePid; connected=$ready"
