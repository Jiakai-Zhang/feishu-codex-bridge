$ErrorActionPreference = 'Stop'

$logRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap'
$logPath = Join-Path $logRoot 'startup.log'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Write-StartupLog {
    param([Parameter(Mandatory)][string]$Message)
    $timestamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff zzz')
    Add-Content -LiteralPath $logPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Send-EnvironmentChanged {
    try {
        if (-not ('FeishuCodexBridge.StartupNativeMethods' -as [type])) {
            Add-Type -TypeDefinition @'
namespace FeishuCodexBridge {
    using System;
    using System.Runtime.InteropServices;
    public static class StartupNativeMethods {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
            uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
    }
}
'@
        }
        $broadcastResult = [UIntPtr]::Zero
        [void][FeishuCodexBridge.StartupNativeMethods]::SendMessageTimeout(
            [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$broadcastResult)
    } catch {
        Write-StartupLog -Message 'Could not broadcast the fail-open environment change.'
    }
}

function Disable-DesktopRelayPointer {
    $variableName = 'CODEX_APP_SERVER_WS_URL'
    $current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if ([string]::IsNullOrWhiteSpace($current)) { return }
    $owned = $false
    try {
        $uri = [Uri]$current
        $owned = $uri.Scheme -eq 'ws' -and
            $uri.Host -in @('127.0.0.1', 'localhost', '::1') -and
            $uri.Port -gt 0 -and
            $uri.AbsolutePath -eq '/rpc'
    } catch {
        $owned = $false
    }
    if (-not $owned) {
        Write-StartupLog -Message 'Startup failed, but the Desktop relay pointer is not an owned loopback URL; it was left unchanged.'
        return
    }
    [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
    Send-EnvironmentChanged
    Write-StartupLog -Message 'Shared App Server startup failed; removed the Desktop relay pointer so Codex Desktop can fail open.'
}

Write-StartupLog -Message 'Login startup began.'
try {
    $appServerInfo = & (Join-Path $PSScriptRoot 'start-app-server.ps1') -PassThru
    if (-not $appServerInfo -or -not $appServerInfo.ProcessId) {
        throw 'The shared App Server startup returned no verified process.'
    }
    Write-StartupLog -Message "Shared App Server is ready (PID $($appServerInfo.ProcessId))."
} catch {
    Write-StartupLog -Message ("Shared App Server startup failed: " + $_.Exception.Message)
    Disable-DesktopRelayPointer
    exit 1
}

try {
    $config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
    $runtimeDir = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
    $secretPath = Join-Path $runtimeDir 'channel-secret.dpapi'
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
        Write-StartupLog -Message 'Encrypted App Secret is not present; kept the App Server ready and skipped Bridge startup.'
        exit 0
    }
    & (Join-Path $PSScriptRoot 'start-bridge.ps1') | ForEach-Object {
        Write-StartupLog -Message ([string]$_)
    }
    Write-StartupLog -Message 'Login startup completed.'
    exit 0
} catch {
    Write-StartupLog -Message ("Bridge startup failed while the App Server remained available: " + $_.Exception.Message)
    exit 1
}
