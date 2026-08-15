param(
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $temporaryBase ('feishu-bridge-install-' + [guid]::NewGuid().ToString('N'))
$sourceRoot = Join-Path $testRoot 'source'
$runtimeRoot = Join-Path $testRoot 'runtime'
New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null

try {
    $files = & git -C $repositoryRoot ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed' }
    foreach ($relativePath in $files) {
        $sourcePath = Join-Path $repositoryRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
        $targetPath = Join-Path $sourceRoot $relativePath
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath
    }

    & (Join-Path $sourceRoot 'install.ps1') `
        -AppId 'cli_installtest' `
        -OwnerOpenId 'ou_installtest' `
        -Workspace $runtimeRoot `
        -ForceConfig `
        -NoUserChanges
    if ($LASTEXITCODE -ne 0) { throw "install.ps1 exited with code $LASTEXITCODE" }

    $configPath = Join-Path $sourceRoot 'bridge.config.json'
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    if ([string]$config.mode -ne 'session-relay' -or @($config.sessionRelay.bindings).Count -ne 0) {
        throw 'The generated configuration does not have the expected empty Session Relay shape.'
    }

    Push-Location $sourceRoot
    try {
        $validationCode = "import('./src/relay/session-relay-config.mjs').then(async (module) => { await module.loadSessionRelayConfig('./bridge.config.json'); console.log('normalized config valid'); })"
        & ([string]$config.nodeExecutable) --input-type=module --eval $validationCode
        if ($LASTEXITCODE -ne 0) { throw 'The generated configuration failed Node validation.' }
    } finally {
        Pop-Location
    }
    Write-Output 'Fresh install smoke test passed.'
} finally {
    if ($KeepTemp) {
        Write-Output "Kept smoke-test directory: $testRoot"
    } else {
        $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
        $leaf = Split-Path -Leaf $resolvedTestRoot
        if (-not $resolvedTestRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -or
            $leaf -notlike 'feishu-bridge-install-*') {
            throw 'Refusing to remove an unverified smoke-test directory.'
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
