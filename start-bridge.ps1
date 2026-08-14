param(
    [ValidateRange(15, 300)]
    [int]$ReadyTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json not found. Copy bridge.config.example.json and fill in your local values first.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$projectRoot = [string]$config.workspace
$runtimeDir = Join-Path $projectRoot 'work\feishu-codex-bridge'
$pidPath = Join-Path $runtimeDir 'bridge.pid'
$stdoutPath = Join-Path $runtimeDir 'bridge.stdout.log'
$stderrPath = Join-Path $runtimeDir 'bridge.stderr.log'
$secretPath = Join-Path $runtimeDir 'channel-secret.dpapi'
$supervisorPidPath = Join-Path $runtimeDir 'bridge-supervisor.pid'
$restartPath = Join-Path $runtimeDir 'restart.request'
$supervisorStopPath = Join-Path $runtimeDir 'supervisor-stop.request'
$supervisorStdoutPath = Join-Path $runtimeDir 'bridge-supervisor.stdout.log'
$supervisorStderrPath = Join-Path $runtimeDir 'bridge-supervisor.stderr.log'
$supervisorScript = Join-Path $PSScriptRoot 'bridge-supervisor.ps1'
$desktopRelayPointerScript = Join-Path $PSScriptRoot 'desktop-relay-pointer.ps1'
$node = [string]$config.nodeExecutable
$mode = if ([string]::IsNullOrWhiteSpace([string]$config.mode)) { 'project-agent' } else { [string]$config.mode }
switch ($mode) {
    'project-agent' { $bridge = Join-Path $PSScriptRoot 'channel-bridge.mjs' }
    'session-relay' { $bridge = Join-Path $PSScriptRoot 'session-relay.mjs' }
    default { throw "Unsupported bridge mode: $mode" }
}
$expectedBridge = [System.IO.Path]::GetFullPath($bridge)

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$appServerInfo = $null
if ($mode -eq 'session-relay') {
    & $desktopRelayPointerScript -Url ([string]$config.sessionRelay.appServerUrl) -Disable | Out-Null
    $appServerInfo = & (Join-Path $PSScriptRoot 'start-app-server.ps1') -PassThru
    if (-not $appServerInfo -or -not $appServerInfo.ProcessId) {
        throw 'The shared Codex App Server startup returned no verified process.'
    }
}

if (Test-Path -LiteralPath $pidPath) {
    $existingPid = [int](Get-Content -Raw -LiteralPath $pidPath)
    $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
    $isBridge = $existingProcess -and
        $existingProcess.Name -eq 'node.exe' -and
        [string]$existingProcess.CommandLine -like "*$expectedBridge*"
    if ($isBridge) {
        if ($mode -eq 'session-relay') {
            & $desktopRelayPointerScript -Url ([string]$config.sessionRelay.appServerUrl) | Out-Null
        }
        Write-Output "Bridge is already running (PID $existingPid)."
        exit 0
    }
    # A PID can be reused after Windows restarts. Never treat an unrelated
    # process as the bridge and never terminate it during stale-file cleanup.
    Remove-Item -LiteralPath $pidPath -Force
}

if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw "Encrypted Channel SDK secret not found. Run setup-channel-secret.ps1 first."
}

$supervisorProcess = $null
if (Test-Path -LiteralPath $supervisorPidPath -PathType Leaf) {
    $savedSupervisorPid = [int](Get-Content -Raw -LiteralPath $supervisorPidPath)
    $supervisorProcess = Get-Process -Id $savedSupervisorPid -ErrorAction SilentlyContinue
    if (-not $supervisorProcess) {
        Remove-Item -LiteralPath $supervisorPidPath -Force
    }
}
if (-not $supervisorProcess) {
    Remove-Item -LiteralPath $restartPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $supervisorStopPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $supervisorStdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $supervisorStderrPath -Force -ErrorAction SilentlyContinue
    $supervisorProcess = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisorScript`"") `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $supervisorStdoutPath `
        -RedirectStandardError $supervisorStderrPath `
        -PassThru
    [System.IO.File]::WriteAllText($supervisorPidPath, [string]$supervisorProcess.Id)
}

$deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    $supervisorProcess.Refresh()
    if ($supervisorProcess.HasExited) {
        throw "Bridge supervisor exited during startup. Check $supervisorStderrPath"
    }
    $process = $null
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        $candidatePid = [int](Get-Content -Raw -LiteralPath $pidPath)
        $process = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
    }
    if ($process -and (Test-Path -LiteralPath $stdoutPath) -and
        (Select-String -LiteralPath $stdoutPath -Pattern 'READY: Channel SDK connected' -Quiet)) {
        if ($mode -eq 'session-relay') {
            & $desktopRelayPointerScript -Url ([string]$config.sessionRelay.appServerUrl) | Out-Null
        }
        $appServerSuffix = if ($mode -eq 'session-relay') { "; shared App Server PID=$($appServerInfo.ProcessId)" } else { '' }
        Write-Output "Bridge is connected (PID $($process.Id), supervisor PID=$($supervisorProcess.Id), mode $mode$appServerSuffix)."
        exit 0
    }
    Start-Sleep -Milliseconds 250
}

throw "Bridge did not become ready within $ReadyTimeoutSeconds seconds. Check $stderrPath and $stdoutPath"
