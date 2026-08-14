param(
    [switch]$Disable,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$variableName = 'CODEX_APP_SERVER_WS_URL'
$taskName = 'FeishuCodexBridge-DesktopRelay'
$bootstrapRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap'
$stableBootstrapPath = Join-Path $bootstrapRoot 'desktop-relay-bootstrap.ps1'
$bootstrapSourcePath = Join-Path $PSScriptRoot 'desktop-relay-bootstrap.ps1'
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

function Get-RelayUrl {
    param([switch]$Optional)
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        if ($Optional) { return $null }
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

function Test-OwnedRelayUrl {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    try {
        $uri = [Uri]$Value
        return $uri.Scheme -eq 'ws' -and
            $uri.Host -in @('127.0.0.1', 'localhost', '::1') -and
            $uri.Port -gt 0 -and
            $uri.AbsolutePath -eq '/rpc'
    } catch {
        return $false
    }
}

function Get-RelayTask {
    if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { return $null }
    return Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
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

if ($Disable) {
    $expectedUrl = Get-RelayUrl -Optional
    $current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if ($current -and -not $Force) {
        if ($expectedUrl) {
            if ($current -ne $expectedUrl.AbsoluteUri) {
                throw "$variableName contains a different value; refusing to remove configuration owned by another setup."
            }
        } elseif (-not (Test-OwnedRelayUrl -Value $current)) {
            throw "$variableName is not an owned loopback relay URL; refusing to remove it."
        }
    }

    $task = Get-RelayTask
    if ($task -and -not (Test-RelayTaskOwnership -Task $task) -and -not $Force) {
        throw "$taskName belongs to a different action; refusing to remove it."
    }

    # Remove the Desktop dependency before touching the startup task. If task
    # cleanup fails, Codex Desktop still falls back to its own App Server.
    [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
    Send-EnvironmentChanged
    if ($task -and ((Test-RelayTaskOwnership -Task $task) -or $Force)) {
        try {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
        } catch {
            Write-Warning "The Desktop relay pointer was removed, but the harmless startup task could not be removed: $($_.Exception.Message)"
        }
    }
    Write-Output 'Codex Desktop shared App Server configuration removed. Fully exit and reopen Codex Desktop.'
    exit 0
}

$url = Get-RelayUrl
$current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
if ($current -and $current -ne $url.AbsoluteUri -and -not $Force) {
    throw "$variableName already contains a different value; refusing to overwrite another setup."
}

# The Desktop pointer is deliberately written last. A failed App Server start
# or failed logon-task registration must leave normal Codex Desktop startup
# untouched.
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
    'Get-ScheduledTask'
)
foreach ($commandName in $requiredTaskCommands) {
    if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        throw "Windows Task Scheduler command $commandName is unavailable; the Desktop relay pointer was not enabled."
    }
}

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
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
$taskDefinition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Starts the shared Codex App Server before restoring the Feishu Codex Bridge.'
Register-ScheduledTask -TaskName $taskName -InputObject $taskDefinition -Force | Out-Null

$registeredTask = Get-RelayTask
if (-not $registeredTask -or
    -not (Test-RelayTaskOwnership -Task $registeredTask) -or
    [string]$registeredTask.State -eq 'Disabled') {
    throw 'The Desktop relay logon task could not be verified; the Desktop relay pointer was not enabled.'
}

[Environment]::SetEnvironmentVariable($variableName, $url.AbsoluteUri, [EnvironmentVariableTarget]::User)
Send-EnvironmentChanged
$activationCompleted = $true
Write-Output "Codex Desktop relay is fail-open and ready: App Server PID $($appServerInfo.ProcessId), logon recovery task installed."
Write-Output 'Fully exit and reopen Codex Desktop once to use the shared App Server.'
} catch {
    $activationError = $_
    $pointerAfterFailure = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if (-not $activationCompleted -and $pointerAfterFailure -eq $url.AbsoluteUri) {
        [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
        try { Send-EnvironmentChanged } catch { }
        Write-Warning 'Desktop relay activation failed, so the existing Bridge-owned pointer was removed to keep Codex Desktop fail-open.'
    }
    throw $activationError
}
