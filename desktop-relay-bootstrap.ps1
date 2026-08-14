$ErrorActionPreference = 'Stop'

$logRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap'
$logPath = Join-Path $logRoot 'bootstrap.log'
$statePath = Join-Path $logRoot 'desktop-relay-state.json'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Write-BootstrapLog {
    param([Parameter(Mandatory)][string]$Message)
    $timestamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff zzz')
    Add-Content -LiteralPath $logPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Send-EnvironmentChanged {
    try {
        if (-not ('FeishuCodexBridge.BootstrapNativeMethods' -as [type])) {
            Add-Type -TypeDefinition @'
namespace FeishuCodexBridge {
    using System;
    using System.Runtime.InteropServices;
    public static class BootstrapNativeMethods {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
            uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
    }
}
'@
        }
        $broadcastResult = [UIntPtr]::Zero
        [void][FeishuCodexBridge.BootstrapNativeMethods]::SendMessageTimeout(
            [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$broadcastResult)
    } catch {
        Write-BootstrapLog -Message 'Could not broadcast the fail-open environment change.'
    }
}

function Disable-OwnedDesktopRelayPointer {
    $variableName = 'CODEX_APP_SERVER_WS_URL'
    $current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if ([string]::IsNullOrWhiteSpace($current)) { return }

    $expectedUrl = $null
    try {
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            $relayState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
            $expectedUrl = [string]$relayState.expectedUrl
        }
    } catch {
        $expectedUrl = $null
    }
    if ([string]::IsNullOrWhiteSpace($expectedUrl)) {
        try {
            $configuredHome = [Environment]::GetEnvironmentVariable(
                'FEISHU_CODEX_BRIDGE_HOME', [EnvironmentVariableTarget]::User)
            if (-not [string]::IsNullOrWhiteSpace($configuredHome)) {
                $configPath = Join-Path ([IO.Path]::GetFullPath($configuredHome)) 'bridge.config.json'
                if (Test-Path -LiteralPath $configPath -PathType Leaf) {
                    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
                    $expectedUrl = [string]$config.sessionRelay.appServerUrl
                }
            }
        } catch {
            $expectedUrl = $null
        }
    }
    if ([string]::IsNullOrWhiteSpace($expectedUrl) -or $current -ne $expectedUrl) {
        Write-BootstrapLog -Message 'Bootstrap could not prove ownership of the configured Desktop relay pointer; it was left unchanged.'
        return
    }
    [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
    Send-EnvironmentChanged
    Write-BootstrapLog -Message 'Removed the unavailable owned Desktop relay pointer so Codex Desktop can fail open.'
}

$bridgeHome = [Environment]::GetEnvironmentVariable('FEISHU_CODEX_BRIDGE_HOME', [EnvironmentVariableTarget]::User)
if ([string]::IsNullOrWhiteSpace($bridgeHome)) {
    Write-BootstrapLog -Message 'Bridge installation pointer is missing.'
    Disable-OwnedDesktopRelayPointer
    exit 0
}

try {
    $bridgeHome = [IO.Path]::GetFullPath($bridgeHome)
} catch {
    Write-BootstrapLog -Message 'Bridge installation pointer is invalid.'
    Disable-OwnedDesktopRelayPointer
    exit 0
}

$startupScript = Join-Path $bridgeHome 'start-at-login.ps1'
if (-not (Test-Path -LiteralPath $startupScript -PathType Leaf)) {
    Write-BootstrapLog -Message 'The installed release has no login startup script.'
    Disable-OwnedDesktopRelayPointer
    exit 0
}

try {
    & $startupScript
    $startupExitCode = $LASTEXITCODE
    if ($startupExitCode -ne 0) {
        Write-BootstrapLog -Message "The continuous Desktop relay watchdog exited with code $startupExitCode."
        Disable-OwnedDesktopRelayPointer
    }
    exit $startupExitCode
} catch {
    Write-BootstrapLog -Message ("The continuous Desktop relay watchdog failed: " + $_.Exception.Message)
    Disable-OwnedDesktopRelayPointer
    exit 1
}
