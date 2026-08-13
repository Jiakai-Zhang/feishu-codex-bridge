$ErrorActionPreference = 'Stop'

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'Node.js is required. Install Node.js 22.13 or newer, then reopen PowerShell.'
}

$entry = Join-Path $PSScriptRoot 'node_modules\@larksuite\cli\scripts\run.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw 'The repository-local Feishu CLI is missing. Run npm ci in the repository first.'
}

& $nodeCommand.Source $entry @args
exit $LASTEXITCODE
