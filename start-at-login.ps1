param(
    [ValidateRange(1, 60)]
    [int]$CheckIntervalSeconds = 3,
    [ValidateRange(10, 3600)]
    [int]$VerificationIntervalSeconds = 60,
    [ValidateRange(30, 3600)]
    [int]$BridgeRecoveryIntervalSeconds = 120
)

$ErrorActionPreference = 'Stop'

$bootstrapRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap'
$logPath = Join-Path $bootstrapRoot 'watchdog.log'
$statePath = Join-Path $bootstrapRoot 'desktop-relay-state.json'
$statusPath = Join-Path $bootstrapRoot 'desktop-relay-watchdog-status.json'
$variableName = 'CODEX_APP_SERVER_WS_URL'
New-Item -ItemType Directory -Force -Path $bootstrapRoot | Out-Null

function Write-WatchdogLog {
    param([Parameter(Mandatory)][string]$Message)
    try {
        if ((Test-Path -LiteralPath $logPath -PathType Leaf) -and
            (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
            $previousLogPath = "$logPath.1"
            Remove-Item -LiteralPath $previousLogPath -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $logPath -Destination $previousLogPath -Force
        }
        $timestamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff zzz')
        Add-Content -LiteralPath $logPath -Value "[$timestamp] $Message" -Encoding UTF8
    } catch {
        # Logging must never terminate the watchdog.
    }
}

function Read-RelayState {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
            if ($attempt -lt 3) { Start-Sleep -Milliseconds 50; continue }
            return $null
        }
        try {
            return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        } catch {
            if ($attempt -lt 3) { Start-Sleep -Milliseconds 50; continue }
            return $null
        }
    }
}

function Test-BridgeRelayEnabled {
    param([Parameter(Mandatory)][object]$RelayState)
    $property = $RelayState.PSObject.Properties['bridgeEnabled']
    if (-not $property) { return $true }
    return [bool]$property.Value
}

