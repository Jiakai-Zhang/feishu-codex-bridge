param(
    [switch]$Disable,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$variableName = 'CODEX_APP_SERVER_WS_URL'
$taskName = 'FeishuCodexBridge-DesktopRelay-Watchdog'
$legacyTaskName = 'FeishuCodexBridge-DesktopRelay'
$bootstrapRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap'
$stableBootstrapPath = Join-Path $bootstrapRoot 'desktop-relay-bootstrap.ps1'
$bootstrapSourcePath = Join-Path $PSScriptRoot 'desktop-relay-bootstrap.ps1'
$statePath = Join-Path $bootstrapRoot 'desktop-relay-state.json'
$statusPath = Join-Path $bootstrapRoot 'desktop-relay-watchdog-status.json'
$configPath = Join-Path $PSScriptRoot 'bridge.config.json'

function Send-EnvironmentChanged {
    if (-not ('SessionRelay.NativeMethods' -as [type])) {
        Add-Type -TypeDefinition @'
namespace SessionRelay {
    using System;
    using System.Runtime.InteropServices;
    public static class NativeMethods {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
            uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
    }
}
'@
    }
    $broadcastResult = [UIntPtr]::Zero
    [void][SessionRelay.NativeMethods]::SendMessageTimeout(
        [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$broadcastResult)
}

function Read-RelayState {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
    try {
        return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-RelayUrl {
    param([switch]$Optional)
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        if ($Optional) {
            $relayState = Read-RelayState
            if ($relayState -and -not [string]::IsNullOrWhiteSpace([string]$relayState.expectedUrl)) {
                try { return [Uri]([string]$relayState.expectedUrl) } catch { return $null }
            }
            return $null
        }
        throw 'bridge.config.json not found.'
    }
    try {
        $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
        $urlText = [string]$config.sessionRelay.appServerUrl
        if ([string]::IsNullOrWhiteSpace($urlText)) {
            throw 'sessionRelay.appServerUrl is missing.'
        }
        $url = [Uri]$urlText
        if ($url.Scheme -ne 'ws' -or
            $url.Host -notin @('127.0.0.1', 'localhost', '::1') -or
            $url.Port -le 0 -or
            $url.AbsolutePath -ne '/rpc') {
            throw 'sessionRelay.appServerUrl must be a ws:// loopback URL ending in /rpc.'
        }
        return $url
    } catch {
        if ($Optional) { return $null }
        throw
    }
}

function Get-RelayTask {
    param([Parameter(Mandatory)][string]$Name)
    if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { return $null }
    return Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
}

function Test-RelayTaskOwnership {
    param($Task)
    if (-not $Task) { return $false }
    foreach ($action in @($Task.Actions)) {
        $arguments = [string]$action.Arguments
        if ($arguments.IndexOf($stableBootstrapPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Get-PotentialExternalGuardianKinds {
    param(
        [Parameter(Mandatory)][Uri]$RelayUrl,
        [Parameter(Mandatory)][string]$CodexExecutable
    )
    $kinds = @{}
    $portText = [regex]::Escape([string]$RelayUrl.Port)
    $guardianPattern = "(?i)(start-app-server\.ps1|codex[^\r\n]*app-server|desktop[-_ ]?relay|watchdog|guardian|:$portText(?:\D|$))"

    try {
        foreach ($task in @(Get-ScheduledTask -ErrorAction Stop)) {
            if ([string]$task.TaskName -in @($taskName, $legacyTaskName) -and
                (Test-RelayTaskOwnership -Task $task)) {
                continue
            }
            $text = ((@($task.TaskName, $task.Description) + @($task.Actions | ForEach-Object {
                "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)"
            })) -join ' ')
            if ($text -match $guardianPattern) {
                $kinds['scheduled task'] = $true
            }
        }
    } catch { }

    try {
        foreach ($service in @(Get-CimInstance Win32_Service -ErrorAction Stop)) {
            $text = "$($service.Name) $($service.DisplayName) $($service.PathName)"
            if ($text -match $guardianPattern) {
                $kinds['Windows service'] = $true
            }
        }
    } catch { }

    try {
        $expectedCodexLeaf = [IO.Path]::GetFileName($CodexExecutable)
        $scriptLauncherNames = @(
            'powershell.exe', 'pwsh.exe', 'cmd.exe', 'wscript.exe',
            'cscript.exe', 'python.exe', 'pythonw.exe', 'node.exe'
        )
        $strongGuardianPattern = '(?i)(start-app-server\.ps1|desktop[-_ ]?relay|watchdog|guardian)'
        foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
            if ([int]$process.ProcessId -eq $PID -or [string]$process.Name -ieq $expectedCodexLeaf) { continue }
            $commandLine = [string]$process.CommandLine
            if ($commandLine -and
                $commandLine.IndexOf($stableBootstrapPath, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and
                ($commandLine -match $strongGuardianPattern -or
                    ([string]$process.Name -in $scriptLauncherNames -and $commandLine -match $guardianPattern))) {
                $kinds['running process'] = $true
            }
        }
    } catch { }

    return @($kinds.Keys | Sort-Object)
}

function Write-RelayState {
    param(
        [Parameter(Mandatory)][Uri]$RelayUrl,
        [Parameter(Mandatory)][string]$ActivationId,
        [AllowNull()]
        [AllowEmptyCollection()]
        [string[]]$ExternalGuardianKinds = @()
    )
    $state = [ordered]@{
        schemaVersion = 1
        enabled = $true
        expectedUrl = $RelayUrl.AbsoluteUri
        activationId = $ActivationId
        configuredAt = [DateTime]::UtcNow.ToString('o')
        bridgeRecoveryAfter = [DateTime]::UtcNow.AddMinutes(2).ToString('o')
        externalGuardianKinds = @($ExternalGuardianKinds | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    }
    $temporaryStatePath = "$statePath.$PID.$ActivationId.tmp"
    try {
        [IO.File]::WriteAllText(
            $temporaryStatePath,
            (($state | ConvertTo-Json -Depth 4) + "`n"),
            [Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporaryStatePath -Destination $statePath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryStatePath -Force -ErrorAction SilentlyContinue
    }
}

function Remove-OwnedTask {
    param(
        [Parameter(Mandatory)][string]$Name,
        [switch]$AllowForeign
    )
    $task = Get-RelayTask -Name $Name
    if (-not $task) { return }
    $owned = Test-RelayTaskOwnership -Task $task
    if (-not $owned -and -not $Force) {
        if ($AllowForeign) { return }
        throw "$Name belongs to a different action; refusing to remove it."
    }
    try { Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue } catch { }
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction Stop
}

if ($Disable) {
    $expectedUrl = Get-RelayUrl -Optional
    $current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if ($current -and -not $Force) {
        if (-not $expectedUrl -or $current -ne $expectedUrl.AbsoluteUri) {
            throw "$variableName contains a different value; refusing to remove configuration owned by another setup."
        }
    }

    # Disarm the watchdog before removing the Desktop dependency so it cannot
    # race the disable operation and restore the pointer. Task cleanup follows
    # only after the fail-open pointer has been removed.
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    if (-not [string]::IsNullOrWhiteSpace($current) -and
        ($Force -or ($expectedUrl -and $current -eq $expectedUrl.AbsoluteUri))) {
        [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
        Send-EnvironmentChanged
    }
    Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue

    try {
        Remove-OwnedTask -Name $taskName
    } catch {
        Write-Warning "The Desktop relay pointer was removed, but the official watchdog task could not be removed: $($_.Exception.Message)"
    }
    try {
        # A same-name custom task is never removed unless -Force was explicit.
        Remove-OwnedTask -Name $legacyTaskName -AllowForeign
    } catch {
        Write-Warning "The Desktop relay pointer was removed, but the legacy Bridge-owned task could not be removed: $($_.Exception.Message)"
    }
    # Close the narrow race where a watchdog cycle had already read the old
    # state before it was disarmed.
    $pointerAfterCleanup = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if ($expectedUrl -and $pointerAfterCleanup -eq $expectedUrl.AbsoluteUri) {
        [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
        Send-EnvironmentChanged
    }
    Write-Output 'Codex Desktop shared App Server configuration and official watchdog removed. External guardians were left untouched. Fully exit and reopen Codex Desktop.'
    exit 0
}

$url = Get-RelayUrl
$current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
if ($current -and $current -ne $url.AbsoluteUri -and -not $Force) {
    throw "$variableName already contains a different value; refusing to overwrite another setup."
}

$activationId = [guid]::NewGuid().ToString('N')
$activationCompleted = $false
try {
    $appServerInfo = & (Join-Path $PSScriptRoot 'start-app-server.ps1') -PassThru
    if (-not $appServerInfo -or -not $appServerInfo.ProcessId) {
        throw 'The shared Codex App Server startup returned no verified process.'
    }

    if (-not (Test-Path -LiteralPath $bootstrapSourcePath -PathType Leaf)) {
        throw 'desktop-relay-bootstrap.ps1 is missing from this release.'
    }
    New-Item -ItemType Directory -Force -Path $bootstrapRoot | Out-Null
    Copy-Item -LiteralPath $bootstrapSourcePath -Destination $stableBootstrapPath -Force
    $tokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile(
        $stableBootstrapPath, [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count -gt 0) {
        throw 'The copied Desktop relay bootstrap script failed PowerShell syntax validation.'
    }

    $requiredTaskCommands = @(
        'New-ScheduledTaskAction',
        'New-ScheduledTaskTrigger',
        'New-ScheduledTaskPrincipal',
        'New-ScheduledTaskSettingsSet',
        'New-ScheduledTask',
        'Register-ScheduledTask',
        'Get-ScheduledTask',
        'Start-ScheduledTask',
        'Stop-ScheduledTask',
        'Unregister-ScheduledTask'
    )
    foreach ($commandName in $requiredTaskCommands) {
        if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
            throw "Windows Task Scheduler command $commandName is unavailable; the Desktop relay pointer was not enabled."
        }
    }

    $existingWatchdogTask = Get-RelayTask -Name $taskName
    if ($existingWatchdogTask -and -not (Test-RelayTaskOwnership -Task $existingWatchdogTask) -and -not $Force) {
        throw "$taskName already belongs to another action; the Desktop relay pointer was not enabled."
    }

    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $externalGuardianKinds = Get-PotentialExternalGuardianKinds -RelayUrl $url `
        -CodexExecutable ([string]$config.codexExecutable)
    Write-RelayState -RelayUrl $url -ActivationId $activationId `
        -ExternalGuardianKinds $externalGuardianKinds

    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
        throw 'Windows PowerShell was not found; the Desktop relay pointer was not enabled.'
    }
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $actionArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$stableBootstrapPath`""
    $action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $actionArguments -WorkingDirectory $bootstrapRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -Hidden `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 10 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    $taskDefinition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'Continuously guards the shared Codex App Server and fails Desktop open when recovery is unavailable.'
    Register-ScheduledTask -TaskName $taskName -InputObject $taskDefinition -Force | Out-Null

    $registeredTask = Get-RelayTask -Name $taskName
    if (-not $registeredTask -or
        -not (Test-RelayTaskOwnership -Task $registeredTask) -or
        [string]$registeredTask.State -eq 'Disabled') {
        throw 'The continuous Desktop relay watchdog task could not be verified; the Desktop relay pointer was not enabled.'
    }

    # The shared listener and watchdog definition are both verified before the
    # persistent Desktop dependency is introduced.
    [Environment]::SetEnvironmentVariable($variableName, $url.AbsoluteUri, [EnvironmentVariableTarget]::User)
    Send-EnvironmentChanged
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

    $watchdogDeadline = [DateTime]::UtcNow.AddSeconds(20)
    $watchdogReady = $false
    while ([DateTime]::UtcNow -lt $watchdogDeadline) {
        if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
            try {
                $watchdogStatus = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
                if ([string]$watchdogStatus.activationId -eq $activationId -and
                    [string]$watchdogStatus.state -eq 'ready') {
                    $watchdogReady = $true
                    break
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $watchdogReady) {
        throw 'The continuous Desktop relay watchdog did not publish a ready heartbeat within 20 seconds.'
    }

    $legacyTask = Get-RelayTask -Name $legacyTaskName
    if ($legacyTask -and (Test-RelayTaskOwnership -Task $legacyTask)) {
        try {
            Stop-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false -ErrorAction Stop
        } catch {
            Write-Warning 'The continuous watchdog is active, but the harmless legacy one-shot task could not be removed.'
        }
    }

    $activationCompleted = $true
    Write-Output "Codex Desktop relay is continuously guarded and ready: App Server PID $($appServerInfo.ProcessId), watchdog heartbeat verified."
    if (@($externalGuardianKinds).Count -gt 0) {
        Write-Warning ("Potential custom guardian detected ({0}). It was left untouched. The official watchdog reuses the verified listener; remove the custom guardian only after strict Doctor passes." -f ($externalGuardianKinds -join ', '))
    }
    Write-Output 'Fully exit and reopen Codex Desktop once if it has not previously loaded this relay pointer.'
} catch {
    $activationError = $_
    $stateAfterFailure = Read-RelayState
    if ($stateAfterFailure -and [string]$stateAfterFailure.activationId -eq $activationId) {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    }
    $pointerAfterFailure = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if (-not $activationCompleted -and $pointerAfterFailure -eq $url.AbsoluteUri) {
        [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
        try { Send-EnvironmentChanged } catch { }
        Write-Warning 'Desktop relay activation failed, so the Bridge-owned pointer was removed to keep Codex Desktop fail-open.'
    }
    $failedTask = Get-RelayTask -Name $taskName
    if ($failedTask -and (Test-RelayTaskOwnership -Task $failedTask)) {
        try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
        try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
    }
    throw $activationError
}
