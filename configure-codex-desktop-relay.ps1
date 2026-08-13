param(
    [switch]$Disable,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json not found.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$urlText = [string]$config.sessionRelay.appServerUrl
if ([string]::IsNullOrWhiteSpace($urlText)) {
    throw 'sessionRelay.appServerUrl is missing.'
}
$url = [Uri]$urlText
if ($url.Scheme -ne 'ws' -or $url.Host -notin @('127.0.0.1', 'localhost', '::1') -or $url.Port -le 0 -or $url.AbsolutePath -ne '/rpc') {
    throw 'sessionRelay.appServerUrl must be a ws:// loopback URL ending in /rpc.'
}

$variableName = 'CODEX_APP_SERVER_WS_URL'
if ($Disable) {
    $current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if ($current -and $current -ne $url.AbsoluteUri) {
        throw "$variableName contains a different value; refusing to remove configuration owned by another setup."
    }
    [Environment]::SetEnvironmentVariable($variableName, $null, [EnvironmentVariableTarget]::User)
    Write-Output 'Codex Desktop shared App Server configuration removed. Fully exit and reopen Codex Desktop.'
} else {
    $current = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    if ($current -and $current -ne $url.AbsoluteUri -and -not $Force) {
        throw "$variableName already contains a different value; refusing to overwrite another setup."
    }
    [Environment]::SetEnvironmentVariable($variableName, $url.AbsoluteUri, [EnvironmentVariableTarget]::User)
    Write-Output 'Codex Desktop is configured to use the local Session Relay App Server after its next full restart.'
}

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
