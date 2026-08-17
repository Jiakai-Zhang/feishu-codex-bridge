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
$watchdogState = 'disabled'
$desktopNetworkMode = 'not-configured'
if ($mode -eq 'session-relay') {
    $expectedRelayUrl = [string]$config.sessionRelay.appServerUrl
    $configuredRelayUrl = [Environment]::GetEnvironmentVariable(
        'CODEX_APP_SERVER_WS_URL', [EnvironmentVariableTarget]::User)
    if (-not [string]::IsNullOrWhiteSpace($expectedRelayUrl) -and $configuredRelayUrl -eq $expectedRelayUrl) {
        $watchdogState = 'stale'
        $bootstrapRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap'
        $relayStatePath = Join-Path $bootstrapRoot 'desktop-relay-state.json'
        $watchdogStatusPath = Join-Path $bootstrapRoot 'desktop-relay-watchdog-status.json'
        try {
            $relayState = Get-Content -Raw -LiteralPath $relayStatePath | ConvertFrom-Json
            $desktopNetworkMode = if ([string]::IsNullOrWhiteSpace([string]$relayState.desktopProxyUrl)) {
                'direct'
            } else {
                'local-proxy'
            }
            $watchdogStatus = Get-Content -Raw -LiteralPath $watchdogStatusPath | ConvertFrom-Json
            $heartbeatAt = [DateTime]::Parse([string]$watchdogStatus.heartbeatAt).ToUniversalTime()
            $heartbeatAgeSeconds = ([DateTime]::UtcNow - $heartbeatAt).TotalSeconds
            if ([bool]$relayState.enabled -and
                [string]$watchdogStatus.activationId -eq [string]$relayState.activationId -and
                [string]$watchdogStatus.state -eq 'ready' -and
                $heartbeatAgeSeconds -ge -5 -and $heartbeatAgeSeconds -le 20) {
                $watchdogState = 'ready'
            } elseif (-not [string]::IsNullOrWhiteSpace([string]$watchdogStatus.state)) {
                $watchdogState = [string]$watchdogStatus.state
            }
        } catch { }
    }
}
$supervisorState = 'not-running'
if (Test-Path -LiteralPath $supervisorPidPath -PathType Leaf) {
    $supervisorPid = [int](Get-Content -Raw -LiteralPath $supervisorPidPath)
    if (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue) {
        $supervisorState = "running:$supervisorPid"
    }
}
$bridgeName = if ($mode -eq 'session-relay') { 'session-relay.mjs' } else { 'channel-bridge.mjs' }
$bridge = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $bridgeName))

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Output "Bridge status: stopped; supervisor=$supervisorState"
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
$appServerState = 'not-used'
if ($mode -eq 'session-relay') {
    $appServerState = 'stopped'
    if (Test-Path -LiteralPath $appServerPidPath -PathType Leaf) {
        $appServerPid = [int](Get-Content -Raw -LiteralPath $appServerPidPath)
        $appServerProcess = Get-Process -Id $appServerPid -ErrorAction SilentlyContinue
        if ($appServerProcess) { $appServerState = "running:$appServerPid" }
    }
}
Write-Output "Bridge status: running; PID=$bridgePid; mode=$mode; connected=$ready; supervisor=$supervisorState; sharedAppServer=$appServerState; desktopRelayWatchdog=$watchdogState; desktopNetwork=$desktopNetworkMode"
