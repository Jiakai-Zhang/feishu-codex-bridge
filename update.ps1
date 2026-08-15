param(
    [Parameter(Mandatory)]
    [ValidatePattern('^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$')]
    [string]$Version,
    [string]$InstallRoot = $PSScriptRoot,
    [switch]$StartBridge,
    [switch]$TestMode
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This updater supports Windows only.'
}

function Get-CommandPath {
    param([Parameter(Mandatory)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    if ($command.Source) { return [IO.Path]::GetFullPath([string]$command.Source) }
    if ($command.Path) { return [IO.Path]::GetFullPath([string]$command.Path) }
    return $null
}

$repositoryRoot = [IO.Path]::GetFullPath($InstallRoot)
if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot '.git'))) {
    throw 'InstallRoot is not a Git checkout of Feishu Codex Bridge.'
}

if ($TestMode) {
    $temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $repositoryRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'TestMode is restricted to the updater smoke-test directory.'
    }
    $relativeToTemp = $repositoryRoot.Substring($temporaryBase.Length).TrimStart('\', '/')
    $testContainer = ($relativeToTemp -split '[\\/]')[0]
    if ($env:FEISHU_CODEX_BRIDGE_UPDATE_TEST -ne '1' -or
        $testContainer -notlike 'feishu-bridge-update-*') {
        throw 'TestMode is restricted to the updater smoke-test directory.'
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$Capture
    )
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & git -C $repositoryRoot @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorPreference
    }
    if ($exitCode -ne 0) {
        throw "git $($Arguments[0]) failed."
    }
    if ($Capture) {
        return (($lines | ForEach-Object { [string]$_ }) -join "`n").Trim()
    }
}

function Test-ApprovedOrigin {
    param([Parameter(Mandatory)][string]$Url)
    return $Url -match '(?i)^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)(?:ninmon|Jiakai-Zhang)/feishu-codex-bridge(?:\.git)?/?$'
}

function Test-BridgeRunning {
    param(
        [Parameter(Mandatory)][object]$Config,
        [Parameter(Mandatory)][string]$RuntimeDirectory
    )
    $pidPath = Join-Path $RuntimeDirectory 'bridge.pid'
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { return $false }
    try { $processId = [int](Get-Content -Raw -LiteralPath $pidPath) } catch { return $false }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if (-not $processInfo -or [string]$processInfo.Name -ine 'node.exe') { return $false }
    $mode = if ([string]::IsNullOrWhiteSpace([string]$Config.mode)) { 'project-agent' } else { [string]$Config.mode }
    $entryName = if ($mode -eq 'session-relay') { 'session-relay.mjs' } else { 'channel-bridge.mjs' }
    $expectedEntry = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $entryName))
    return [string]$processInfo.CommandLine -like "*$expectedEntry*"
}

function New-RecoveryBackup {
    param(
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)][string]$RuntimeDirectory,
        [Parameter(Mandatory)][string]$SourceCommit,
        [Parameter(Mandatory)][string]$TargetVersion
    )
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $safeVersion = $TargetVersion -replace '[^0-9A-Za-z.-]', '_'
    $backupDirectory = Join-Path $RuntimeDirectory "upgrade-backups\$stamp-$safeVersion"
    $runtimeBackupDirectory = Join-Path $backupDirectory 'runtime'
    New-Item -ItemType Directory -Force -Path $runtimeBackupDirectory | Out-Null
    Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $backupDirectory 'bridge.config.json') -Force

    $stateNames = @(
        'channel-secret.dpapi',
        'completed.json',
        'pending-deliveries.json',
        'pending-agent-events.json',
        'audit.jsonl',
        'task-leases.json',
        'team-tasks.json',
        'temporary-chat.json',
        'session-relay-completed.json',
        'session-relay-pending-deliveries.json',
        'session-relay-input-ledger.json',
        'session-relay-prompt-queue.json',
        'session-relay-settings.json',
        'session-relay-attachment-drafts.json'
    )
    $backedUpNames = [Collections.Generic.List[string]]::new()
    foreach ($name in $stateNames) {
        $source = Join-Path $RuntimeDirectory $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        Copy-Item -LiteralPath $source -Destination (Join-Path $runtimeBackupDirectory $name) -Force
        $backedUpNames.Add($name)
    }
    Get-ChildItem -LiteralPath $RuntimeDirectory -Filter 'selected-thread*.json' -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($backedUpNames.Contains($_.Name)) { return }
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runtimeBackupDirectory $_.Name) -Force
            $backedUpNames.Add($_.Name)
        }

    foreach ($directoryName in @('session-binding-requests', 'collaboration-inbox')) {
        $source = Join-Path $RuntimeDirectory $directoryName
        if (Test-Path -LiteralPath $source -PathType Container) {
            $destination = Join-Path $runtimeBackupDirectory $directoryName
            New-Item -ItemType Directory -Force -Path $destination | Out-Null
            Get-ChildItem -LiteralPath $source -Force -ErrorAction SilentlyContinue |
                ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }
            $backedUpNames.Add("$directoryName/")
        }
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        createdAt = [DateTime]::UtcNow.ToString('o')
        sourceCommit = $SourceCommit
        targetVersion = $TargetVersion
        files = @($backedUpNames)
    }
    [IO.File]::WriteAllText(
        (Join-Path $backupDirectory 'manifest.json'),
        (($manifest | ConvertTo-Json -Depth 4) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )
    return $backupDirectory
}

