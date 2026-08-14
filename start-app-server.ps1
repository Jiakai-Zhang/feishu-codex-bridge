param(
    [switch]$PassThru
)

$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json not found.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if ([string]$config.mode -ne 'session-relay') {
    throw 'The shared Codex App Server is only available in session-relay mode.'
}

$projectRoot = [IO.Path]::GetFullPath([string]$config.workspace)
$runtimeDir = Join-Path $projectRoot 'work\feishu-codex-bridge'
$appServerPidPath = Join-Path $runtimeDir 'codex-app-server.pid'
$appServerStdoutPath = Join-Path $runtimeDir 'codex-app-server.stdout.log'
$appServerStderrPath = Join-Path $runtimeDir 'codex-app-server.stderr.log'
$codexExecutable = [IO.Path]::GetFullPath([string]$config.codexExecutable)
$appServerUrlText = [string]$config.sessionRelay.appServerUrl

if (-not (Test-Path -LiteralPath $codexExecutable -PathType Leaf)) {
    throw 'The configured Codex executable does not exist.'
}
if ([string]::IsNullOrWhiteSpace($appServerUrlText)) {
    throw 'sessionRelay.appServerUrl is required.'
}
$appServerUri = [Uri]$appServerUrlText
if ($appServerUri.Scheme -ne 'ws' -or
    $appServerUri.Host -notin @('127.0.0.1', 'localhost', '::1') -or
    $appServerUri.Port -le 0 -or
    $appServerUri.AbsolutePath -ne '/rpc') {
    throw 'sessionRelay.appServerUrl must be a ws:// loopback URL ending in /rpc.'
}

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
    $actualPath = if ($candidate.ExecutablePath) {
        [IO.Path]::GetFullPath([string]$candidate.ExecutablePath)
    } else {
        ''
    }
    if ($actualPath -ine $expectedPath) { return $null }
    $commandLine = [string]$candidate.CommandLine
    if ($commandLine -notmatch '(?i)\bapp-server\b' -or
        $commandLine -notmatch [regex]::Escape(":$Port")) {
        return $null
    }
    return Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
}

function Find-VerifiedAppServerProcess {
    param([string]$Executable, [int]$Port)
    $leafName = [IO.Path]::GetFileName($Executable).Replace("'", "''")
    $candidates = Get-CimInstance Win32_Process -Filter "Name = '$leafName'" -ErrorAction SilentlyContinue
    foreach ($candidate in $candidates) {
        $verified = Get-VerifiedAppServerProcess -ProcessId ([int]$candidate.ProcessId) `
            -Executable $Executable -Port $Port
        if ($verified) { return $verified }
    }
    return $null
}

$mutex = [Threading.Mutex]::new($false, "Local\FeishuCodexBridgeAppServer-$($appServerUri.Port)")
$lockTaken = $false
try {
    try {
        $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(30))
    } catch [Threading.AbandonedMutexException] {
        $lockTaken = $true
    }
    if (-not $lockTaken) {
        throw 'Timed out waiting for another shared App Server startup attempt.'
    }

    $appServerProcess = $null
    $savedAppServerPid = 0
    if (Test-Path -LiteralPath $appServerPidPath -PathType Leaf) {
        $pidText = (Get-Content -Raw -LiteralPath $appServerPidPath).Trim()
        if ([int]::TryParse($pidText, [ref]$savedAppServerPid)) {
            $appServerProcess = Get-VerifiedAppServerProcess -ProcessId $savedAppServerPid `
                -Executable $codexExecutable -Port $appServerUri.Port
        }
        if (-not $appServerProcess) {
            Remove-Item -LiteralPath $appServerPidPath -Force
        }
    }

    if (-not $appServerProcess) {
        $appServerProcess = Find-VerifiedAppServerProcess -Executable $codexExecutable -Port $appServerUri.Port
    }

    $started = $false
    if (-not $appServerProcess) {
        if (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port) {
            throw "Port $($appServerUri.Port) is already in use by an unverified process; refusing to start the shared Codex App Server."
        }
        $listenHost = if ($appServerUri.Host -eq '::1') { '[::1]' } else { $appServerUri.Host }
        $listenUrl = "ws://${listenHost}:$($appServerUri.Port)"
        $appServerProcess = Start-Process -FilePath $codexExecutable `
            -ArgumentList @('app-server', '--listen', $listenUrl) `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $appServerStdoutPath `
            -RedirectStandardError $appServerStderrPath `
            -PassThru
        $started = $true
    }

    $appServerDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $appServerDeadline) {
        $appServerProcess.Refresh()
        if ($appServerProcess.HasExited) {
            Remove-Item -LiteralPath $appServerPidPath -Force -ErrorAction SilentlyContinue
            throw "Shared Codex App Server exited during startup. Check $appServerStderrPath"
        }
        if (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port)) {
        throw "Shared Codex App Server did not listen within 15 seconds. Check $appServerStderrPath"
    }

    [IO.File]::WriteAllText($appServerPidPath, [string]$appServerProcess.Id)
    if ($PassThru) {
        [pscustomobject]@{
            ProcessId = [int]$appServerProcess.Id
            AppServerUrl = $appServerUri.AbsoluteUri
            Started = $started
        }
    } else {
        $verb = if ($started) { 'started' } else { 'is already running' }
        Write-Output "Shared Codex App Server $verb (PID $($appServerProcess.Id))."
    }
} finally {
    if ($lockTaken) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