function Write-WatchdogStatus {
    param(
        [Parameter(Mandatory)][object]$RelayState,
        [Parameter(Mandatory)][string]$State,
        [Parameter(Mandatory)][string]$Detail,
        [int]$AppServerProcessId = 0
    )
    $status = [ordered]@{
        schemaVersion = 1
        activationId = [string]$RelayState.activationId
        state = $State
        detail = $Detail
        heartbeatAt = [DateTime]::UtcNow.ToString(
            "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
            [Globalization.CultureInfo]::InvariantCulture)
        watchdogProcessId = $PID
        appServerProcessId = $AppServerProcessId
    }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $temporaryPath = "$statusPath.$PID.$attempt.tmp"
        try {
            [IO.File]::WriteAllText(
                $temporaryPath,
                (($status | ConvertTo-Json -Depth 3) + "`n"),
                [Text.UTF8Encoding]::new($false)
            )
            Move-Item -LiteralPath $temporaryPath -Destination $statusPath -Force
            return
        } catch {
            if ($attempt -ge 3) { throw }
            Start-Sleep -Milliseconds 50
        } finally {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Send-EnvironmentChanged {
    try {
        if (-not ('FeishuCodexBridge.WatchdogNativeMethods' -as [type])) {
            Add-Type -TypeDefinition @'
namespace FeishuCodexBridge {
    using System;
    using System.Runtime.InteropServices;
    public static class WatchdogNativeMethods {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
            uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
    }
}
'@
        }
        $broadcastResult = [UIntPtr]::Zero
        [void][FeishuCodexBridge.WatchdogNativeMethods]::SendMessageTimeout(
            [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$broadcastResult)
    } catch {
        Write-WatchdogLog -Message 'Could not broadcast the Desktop relay environment change.'
    }
}

function Set-DesktopRelayPointer {
    param(
        [Parameter(Mandatory)][string]$ExpectedUrl,
        [Parameter(Mandatory)][bool]$Enabled
    )
    $current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if ($Enabled) {
        if (-not [string]::IsNullOrWhiteSpace($current) -and $current -ne $ExpectedUrl) {
            throw 'A different Codex Desktop relay pointer is configured; the watchdog will not overwrite it.'
        }
        if ($current -ne $ExpectedUrl) {
            [Environment]::SetEnvironmentVariable($variableName, $ExpectedUrl, [EnvironmentVariableTarget]::User)
            Send-EnvironmentChanged
            Write-WatchdogLog -Message 'Restored the Bridge-owned Desktop relay pointer after the App Server was verified.'
        }
        return
    }

    if ($current -eq $ExpectedUrl) {
        [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
        Send-EnvironmentChanged
        Write-WatchdogLog -Message 'Removed the Bridge-owned Desktop relay pointer before App Server recovery.'
    }
}

function Test-LoopbackPort {
    param([Parameter(Mandatory)][string]$HostName, [Parameter(Mandatory)][int]$Port)
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

function Test-SavedProcessIdentity {
    param(
        [Parameter(Mandatory)][string]$PidPath,
        [Parameter(Mandatory)][string]$ExpectedProcessName,
        [Parameter(Mandatory)][string]$ExpectedCommandPath
    )
    if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) { return $false }
    $savedProcessId = 0
    $pidText = (Get-Content -Raw -LiteralPath $PidPath).Trim()
    if (-not [int]::TryParse($pidText, [ref]$savedProcessId)) {
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
        return $false
    }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$savedProcessId" -ErrorAction SilentlyContinue
    $matches = $candidate -and
        [string]$candidate.Name -ieq $ExpectedProcessName -and
        ([string]$candidate.CommandLine).IndexOf($ExpectedCommandPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $matches) {
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    }
    return [bool]$matches
}

function Start-BridgeRecoveryIfNeeded {
    param([Parameter(Mandatory)][object]$Config)
    try {
        $notBeforeText = [string](Read-RelayState).bridgeRecoveryAfter
        if (-not [string]::IsNullOrWhiteSpace($notBeforeText)) {
            $notBefore = [DateTime]::Parse($notBeforeText).ToUniversalTime()
            if ([DateTime]::UtcNow -lt $notBefore) { return $false }
        }

        $runtimeDir = Join-Path ([string]$Config.workspace) 'work\feishu-codex-bridge'
        $secretPath = Join-Path $runtimeDir 'channel-secret.dpapi'
        if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) { return $true }

        $mode = if ([string]::IsNullOrWhiteSpace([string]$Config.mode)) { 'project-agent' } else { [string]$Config.mode }
        $bridgeScript = if ($mode -eq 'session-relay') { 'session-relay.mjs' } else { 'channel-bridge.mjs' }
        $expectedBridge = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $bridgeScript))
        $expectedSupervisor = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'bridge-supervisor.ps1'))
        if (Test-SavedProcessIdentity `
            -PidPath (Join-Path $runtimeDir 'bridge.pid') `
            -ExpectedProcessName 'node.exe' `
            -ExpectedCommandPath $expectedBridge) { return $true }
        if (Test-SavedProcessIdentity `
            -PidPath (Join-Path $runtimeDir 'bridge-supervisor.pid') `
            -ExpectedProcessName 'powershell.exe' `
            -ExpectedCommandPath $expectedSupervisor) { return $true }

        $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { return $true }
        $stdoutPath = Join-Path $bootstrapRoot 'bridge-recovery.stdout.log'
        $stderrPath = Join-Path $bootstrapRoot 'bridge-recovery.stderr.log'
        Start-Process -FilePath $windowsPowerShell `
            -ArgumentList @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-File', "`"$(Join-Path $PSScriptRoot 'start-bridge.ps1')`""
            ) `
            -WorkingDirectory $PSScriptRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath | Out-Null
        Write-WatchdogLog -Message 'Started asynchronous Bridge recovery after the shared App Server became ready.'
        return $true
    } catch {
        Write-WatchdogLog -Message ("Bridge recovery could not be started while the App Server watchdog stayed active: " + $_.Exception.Message)
        return $true
    }
}

$config = $null
$appServerUri = $null
$mutex = $null
$lockTaken = $false
try {
    $configPath = Join-Path $PSScriptRoot 'bridge.config.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'bridge.config.json is missing.'
    }
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    if ([string]$config.mode -ne 'session-relay') {
        throw 'The Desktop relay watchdog requires session-relay mode.'
    }
    $appServerUri = [Uri]([string]$config.sessionRelay.appServerUrl)
    if ($appServerUri.Scheme -ne 'ws' -or
        $appServerUri.Host -notin @('127.0.0.1', 'localhost', '::1') -or
        $appServerUri.Port -le 0 -or
        $appServerUri.AbsolutePath -ne '/rpc') {
        throw 'sessionRelay.appServerUrl must be a ws:// loopback URL ending in /rpc.'
    }

    $relayState = Read-RelayState
    if (-not $relayState -or -not [bool]$relayState.enabled -or
        [string]$relayState.expectedUrl -ne $appServerUri.AbsoluteUri) {
        Write-WatchdogLog -Message 'The Desktop relay activation state is absent, disabled, or belongs to another URL; watchdog startup was skipped.'
        exit 0
    }

    $mutex = [Threading.Mutex]::new($false, "Local\FeishuCodexBridgeDesktopRelayWatchdog-$($appServerUri.Port)")
    try {
        $lockTaken = $mutex.WaitOne([TimeSpan]::Zero)
    } catch [Threading.AbandonedMutexException] {
        $lockTaken = $true
    }
    if (-not $lockTaken) {
        Write-WatchdogLog -Message 'Another official Desktop relay watchdog already owns this relay; duplicate startup was ignored.'
        exit 0
    }

    Write-WatchdogLog -Message "Continuous Desktop relay watchdog started (PID $PID, interval ${CheckIntervalSeconds}s)."
    Write-WatchdogStatus -RelayState $relayState -State 'starting' -Detail 'validating the shared App Server'

    $lastVerificationAt = [DateTime]::MinValue
    $lastHealth = ''
    $lastAppServerProcessId = 0
    $lastBridgeRecoveryAttemptAt = [DateTime]::MinValue

    while ($true) {
        $relayState = Read-RelayState
        if (-not $relayState -or -not [bool]$relayState.enabled -or
            [string]$relayState.expectedUrl -ne $appServerUri.AbsoluteUri) {
            Write-WatchdogLog -Message 'Desktop relay activation was removed or changed; watchdog is stopping.'
            break
        }

        if (-not (Test-BridgeRelayEnabled -RelayState $relayState)) {
            Set-DesktopRelayPointer -ExpectedUrl $appServerUri.AbsoluteUri -Enabled $false
            Write-WatchdogStatus -RelayState $relayState -State 'paused' `
                -Detail 'Bridge is stopped; Desktop pointer and recovery are paused'
            if ($lastHealth -ne 'paused') {
                Write-WatchdogLog -Message 'Bridge was stopped intentionally; Desktop relay recovery is paused.'
            }
            $lastHealth = 'paused'
            $lastBridgeRecoveryAttemptAt = [DateTime]::MinValue
            Start-Sleep -Seconds $CheckIntervalSeconds
            continue
        }

        $portListening = Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port
        $verificationDue = ([DateTime]::UtcNow - $lastVerificationAt).TotalSeconds -ge $VerificationIntervalSeconds
        if (-not $portListening) {
            Set-DesktopRelayPointer -ExpectedUrl $appServerUri.AbsoluteUri -Enabled $false
            Write-WatchdogStatus -RelayState $relayState -State 'recovering' `
                -Detail 'listener unavailable; attempting verified restart'
            try {
                $appServerInfo = & (Join-Path $PSScriptRoot 'start-app-server.ps1') -PassThru
                if (-not $appServerInfo -or -not $appServerInfo.ProcessId) {
                    throw 'The shared App Server startup returned no verified process.'
                }
                $lastAppServerProcessId = [int]$appServerInfo.ProcessId
                $lastVerificationAt = [DateTime]::UtcNow
                Set-DesktopRelayPointer -ExpectedUrl $appServerUri.AbsoluteUri -Enabled $true
                if ($lastHealth -ne 'ready') {
                    Write-WatchdogLog -Message "Shared App Server recovered and verified (PID $lastAppServerProcessId)."
                }
                $lastHealth = 'ready'
            } catch {
                if ($lastHealth -ne 'degraded') {
                    Write-WatchdogLog -Message ("Shared App Server recovery failed; Desktop remains fail-open: " + $_.Exception.Message)
                }
                $lastHealth = 'degraded'
                Write-WatchdogStatus -RelayState $relayState -State 'degraded' `
                    -Detail 'listener unavailable; Desktop pointer is disabled'
                Start-Sleep -Seconds $CheckIntervalSeconds
                continue
            }
        } elseif ($verificationDue) {
            try {
                $appServerInfo = & (Join-Path $PSScriptRoot 'start-app-server.ps1') -PassThru
                if (-not $appServerInfo -or -not $appServerInfo.ProcessId) {
                    throw 'The listening App Server could not be verified.'
                }
                $lastAppServerProcessId = [int]$appServerInfo.ProcessId
                $lastVerificationAt = [DateTime]::UtcNow
                Set-DesktopRelayPointer -ExpectedUrl $appServerUri.AbsoluteUri -Enabled $true
                if ($lastHealth -ne 'ready') {
                    Write-WatchdogLog -Message "Shared App Server is healthy and verified (PID $lastAppServerProcessId)."
                }
                $lastHealth = 'ready'
            } catch {
                Set-DesktopRelayPointer -ExpectedUrl $appServerUri.AbsoluteUri -Enabled $false
                if ($lastHealth -ne 'degraded') {
                    Write-WatchdogLog -Message ("An unverified listener replaced the shared App Server; Desktop remains fail-open: " + $_.Exception.Message)
                }
                $lastHealth = 'degraded'
                Write-WatchdogStatus -RelayState $relayState -State 'degraded' `
                    -Detail 'listener ownership verification failed; Desktop pointer is disabled'
                Start-Sleep -Seconds $CheckIntervalSeconds
                continue
            }
        } else {
            Set-DesktopRelayPointer -ExpectedUrl $appServerUri.AbsoluteUri -Enabled $true
        }

        Write-WatchdogStatus -RelayState $relayState -State 'ready' `
            -Detail 'verified listener is available' -AppServerProcessId $lastAppServerProcessId
        $bridgeRecoveryDue = ([DateTime]::UtcNow - $lastBridgeRecoveryAttemptAt).TotalSeconds -ge `
            $BridgeRecoveryIntervalSeconds
        if ($bridgeRecoveryDue) {
            $bridgeRecoveryAttempted = [bool](Start-BridgeRecoveryIfNeeded -Config $config)
            if ($bridgeRecoveryAttempted) {
                $lastBridgeRecoveryAttemptAt = [DateTime]::UtcNow
            }
        }
        Start-Sleep -Seconds $CheckIntervalSeconds
    }

    exit 0
} catch {
    $failureMessage = $_.Exception.Message
    Write-WatchdogLog -Message ("Desktop relay watchdog failed: " + $failureMessage)
    try {
        $relayState = Read-RelayState
        if ($relayState -and -not [string]::IsNullOrWhiteSpace([string]$relayState.expectedUrl)) {
            Set-DesktopRelayPointer -ExpectedUrl ([string]$relayState.expectedUrl) -Enabled $false
            Write-WatchdogStatus -RelayState $relayState -State 'failed' -Detail 'watchdog failed; Desktop pointer is disabled'
        }
    } catch {
        Write-WatchdogLog -Message 'The watchdog also could not complete its fail-open pointer cleanup.'
    }
    exit 1
} finally {
    if ($lockTaken -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
