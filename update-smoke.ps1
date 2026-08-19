param(
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $temporaryBase ('feishu-bridge-update-' + [guid]::NewGuid().ToString('N'))
$seedRoot = Join-Path $testRoot 'seed'
$originRoot = Join-Path $testRoot 'origin.git'
$privateRoot = Join-Path $testRoot 'private.git'
$runtimeWorkspace = Join-Path $testRoot 'installed-workspace'
$installRoot = Join-Path $runtimeWorkspace 'work\feishu-codex-bridge'
New-Item -ItemType Directory -Force -Path $seedRoot | Out-Null

function Invoke-TestGit {
    param([Parameter(Mandatory)][string]$WorkingDirectory, [Parameter(Mandatory)][string[]]$Arguments)
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $WorkingDirectory @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorPreference
    }
    if ($exitCode -ne 0) {
        throw "Test git command failed: $($Arguments[0])"
    }
    return $output
}

function Write-Utf8File {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

try {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'update.ps1') -Destination (Join-Path $seedRoot 'update.ps1')
    Write-Utf8File -Path (Join-Path $seedRoot '.gitignore') -Content @'
bridge.config.json
node_modules/
*.log
channel-secret.dpapi
session-relay-*.json
codex-app-server.pid
codex-app-server-environment.json
custom-guardian.marker
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'package.json') -Content @'
{"name":"feishu-bridge-update-smoke","version":"1.0.0","private":true}
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'package-lock.json') -Content @'
{"name":"feishu-bridge-update-smoke","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"feishu-bridge-update-smoke","version":"1.0.0"}}}
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'install.ps1') -Content @'
param([switch]$SkipDependencyInstall, [switch]$SkipDesktopRelayMigration)
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Add-Content -LiteralPath (Join-Path $runtime 'install-ran.log') -Value "skipRelay=$SkipDesktopRelayMigration"
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'doctor.ps1') -Content @'
param([switch]$RequireRunning, [switch]$RequireDesktopRelay)
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
Add-Content -LiteralPath (Join-Path $runtime 'doctor-ran.log') -Value "running=$RequireRunning;relay=$RequireDesktopRelay"
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'start-bridge.ps1') -Content @'
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
Add-Content -LiteralPath (Join-Path $runtime 'start-ran.log') -Value 'ok'
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'stop-bridge.ps1') -Content @'
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
Add-Content -LiteralPath (Join-Path $runtime 'stop-ran.log') -Value 'ok'
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'start-app-server.ps1') -Content @'
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
Add-Content -LiteralPath (Join-Path $runtime 'app-server-start-ran.log') -Value 'ok'
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'configure-codex-desktop-relay.ps1') -Content @'
param([string]$Proxy, [switch]$NoProxy)
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'bridge.config.json') | ConvertFrom-Json
$runtime = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
$mode = if ($Proxy) { "proxy:$Proxy" } elseif ($NoProxy) { 'direct' } else { 'unspecified' }
Add-Content -LiteralPath (Join-Path $runtime 'relay-configure-ran.log') -Value $mode
'@
    Write-Utf8File -Path (Join-Path $seedRoot 'release-marker.txt') -Content "one`n"

    & git init --quiet $seedRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the seed repository.' }
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('config', 'user.name', 'Updater Smoke Test') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('config', 'user.email', 'updater-smoke@example.invalid') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('add', '.') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('commit', '--quiet', '-m', 'release one') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('tag', 'v9.0.0-test.1') | Out-Null

    Write-Utf8File -Path (Join-Path $seedRoot 'release-marker.txt') -Content "two`n"
    $legacyIgnore = Get-Content -Raw -LiteralPath (Join-Path $seedRoot '.gitignore')
    Write-Utf8File -Path (Join-Path $seedRoot '.gitignore') -Content ($legacyIgnore.TrimEnd() + "`nupgrade-backups/`n")
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('add', 'release-marker.txt', '.gitignore') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('commit', '--quiet', '-m', 'release two') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('tag', 'v9.0.0-test.2') | Out-Null

    Write-Utf8File -Path (Join-Path $seedRoot 'install.ps1') -Content "param([switch]`$SkipDependencyInstall, [switch]`$SkipDesktopRelayMigration)`nthrow 'intentional smoke-test failure'`n"
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('add', 'install.ps1') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('commit', '--quiet', '-m', 'broken release') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('tag', 'v9.0.0-test.3') | Out-Null

    Write-Utf8File -Path (Join-Path $seedRoot 'install.ps1') -Content "param([switch]`$SkipDependencyInstall)`n# intentionally lacks relay-preserving update support`n"
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('add', 'install.ps1') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('commit', '--quiet', '-m', 'incompatible relay release') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('tag', 'v9.0.0-test.4') | Out-Null

    & git init --bare --quiet $originRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the test origin.' }
    & git init --bare --quiet $privateRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the test private remote.' }
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('remote', 'add', 'origin', $originRoot) | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('remote', 'add', 'private', $privateRoot) | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('push', '--quiet', 'origin', 'HEAD', '--tags') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedRoot -Arguments @('push', '--quiet', 'private', 'HEAD', '--tags') | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $installRoot) | Out-Null
    & git clone --quiet --branch v9.0.0-test.1 $originRoot $installRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not clone the test installation.' }
    Invoke-TestGit -WorkingDirectory $installRoot -Arguments @('remote', 'add', 'private', $privateRoot) | Out-Null

    $relayUrl = 'ws://127.0.0.1:47991/rpc'
    $config = [ordered]@{
        mode = 'session-relay'
        workspace = $runtimeWorkspace
        sessionRelay = [ordered]@{ appServerUrl = $relayUrl }
    }
    Write-Utf8File -Path (Join-Path $installRoot 'bridge.config.json') -Content (($config | ConvertTo-Json) + "`n")
    $runtimeDirectory = Join-Path $runtimeWorkspace 'work\feishu-codex-bridge'
    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'channel-secret.dpapi') -Content 'encrypted-smoke-value'
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'session-relay-settings.json') -Content '{"schemaVersion":2}'
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'session-relay-prompt-queue.json') -Content '[]'
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'session-relay-attachment-drafts.json') -Content '[]'
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'session-relay-access.json') -Content '{"schemaVersion":1}'
    $desktopProxyUrl = 'http://127.0.0.1:47888'
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'codex-app-server.pid') -Content ([string]$PID)
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'codex-app-server-environment.json') -Content (([ordered]@{
        schemaVersion = 1
        processId = $PID
        mode = 'proxy'
        desktopProxyUrl = $desktopProxyUrl
    } | ConvertTo-Json) + "`n")
    Write-Utf8File -Path (Join-Path $runtimeDirectory 'custom-guardian.marker') -Content 'preserve external guardian'
    $legacyBackupDirectory = Join-Path $runtimeDirectory 'upgrade-backups\legacy-backup'
    New-Item -ItemType Directory -Force -Path $legacyBackupDirectory | Out-Null
    Write-Utf8File -Path (Join-Path $legacyBackupDirectory 'manifest.json') -Content '{"schemaVersion":1}'

    $relayBootstrapDirectory = Join-Path $testRoot 'bootstrap'
    New-Item -ItemType Directory -Force -Path $relayBootstrapDirectory | Out-Null
    $relayStatePath = Join-Path $relayBootstrapDirectory 'desktop-relay-state.json'
    $relayBootstrapPath = Join-Path $relayBootstrapDirectory 'desktop-relay-bootstrap.ps1'
    Write-Utf8File -Path $relayStatePath -Content (([ordered]@{
        schemaVersion = 1
        enabled = $true
        expectedUrl = $relayUrl
        desktopProxyUrl = $desktopProxyUrl
    } | ConvertTo-Json) + "`n")
    Write-Utf8File -Path $relayBootstrapPath -Content "# preserved bootstrap`n"

    $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST = '1'
    $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_URL = $relayUrl
    $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_STATE_PATH = $relayStatePath
    $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_BOOTSTRAP_PATH = $relayBootstrapPath

    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $preflightOutput = & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File (Join-Path $installRoot 'update.ps1') -Version v9.0.0-test.2 -Remote private -PreflightOnly -TestMode
    if ($LASTEXITCODE -ne 0 -or ($preflightOutput -join "`n") -notmatch 'Update preflight passed') {
        throw 'The target updater preflight did not complete successfully through powershell.exe -File.'
    }
    $tagAfterPreflight = (Invoke-TestGit -WorkingDirectory $installRoot -Arguments @('describe', '--tags', '--exact-match') | Out-String).Trim()
    if ($tagAfterPreflight -ne 'v9.0.0-test.1') { throw 'PreflightOnly changed the installed checkout.' }
    $backupManifestsAfterPreflight = @(Get-ChildItem -LiteralPath (Join-Path $runtimeDirectory 'upgrade-backups') -Filter manifest.json -Recurse -File)
    if ($backupManifestsAfterPreflight.Count -ne 1) { throw 'PreflightOnly created or removed a recovery backup.' }
    if (Test-Path -LiteralPath (Join-Path $runtimeDirectory 'install-ran.log')) {
        throw 'PreflightOnly ran the target installer.'
    }

    & (Join-Path $installRoot 'update.ps1') -InstallRoot $installRoot -Version v9.0.0-test.2 -Remote private -StartBridge -TestMode
    $tagAfterUpgrade = (Invoke-TestGit -WorkingDirectory $installRoot -Arguments @('describe', '--tags', '--exact-match') | Out-String).Trim()
    if ($tagAfterUpgrade -ne 'v9.0.0-test.2') { throw 'The updater did not switch to the requested tag.' }
    if ((Get-Content -Raw -LiteralPath (Join-Path $installRoot 'release-marker.txt')).Trim() -ne 'two') {
        throw 'The target release files were not installed.'
    }
    foreach ($stateName in @(
        'channel-secret.dpapi',
        'session-relay-settings.json',
        'session-relay-prompt-queue.json',
        'session-relay-attachment-drafts.json',
        'session-relay-access.json',
        'codex-app-server-environment.json'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $runtimeDirectory $stateName) -PathType Leaf)) {
            throw "The updater did not preserve $stateName."
        }
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $runtimeDirectory 'custom-guardian.marker')).Trim() -ne 'preserve external guardian') {
        throw 'The updater changed external guardian state.'
    }
    $doctorLog = Get-Content -Raw -LiteralPath (Join-Path $runtimeDirectory 'doctor-ran.log')
    if ($doctorLog -notmatch 'running=True;relay=True') {
        throw 'The updater did not require strict Desktop relay verification for an enabled v0.2-style relay.'
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $runtimeDirectory 'install-ran.log')) -notmatch 'skipRelay=True') {
        throw 'The updater allowed the target installer to mutate Desktop relay state.'
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $runtimeDirectory 'relay-configure-ran.log')) -notmatch [regex]::Escape("proxy:$desktopProxyUrl")) {
        throw 'The updater did not carry the preserved proxy selection into target relay verification.'
    }
    $backupManifests = @(Get-ChildItem -LiteralPath (Join-Path $runtimeDirectory 'upgrade-backups') -Filter manifest.json -Recurse -File)
    if ($backupManifests.Count -lt 2) { throw 'The updater did not preserve the legacy backup and create a recovery manifest.' }
    if (-not (Test-Path -LiteralPath (Join-Path $legacyBackupDirectory 'manifest.json') -PathType Leaf)) {
        throw 'The updater removed an existing recovery backup.'
    }

    Write-Utf8File -Path (Join-Path $installRoot 'user-change.txt') -Content "preserve me`n"
    $dirtyTreeRejected = $false
    try {
        & (Join-Path $installRoot 'update.ps1') -InstallRoot $installRoot -Version v9.0.0-test.3 -StartBridge -TestMode
    } catch {
        if ($_.Exception.Message -match 'uncommitted or untracked changes') {
            $dirtyTreeRejected = $true
        } else {
            throw
        }
    }
    if (-not $dirtyTreeRejected) { throw 'The updater did not reject a dirty worktree.' }
    if ((Get-Content -Raw -LiteralPath (Join-Path $installRoot 'user-change.txt')).Trim() -ne 'preserve me') {
        throw 'The updater changed an untracked user file.'
    }
    Remove-Item -LiteralPath (Join-Path $installRoot 'user-change.txt') -Force

    $rollbackFailedAsExpected = $false
    try {
        & (Join-Path $installRoot 'update.ps1') -InstallRoot $installRoot -Version v9.0.0-test.3 -StartBridge -TestMode
    } catch {
        if ($_.Exception.Message -match 'previous release and local state were restored') {
            $rollbackFailedAsExpected = $true
        } else {
            throw
        }
    }
    if (-not $rollbackFailedAsExpected) { throw 'The intentionally broken release did not fail.' }
    $tagAfterRollback = (Invoke-TestGit -WorkingDirectory $installRoot -Arguments @('describe', '--tags', '--exact-match') | Out-String).Trim()
    if ($tagAfterRollback -ne 'v9.0.0-test.2') { throw 'The failed update did not restore the previous tag.' }
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeDirectory 'channel-secret.dpapi') -PathType Leaf)) {
        throw 'The failed update did not restore the encrypted credential.'
    }

    $incompatibleTargetRejected = $false
    try {
        & (Join-Path $installRoot 'update.ps1') -InstallRoot $installRoot -Version v9.0.0-test.4 -StartBridge -TestMode
    } catch {
        if ($_.Exception.Message -match 'cannot preserve an active Desktop relay transactionally') {
            $incompatibleTargetRejected = $true
        } else {
            throw
        }
    }
    if (-not $incompatibleTargetRejected) { throw 'The updater accepted a target that could mutate active relay networking.' }
    $tagAfterPreflightRejection = (Invoke-TestGit -WorkingDirectory $installRoot -Arguments @('describe', '--tags', '--exact-match') | Out-String).Trim()
    if ($tagAfterPreflightRejection -ne 'v9.0.0-test.2') {
        throw 'Relay capability preflight changed the installed checkout.'
    }

    Write-Output 'Updater smoke test passed, including automatic rollback.'
} finally {
    Remove-Item Env:\FEISHU_CODEX_BRIDGE_UPDATE_TEST -ErrorAction SilentlyContinue
    Remove-Item Env:\FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_STATE_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_BOOTSTRAP_PATH -ErrorAction SilentlyContinue
    if ($KeepTemp) {
        Write-Output "Kept smoke-test directory: $testRoot"
    } else {
        $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
        $leaf = Split-Path -Leaf $resolvedTestRoot
        if (-not $resolvedTestRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -or
            $leaf -notlike 'feishu-bridge-update-*') {
            throw 'Refusing to remove an unverified smoke-test directory.'
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
