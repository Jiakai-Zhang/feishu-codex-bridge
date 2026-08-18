$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This Feishu app verification entrypoint supports Windows only.'
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'Node.js is required. Install Node.js 22.13 or newer, then reopen PowerShell.'
}

$entry = Join-Path $PSScriptRoot 'src\runtime\platform\windows\feishu-app-entry.mjs'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw 'The Windows Feishu app verification entrypoint is missing from this release.'
}

& $nodeCommand.Source $entry verify
exit $LASTEXITCODE