function Restore-RecoveryBackup {
    param(
        [Parameter(Mandatory)][string]$BackupDirectory,
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)][string]$RuntimeDirectory
    )
    $configBackup = Join-Path $BackupDirectory 'bridge.config.json'
    if (Test-Path -LiteralPath $configBackup -PathType Leaf) {
        Copy-Item -LiteralPath $configBackup -Destination $ConfigPath -Force
    }
    $runtimeBackupDirectory = Join-Path $BackupDirectory 'runtime'
    if (-not (Test-Path -LiteralPath $runtimeBackupDirectory -PathType Container)) { return }
    Get-ChildItem -LiteralPath $runtimeBackupDirectory -File -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $RuntimeDirectory $_.Name) -Force }
    Get-ChildItem -LiteralPath $runtimeBackupDirectory -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
            $destination = Join-Path $RuntimeDirectory $_.Name
            New-Item -ItemType Directory -Force -Path $destination | Out-Null
            Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue |
                ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }
        }
}

$gitPath = Get-CommandPath -Name 'git.exe'
if (-not $gitPath) { $gitPath = Get-CommandPath -Name 'git' }
if (-not $gitPath) { throw 'Git was not found.' }
$npmPath = Get-CommandPath -Name 'npm.cmd'
if (-not $npmPath) { $npmPath = Get-CommandPath -Name 'npm.exe' }
if (-not $npmPath) { throw 'npm was not found.' }

$originUrl = Invoke-Git -Arguments @('remote', 'get-url', 'origin') -Capture
if (-not $TestMode -and -not (Test-ApprovedOrigin -Url $originUrl)) {
    throw 'The origin remote is not an approved Feishu Codex Bridge repository; refusing to update it.'
}

$dirtyState = Invoke-Git -Arguments @('status', '--porcelain', '--untracked-files=normal') -Capture
if (-not [string]::IsNullOrWhiteSpace($dirtyState)) {
    throw 'The installation has uncommitted or untracked changes. Preserve them separately before updating; the updater will not reset or clean them.'
}

$configPath = Join-Path $repositoryRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json is missing; this does not look like a completed installation.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$config.workspace)) {
    throw 'The local configuration does not contain a runtime workspace.'
}
$runtimeDirectory = Join-Path ([IO.Path]::GetFullPath([string]$config.workspace)) 'work\feishu-codex-bridge'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$expectedDesktopRelayUrl = [string]$config.sessionRelay.appServerUrl
$currentDesktopRelayUrl = [Environment]::GetEnvironmentVariable(
    'CODEX_APP_SERVER_WS_URL', [EnvironmentVariableTarget]::User)
if ($TestMode -and -not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_URL)) {
    $currentDesktopRelayUrl = $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_URL
}
$desktopRelayWasEnabled = -not [string]::IsNullOrWhiteSpace($expectedDesktopRelayUrl) -and
    $currentDesktopRelayUrl -eq $expectedDesktopRelayUrl

$previousCommit = Invoke-Git -Arguments @('rev-parse', '--verify', 'HEAD') -Capture
Invoke-Git -Arguments @('fetch', '--quiet', 'origin', "refs/tags/${Version}:refs/tags/${Version}")
$targetCommit = Invoke-Git -Arguments @('rev-parse', '--verify', "refs/tags/$Version^{commit}") -Capture
$bridgeWasRunning = Test-BridgeRunning -Config $config -RuntimeDirectory $runtimeDirectory
$shouldStart = $bridgeWasRunning -or $StartBridge

if ($previousCommit -eq $targetCommit) {
    Write-Output "$Version is already installed."
    if ($StartBridge -and -not $bridgeWasRunning) {
        & (Join-Path $repositoryRoot 'start-bridge.ps1')
        $bridgeWasRunning = $true
    }
    $doctorArguments = @{}
    if ($bridgeWasRunning) { $doctorArguments['RequireRunning'] = $true }
    if ($desktopRelayWasEnabled) { $doctorArguments['RequireDesktopRelay'] = $true }
    & (Join-Path $repositoryRoot 'doctor.ps1') @doctorArguments
    exit 0
}

