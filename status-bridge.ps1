$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Output 'Bridge status: not configured (bridge.config.json is missing)'
    exit 1
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$mode = if ([string]::IsNullOrWhiteSpace([string]$config.mode)) { 'project-agent' } else { [string]$config.mode }
$runtimeDir = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
$pidPath = Join-Path $runtimeDir 'bridge.pid'
$stdoutPath = Join-Path $runtimeDir 'bridge.stdout.log'
$appServerPidPath = Join-Path $runtimeDir 'codex-app-server.pid'
$supervisorPidPath = Join-Path $runtimeDir 'bridge-supervisor.pid'
$supervisorState = 'not-running'
if (Test-Path -LiteralPath $supervisorPidPath -PathType Leaf) {
    $supervisorPid = [int](Get-Content -Raw -LiteralPath $supervisorPidPath)
    if (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue) {
        $supervisorState = "running:$supervisorPid"
    }
}

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Output "Bridge status: stopped; supervisor=$supervisorState"
    exit 1
}

$bridgePid = [int](Get-Content -Raw -LiteralPath $pidPath)
if (-not (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) {
    Write-Output "Bridge status: stopped (stale PID $bridgePid)"
    exit 1
}

$ready = (Test-Path -LiteralPath $stdoutPath) -and
    (Select-String -LiteralPath $stdoutPath -Pattern 'READY: Channel SDK connected' -Quiet)
$appServerState = 'not-used'
if ($mode -eq 'session-relay') {
    $appServerState = 'stopped'
    if (Test-Path -LiteralPath $appServerPidPath -PathType Leaf) {
        $appServerPid = [int](Get-Content -Raw -LiteralPath $appServerPidPath)
        $appServerProcess = Get-Process -Id $appServerPid -ErrorAction SilentlyContinue
        if ($appServerProcess) { $appServerState = "running:$appServerPid" }
    }
}
Write-Output "Bridge status: running; PID=$bridgePid; mode=$mode; connected=$ready; supervisor=$supervisorState; sharedAppServer=$appServerState"
