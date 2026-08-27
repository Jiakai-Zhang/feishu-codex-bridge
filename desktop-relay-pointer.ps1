param(
    [Parameter(Mandatory)]
    [string]$Url,
    [switch]$Disable,
    [switch]$Preparing
)

$ErrorActionPreference = 'Stop'
if ($Disable -and $Preparing) {
    throw '-Disable and -Preparing cannot be combined.'
}
$variableName = 'CODEX_APP_SERVER_WS_URL'
$taskName = 'FeishuCodexBridge-DesktopRelay-Watchdog'
$bootstrapRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap'
$stableBootstrapPath = Join-Path $bootstrapRoot 'desktop-relay-bootstrap.ps1'
$statePath = Join-Path $bootstrapRoot 'desktop-relay-state.json'
$relayUrl = [Uri]$Url
if ($relayUrl.Scheme -ne 'ws' -or
    $relayUrl.Host -notin @('127.0.0.1', 'localhost', '::1') -or
    $relayUrl.Port -le 0 -or
    $relayUrl.AbsolutePath -ne '/rpc') {
    throw 'The Desktop relay pointer must be a ws:// loopback URL ending in /rpc.'
}

function Send-EnvironmentChanged {
    if (-not ('FeishuCodexBridge.PointerNativeMethods' -as [type])) {
        Add-Type -TypeDefinition @'
namespace FeishuCodexBridge {
    using System;
    using System.Runtime.InteropServices;
    public static class PointerNativeMethods {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
            uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
    }
}
'@
    }
    $broadcastResult = [UIntPtr]::Zero
    [void][FeishuCodexBridge.PointerNativeMethods]::SendMessageTimeout(
        [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$broadcastResult)
}

function Read-OwnedRelayState {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
    try {
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if (-not [bool]$state.enabled -or [string]$state.expectedUrl -ne $relayUrl.AbsoluteUri) {
            return $null
        }
        return $state
    } catch {
        return $null
    }
}

function Write-BridgeState {
    param(
        [Parameter(Mandatory)][object]$State,
        [Parameter(Mandatory)][bool]$BridgeEnabled
    )
    $State | Add-Member -NotePropertyName bridgeEnabled -NotePropertyValue $BridgeEnabled -Force
    $temporaryPath = "$statePath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText(
            $temporaryPath,
            (($State | ConvertTo-Json -Depth 6) + "`n"),
            [Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

$expected = $relayUrl.AbsoluteUri
$current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
$relayState = Read-OwnedRelayState
if ($Preparing) {
    if ($relayState) { Write-BridgeState -State $relayState -BridgeEnabled $true }
    if ($current -eq $expected) {
        [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
        Send-EnvironmentChanged
    } elseif (-not [string]::IsNullOrWhiteSpace($current)) {
        Write-Warning 'The Desktop relay pointer belongs to another configuration and was left unchanged.'
    }
    Write-Output 'Codex Desktop relay pointer paused while Bridge recovery remains enabled.'
    exit 0
}
if ($Disable) {
    if ($relayState) { Write-BridgeState -State $relayState -BridgeEnabled $false }
    if ($current -eq $expected) {
        [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
        Send-EnvironmentChanged
    } elseif (-not [string]::IsNullOrWhiteSpace($current)) {
        Write-Warning 'The Desktop relay pointer belongs to another configuration and was left unchanged.'
    }
    Write-Output 'Codex Desktop relay pointer disabled for the stopped Bridge.'
    exit 0
}

$relayTask = if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
} else { $null }
$recoveryReady = $relayTask -and
    [string]$relayTask.State -ne 'Disabled' -and
    @($relayTask.Actions | Where-Object {
        ([string]$_.Arguments).IndexOf($stableBootstrapPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }).Count -gt 0
if (-not $relayState -or -not $recoveryReady) {
    Write-Output 'Desktop relay recovery is not configured; the pointer remains disabled.'
    exit 0
}
if (-not [string]::IsNullOrWhiteSpace($current) -and $current -ne $expected) {
    throw 'A different Desktop relay pointer is already configured; refusing to overwrite it.'
}

Write-BridgeState -State $relayState -BridgeEnabled $true
if ($current -ne $expected) {
    [Environment]::SetEnvironmentVariable($variableName, $expected, [EnvironmentVariableTarget]::User)
    Send-EnvironmentChanged
}
Write-Output 'Codex Desktop relay pointer enabled for the running Bridge.'
