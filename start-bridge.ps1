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
$appServerPidPath = Join-Path $runtimeDir 'codex-app-server.pid'
$appServerStdoutPath = Join-Path $runtimeDir 'codex-app-server.stdout.log'
$appServerStderrPath = Join-Path $runtimeDir 'codex-app-server.stderr.log'
$node = [string]$config.nodeExecutable
$mode = if ([string]::IsNullOrWhiteSpace([string]$config.mode)) { 'project-agent' } else { [string]$config.mode }
switch ($mode) {
    'project-agent' { $bridge = Join-Path $PSScriptRoot 'channel-bridge.mjs' }
    'session-relay' { $bridge = Join-Path $PSScriptRoot 'session-relay.mjs' }
    default { throw "Unsupported bridge mode: $mode" }
}
$expectedBridge = [System.IO.Path]::GetFullPath($bridge)

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Test-LoopbackPort {
    param([string]$HostName, [int]$Port)
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        if (-not $task.Wait(250)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-VerifiedAppServerProcess {
    param([int]$ProcessId, [string]$Executable, [int]$Port)
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $candidate) { return $null }
    $expectedPath = [IO.Path]::GetFullPath($Executable)
    $actualPath = if ($candidate.ExecutablePath) { [IO.Path]::GetFullPath([string]$candidate.ExecutablePath) } else { '' }
    if ($actualPath -ine $expectedPath) { return $null }
    $commandLine = [string]$candidate.CommandLine
    if ($commandLine -notmatch '(?i)\bapp-server\b' -or $commandLine -notmatch [regex]::Escape(":$Port")) {
        return $null
    }
    return Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
}

if ($mode -eq 'session-relay') {
    $appServerUrlText = [string]$config.sessionRelay.appServerUrl
    if ([string]::IsNullOrWhiteSpace($appServerUrlText)) {
        throw 'sessionRelay.appServerUrl is required so Codex Desktop and Session Relay share one App Server writer.'
    }
    $appServerUri = [Uri]$appServerUrlText
    if ($appServerUri.Scheme -ne 'ws' -or $appServerUri.Host -notin @('127.0.0.1', 'localhost', '::1') -or $appServerUri.Port -le 0) {
        throw 'sessionRelay.appServerUrl must be a ws:// loopback URL with an explicit port.'
    }
    $appServerProcess = $null
    if (Test-Path -LiteralPath $appServerPidPath -PathType Leaf) {
        $savedAppServerPid = [int](Get-Content -Raw -LiteralPath $appServerPidPath)
        $appServerProcess = Get-VerifiedAppServerProcess -ProcessId $savedAppServerPid `
            -Executable ([string]$config.codexExecutable) -Port $appServerUri.Port
        if (-not $appServerProcess) {
            Remove-Item -LiteralPath $appServerPidPath -Force
        }
    }
    if (-not $appServerProcess) {
        if (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port) {
            throw "Port $($appServerUri.Port) is already in use by an unverified process; refusing to start the shared Codex App Server."
        }
        $listenHost = if ($appServerUri.Host -eq '::1') { '[::1]' } else { $appServerUri.Host }
        $listenUrl = "ws://${listenHost}:$($appServerUri.Port)"
        $appServerProcess = Start-Process -FilePath ([string]$config.codexExecutable) `
            -ArgumentList @('app-server', '--listen', $listenUrl) `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $appServerStdoutPath `
            -RedirectStandardError $appServerStderrPath `
            -PassThru
        [IO.File]::WriteAllText($appServerPidPath, [string]$appServerProcess.Id)
    }
    $appServerDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $appServerDeadline) {
        if ($appServerProcess.HasExited) {
            throw "Shared Codex App Server exited during startup. Check $appServerStderrPath"
        }
        if (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port) { break }
        Start-Sleep -Milliseconds 200
        $appServerProcess.Refresh()
    }
    if (-not (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port)) {
        throw "Shared Codex App Server did not listen within 15 seconds. Check $appServerStderrPath"
    }
}

if (Test-Path -LiteralPath $pidPath) {
    $existingPid = [int](Get-Content -Raw -LiteralPath $pidPath)
    $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
    $isBridge = $existingProcess -and
        $existingProcess.Name -eq 'node.exe' -and
        [string]$existingProcess.CommandLine -like "*$expectedBridge*"
    if ($isBridge) {
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

$deadline = [DateTime]::UtcNow.AddSeconds(25)
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
        $appServerSuffix = if ($mode -eq 'session-relay') { "; shared App Server PID=$($appServerProcess.Id)" } else { '' }
        Write-Output "Bridge is connected (PID $($process.Id), supervisor PID=$($supervisorProcess.Id), mode $mode$appServerSuffix)."
        exit 0
    }
    Start-Sleep -Milliseconds 250
}

throw "Bridge did not become ready within 25 seconds. Check $stderrPath and $stdoutPath"
