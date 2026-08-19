param(
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $temporaryBase ('feishu-bridge-foreground-' + [guid]::NewGuid().ToString('N'))
$seedRoot = Join-Path $testRoot 'seed'
$privateRoot = Join-Path $testRoot 'private.git'
$installRoot = Join-Path $testRoot 'installed'
$runtimeWorkspace = Join-Path $testRoot 'runtime'
$runnerPath = Join-Path $testRoot 'foreground-runner.ps1'
$stateRoot = Join-Path $testRoot 'foreground-state'

function Write-Utf8File {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Invoke-TestGit {
    param([Parameter(Mandatory)][string]$WorkingDirectory, [Parameter(Mandatory)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $WorkingDirectory @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { throw "Test git command failed: $($Arguments[0])" }
    return $output
}

try {
    New-Item -ItemType Directory -Force -Path $seedRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'update.ps1') -Destination (Join-Path $seedRoot 'update.ps1')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'update-windows-with-desktop-restart.ps1') -Destination $runnerPath
    Write-Utf8File -Path (Join-Path $seedRoot '.gitignore') -Content "bridge.config.json`nnode_modules/`n"
    Write-Utf8File -Path (Join-Path $seedRoot 'package.json') -Content @'
{"name":"feishu-bridge-foreground-update-smoke","version":"1.0.0","private":true}
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'package-lock.json') -Content @'
{"name":"feishu-bridge-foreground-update-smoke","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"feishu-bridge-foreground-update-smoke","version":"1.0.0"}}}
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'install.ps1') -Content @'
param([switch]$SkipDependencyInstall, [switch]$SkipDesktopRelayMigration)
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Add-Content -LiteralPath (Join-Path $runtime 'install.log') -Value "skipRelay=$SkipDesktopRelayMigration"
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'doctor.ps1') -Content @'
param([switch]$RequireRunning, [switch]$RequireDesktopRelay)
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
Add-Content -LiteralPath (Join-Path $runtime 'doctor.log') -Value "running=$RequireRunning;relay=$RequireDesktopRelay"
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'start-bridge.ps1') -Content @'
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
Add-Content -LiteralPath (Join-Path $runtime 'start.log') -Value 'started'
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'stop-bridge.ps1') -Content @'
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
Add-Content -LiteralPath (Join-Path $runtime 'stop.log') -Value 'stopped'
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'configure-codex-desktop-relay.ps1') -Content @'
param([string]$Proxy, [switch]$NoProxy)
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
$mode = if ($Proxy) { "proxy:$Proxy" } elseif ($NoProxy) { 'direct' } else { 'unspecified' }
Add-Content -LiteralPath (Join-Path $runtime 'relay-configure.log') -Value $mode
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'launch-codex-desktop-with-relay.ps1') -Content @'
param([string]$Proxy, [switch]$NoProxy)
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
$mode = if ($Proxy) { "proxy:$Proxy" } elseif ($NoProxy) { 'direct' } else { 'unspecified' }
Add-Content -LiteralPath (Join-Path $runtime 'desktop-launch.log') -Value $mode
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'release-marker.txt') -Content "old`n"

    & git init --quiet $seedRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the foreground-update seed repository.' }
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('config', 'user.name', 'Foreground Update Smoke') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('config', 'user.email', 'foreground-update@example.invalid') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('add', '.') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('commit', '--quiet', '-m', 'old release') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('tag', 'v9.1.0-test.1') | Out-Null

    Write-Utf8File -Path (Join-Path $seedRoot 'release-marker.txt') -Content "new`n"
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('add', 'release-marker.txt') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('commit', '--quiet', '-m', 'new release') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('tag', 'v9.1.0-test.2') | Out-Null

    & git init --bare --quiet $privateRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the foreground-update remote.' }
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('remote', 'add', 'private', $privateRoot) | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('push', '--quiet', 'private', 'HEAD', '--tags') | Out-Null
    & git clone --quiet --branch v9.1.0-test.1 $privateRoot $installRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not clone the foreground-update installation.' }
    Invoke-TestGit -WorkingDirectory $installRoot -Arguments @('remote', 'add', 'private', $privateRoot) | Out-Null

    $relayUrl = 'ws://127.0.0.1:47992/rpc'
    $desktopProxyUrl = 'http://127.0.0.1:47889'
    $config = [ordered]@{
        mode = 'session-relay'
        workspace = $runtimeWorkspace
        sessionRelay = [ordered]@{ appServerUrl = $relayUrl }
    }
    Write-Utf8File -Path (Join-Path $installRoot 'bridge.config.json') -Content (($config | ConvertTo-Json) + "`n")
    $runtimeDirectory = Join-Path $runtimeWorkspace 'work\feishu-codex-bridge'
    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'channel-secret.dpapi') -Content 'encrypted-smoke-value'
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'codex-app-server.pid') -Content ([string]$PID)
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'codex-app-server-environment.json') -Content (([ordered]@{
        schemaVersion = 1
        processId = $PID
        mode = 'proxy'
        desktopProxyUrl = $desktopProxyUrl
    } | ConvertTo-Json) + "`n")

    $relayStatePath = Join-Path $testRoot 'desktop-relay-state.json'
    $relayBootstrapPath = Join-Path $testRoot 'desktop-relay-bootstrap.ps1'
    Write-Utf8File -Path $relayStatePath -Content (([ordered]@{
        schemaVersion = 1
        enabled = $true
        expectedUrl = $relayUrl
        desktopProxyUrl = $desktopProxyUrl
    } | ConvertTo-Json) + "`n")
    Write-Utf8File -Path $relayBootstrapPath -Content "# smoke bootstrap`n"

    $env:FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST = '1'
    $env:FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST_ROOT = $testRoot
    $env:FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST_RELAY_STATE = $relayStatePath
    $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST = '1'
    $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_URL = $relayUrl
    $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_STATE_PATH = $relayStatePath
    $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_BOOTSTRAP_PATH = $relayBootstrapPath
    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    Write-Utf8File -Path (Join-Path $stateRoot 'desktop-running') -Content "running`n"
    Write-Utf8File -Path (Join-Path $stateRoot 'desktop-window-visible') -Content "visible`n"

    & $runnerPath -Version v9.1.0-test.2 -InstallRoot $installRoot -Remote private -TestMode
    $waitingStatuses = @(Get-ChildItem -LiteralPath $stateRoot -Filter '*.status.json' -File | Where-Object {
        try { [string](Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json).state -eq 'waiting-for-desktop-exit' } catch { $false }
    })
    if ($waitingStatuses.Count -ne 1) { throw 'The foreground worker did not reach its Desktop-exit wait.' }
    Remove-Item -LiteralPath (Join-Path $stateRoot 'desktop-window-visible') -Force

    $statusPath = $waitingStatuses[0].FullName
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        Start-Sleep -Milliseconds 250
        $status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
        if ([string]$status.state -eq 'failed') { throw ([string]$status.detail) }
    } while ([string]$status.state -ne 'completed' -and [DateTime]::UtcNow -lt $deadline)
    if ([string]$status.state -ne 'completed' -or -not [bool]$status.succeeded) {
        throw 'The foreground worker did not complete within the smoke-test deadline.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stateRoot 'desktop-residual-stop.log') -PathType Leaf)) {
        throw 'The foreground worker did not stop the verified residual Desktop process after its window closed.'
    }

    $tag = (Invoke-TestGit -WorkingDirectory $installRoot -Arguments @('describe', '--tags', '--exact-match') | Out-String).Trim()
    if ($tag -ne 'v9.1.0-test.2') { throw 'The foreground worker installed the wrong release.' }
    if ((Get-Content -Raw -LiteralPath (Join-Path $installRoot 'release-marker.txt')).Trim() -ne 'new') {
        throw 'The foreground worker did not install the target files.'
    }
    $launchLog = Get-Content -Raw -LiteralPath (Join-Path $runtimeDirectory 'desktop-launch.log')
    if ($launchLog -notmatch [regex]::Escape("proxy:$desktopProxyUrl")) {
        throw 'The foreground worker did not preserve the Desktop proxy during relaunch.'
    }
    $doctorLines = @(Get-Content -LiteralPath (Join-Path $runtimeDirectory 'doctor.log'))
    if ($doctorLines.Count -lt 4 -or @($doctorLines | Where-Object { $_ -eq 'running=True;relay=True' }).Count -lt 4) {
        throw 'The foreground worker did not run strict Doctor before and after the transaction.'
    }
    if (Test-Path -LiteralPath (Join-Path $stateRoot (([IO.Path]::GetFileNameWithoutExtension($statusPath) -replace '\.status$', '') + '.request.json'))) {
        throw 'The foreground worker left its local request file behind.'
    }
    $dirty = (Invoke-TestGit -WorkingDirectory $installRoot -Arguments @('status', '--porcelain', '--untracked-files=all') | Out-String).Trim()
    if (-not [string]::IsNullOrWhiteSpace($dirty)) { throw 'The foreground worker left the installation dirty.' }

    Write-Output 'Foreground updater smoke test passed, including residual Desktop shutdown, proxy-preserving relaunch, and final Doctor.'
} finally {
    foreach ($name in @(
        'FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST',
        'FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST_ROOT',
        'FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST_RELAY_STATE',
        'FEISHU_CODEX_BRIDGE_UPDATE_TEST',
        'FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_URL',
        'FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_STATE_PATH',
        'FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_BOOTSTRAP_PATH'
    )) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    if ($KeepTemp) {
        Write-Output "Kept smoke-test directory: $testRoot"
    } else {
        $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
        $leaf = Split-Path -Leaf $resolvedTestRoot
        if (-not $resolvedTestRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -or
            $leaf -notlike 'feishu-bridge-foreground-*') {
            throw 'Refusing to remove an unverified foreground smoke-test directory.'
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
