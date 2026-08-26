$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This Project root setup script supports Windows only.'
}

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json not found. Complete the Bridge installation first.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$node = [string]$config.nodeExecutable
if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
    throw 'The configured Node.js executable is unavailable.'
}

$projectRoot = Read-Host 'Bridge Project root (absolute local directory)'
$ownerDirectoryName = Read-Host 'Owner directory name under that root'
if ([string]::IsNullOrWhiteSpace($projectRoot) -or [string]::IsNullOrWhiteSpace($ownerDirectoryName)) {
    throw 'Both values are required.'
}

$request = [ordered]@{
    projectRoot = $projectRoot
    ownerDirectoryName = $ownerDirectoryName
} | ConvertTo-Json -Compress
$entry = Join-Path $PSScriptRoot 'src\app\configure-session-access.mjs'
$request | & $node $entry
if ($LASTEXITCODE -ne 0) {
    throw 'Project root setup failed without changing Bridge message permissions.'
}
Write-Output 'Restart the Bridge before using /members or member-scoped /add.'
