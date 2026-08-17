$ErrorActionPreference = 'Stop'

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'Node.js is required. Install Node.js 22.13 or newer, then reopen PowerShell.'
}

$entry = Join-Path $PSScriptRoot 'node_modules\@larksuite\cli\scripts\run.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw 'The repository-local Feishu CLI is missing. Run npm ci in the repository first.'
}

$proxyNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
$savedEnvironment = @{}
try {
    foreach ($name in $proxyNames) {
        $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        if ($item) { $savedEnvironment[$name] = [string]$item.Value }
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    & $nodeCommand.Source $entry @args
    $exitCode = $LASTEXITCODE
} finally {
    foreach ($name in $proxyNames) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        if ($savedEnvironment.ContainsKey($name)) {
            Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
        }
    }
}
exit $exitCode