$backupDirectory = $null
$checkoutChanged = $false
$bridgeStopped = $false
try {
    if ($bridgeWasRunning) {
        & (Join-Path $repositoryRoot 'stop-bridge.ps1')
        $bridgeStopped = $true
    }

    $backupDirectory = New-RecoveryBackup -ConfigPath $configPath -RuntimeDirectory $runtimeDirectory `
        -SourceCommit $previousCommit -TargetVersion $Version
    Write-Output 'Created a local recovery backup of configuration, credentials, and relay state.'

    Invoke-Git -Arguments @('checkout', '--quiet', '--detach', $Version)
    $checkoutChanged = $true

    Write-Output 'Installing the dependencies pinned by the target release...'
    & $npmPath ci --prefix $repositoryRoot --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

    & (Join-Path $repositoryRoot 'install.ps1') -SkipDependencyInstall

    if ($shouldStart) {
        & (Join-Path $repositoryRoot 'start-bridge.ps1')
        if ($desktopRelayWasEnabled) {
            & (Join-Path $repositoryRoot 'doctor.ps1') -RequireRunning -RequireDesktopRelay
        } else {
            & (Join-Path $repositoryRoot 'doctor.ps1') -RequireRunning
        }
    } else {
        if ($desktopRelayWasEnabled) {
            & (Join-Path $repositoryRoot 'doctor.ps1') -RequireDesktopRelay
        } else {
            & (Join-Path $repositoryRoot 'doctor.ps1')
        }
    }

    $installedCommit = Invoke-Git -Arguments @('rev-parse', '--verify', 'HEAD') -Capture
    if ($installedCommit -ne $targetCommit) { throw 'The checked-out commit changed during verification.' }
    Write-Output "Upgrade completed successfully: $Version."
    if (-not $shouldStart) {
        Write-Output 'The Bridge was stopped before the upgrade and remains stopped. Run start-bridge.ps1 when ready.'
    }
} catch {
    $upgradeError = $_.Exception.Message
    $rollbackError = $null
    try {
        if ($shouldStart -and (Test-BridgeRunning -Config $config -RuntimeDirectory $runtimeDirectory)) {
            & (Join-Path $repositoryRoot 'stop-bridge.ps1')
        }
        if ($checkoutChanged) {
            Invoke-Git -Arguments @('checkout', '--quiet', '--detach', $previousCommit)
        }
        if ($backupDirectory) {
            Restore-RecoveryBackup -BackupDirectory $backupDirectory -ConfigPath $configPath -RuntimeDirectory $runtimeDirectory
        }
        if ($checkoutChanged) {
            & $npmPath ci --prefix $repositoryRoot --ignore-scripts=false
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed while restoring the previous release.' }
            & (Join-Path $repositoryRoot 'install.ps1') -SkipDependencyInstall
        }
        if ($bridgeWasRunning -or $StartBridge) {
            & (Join-Path $repositoryRoot 'start-bridge.ps1')
        }
        if ($desktopRelayWasEnabled) {
            $previousStarter = Join-Path $repositoryRoot 'start-app-server.ps1'
            if (Test-Path -LiteralPath $previousStarter -PathType Leaf) {
                & $previousStarter | Out-Null
                & (Join-Path $repositoryRoot 'configure-codex-desktop-relay.ps1')
            } elseif ($bridgeWasRunning -or $StartBridge) {
                # v0.2 has no standalone starter. start-bridge.ps1 above has
                # already restored its App Server, so the old pointer is safe.
                & (Join-Path $repositoryRoot 'configure-codex-desktop-relay.ps1')
            } else {
                # Never roll back to an enabled v0.2 pointer when no listener
                # was restored. Preserve Desktop availability over the unsafe
                # pointer while leaving the previous release and data intact.
                & (Join-Path $repositoryRoot 'configure-codex-desktop-relay.ps1') -Disable
            }
        }
    } catch {
        $rollbackError = $_.Exception.Message
    }

    if ($rollbackError) {
        throw "Upgrade failed and automatic rollback also failed. Upgrade error: $upgradeError Rollback error: $rollbackError"
    }
    if ($checkoutChanged -or $bridgeStopped) {
        throw "Upgrade failed; the previous release and local state were restored. Cause: $upgradeError"
    }
    throw "Upgrade failed before the installation changed. Cause: $upgradeError"
}
