param(
    [string]$Workspace
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Feishu Channel SDK secure setup'

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
        $Workspace = [string]$config.workspace
    } else {
        $Workspace = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge'
    }
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    throw 'A Windows runtime workspace could not be determined.'
}
$resolvedWorkspace = [IO.Path]::GetFullPath($Workspace)
$runtimeDir = Join-Path $resolvedWorkspace 'work\feishu-codex-bridge'
$secretPath = Join-Path $runtimeDir 'channel-secret.dpapi'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

Write-Host ''
Write-Host 'Paste the Feishu App Secret, then press Enter.' -ForegroundColor Cyan
Write-Host 'The input will stay hidden and will not be written to logs or chat.' -ForegroundColor DarkGray
Write-Host ''

$secret = Read-Host 'App Secret' -AsSecureString
if ($secret.Length -eq 0) {
    throw 'App Secret cannot be empty.'
}

$encrypted = ConvertFrom-SecureString -SecureString $secret
[System.IO.File]::WriteAllText($secretPath, $encrypted, [System.Text.Encoding]::ASCII)
$secret.Dispose()

Write-Host ''
Write-Host 'Saved with Windows DPAPI encryption; no plaintext was stored.' -ForegroundColor Green
Write-Host 'Return to Codex and say: secure input completed.' -ForegroundColor Green
Write-Host ''
Read-Host 'Press Enter to close this window'
