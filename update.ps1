param(
    [Parameter(Mandatory)]
    [ValidatePattern('^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$')]
    [string]$Version,
    [string]$InstallRoot,
    [ValidateSet('origin', 'private')]
    [string]$Remote = 'origin',
    [switch]$StartBridge,
    [string]$Proxy,
    [switch]$NoProxy,
    [switch]$PreflightOnly,
    [switch]$TestMode
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent ([IO.Path]::GetFullPath([string]$MyInvocation.MyCommand.Path))
}

if ($env:OS -ne 'Windows_NT') {
    throw 'This updater supports Windows only.'
}
if ($PSBoundParameters.ContainsKey('Proxy') -and $NoProxy) {
    throw '-Proxy cannot be combined with -NoProxy.'
}

function ConvertTo-SafeLoopbackProxy {
    param([string]$Value)
    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    if ($text -notmatch '^(?i)(https?|socks4|socks5)://(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})/?$') {
        throw 'The Desktop proxy must be an unauthenticated loopback URL with an explicit port.'
    }
    $uri = [Uri]$text
    if ($uri.Port -lt 1 -or $uri.Port -gt 65535) {
        throw 'The Desktop proxy port must be between 1 and 65535.'
    }
    return $text.TrimEnd('/')
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
        ($testContainer -notlike 'feishu-bridge-update-*' -and
            $testContainer -notlike 'feishu-bridge-foreground-*')) {
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

function Test-ApprovedUpdateRemote {
    param([Parameter(Mandatory)][string]$Url)
    return $Url -match '(?i)^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)(?:(?:ninmon|Jiakai-Zhang)/feishu-codex-bridge|ninmon/feishu-codex-bridge-private)(?:\.git)?/?$'
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
        [Parameter(Mandatory)][string]$TargetVersion,
        [string]$DesktopRelayStatePath,
        [string]$DesktopRelayBootstrapPath
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
        'session-relay-attachment-drafts.json',
        'session-relay-temporary-chats.json',
        'session-relay-long-answer-documents.json',
        'session-relay-stream-cards.json',
        'session-relay-access.json',
        'codex-app-server-environment.json'
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

    foreach ($directoryName in @(
        'session-binding-requests',
        'collaboration-inbox',
        'session-relay-inbound-attachments'
    )) {
        $source = Join-Path $RuntimeDirectory $directoryName
        if (Test-Path -LiteralPath $source -PathType Container) {
            $destination = Join-Path $runtimeBackupDirectory $directoryName
            New-Item -ItemType Directory -Force -Path $destination | Out-Null
            Get-ChildItem -LiteralPath $source -Force -ErrorAction SilentlyContinue |
                ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }
            $backedUpNames.Add("$directoryName/")
        }
    }

    $bootstrapBackupDirectory = Join-Path $backupDirectory 'desktop-relay-bootstrap'
    foreach ($item in @(
        @{ Source = $DesktopRelayStatePath; Name = 'desktop-relay-state.json' },
        @{ Source = $DesktopRelayBootstrapPath; Name = 'desktop-relay-bootstrap.ps1' }
    )) {
        if ([string]::IsNullOrWhiteSpace([string]$item.Source) -or
            -not (Test-Path -LiteralPath ([string]$item.Source) -PathType Leaf)) { continue }
        New-Item -ItemType Directory -Force -Path $bootstrapBackupDirectory | Out-Null
        Copy-Item -LiteralPath ([string]$item.Source) -Destination (Join-Path $bootstrapBackupDirectory $item.Name) -Force
        $backedUpNames.Add("desktop-relay-bootstrap/$($item.Name)")
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
        [Parameter(Mandatory)][string]$RuntimeDirectory,
        [string]$DesktopRelayStatePath,
        [string]$DesktopRelayBootstrapPath
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

    $bootstrapBackupDirectory = Join-Path $BackupDirectory 'desktop-relay-bootstrap'
    foreach ($item in @(
        @{ Backup = (Join-Path $bootstrapBackupDirectory 'desktop-relay-state.json'); Destination = $DesktopRelayStatePath },
        @{ Backup = (Join-Path $bootstrapBackupDirectory 'desktop-relay-bootstrap.ps1'); Destination = $DesktopRelayBootstrapPath }
    )) {
        if ([string]::IsNullOrWhiteSpace([string]$item.Destination) -or
            -not (Test-Path -LiteralPath ([string]$item.Backup) -PathType Leaf)) { continue }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent ([string]$item.Destination)) | Out-Null
        Copy-Item -LiteralPath ([string]$item.Backup) -Destination ([string]$item.Destination) -Force
    }
}

function Get-DirtyState {
    param([Parameter(Mandatory)][string]$RuntimeDirectory)
    $dirty = Invoke-Git -Arguments @('status', '--porcelain', '--untracked-files=all') -Capture
    if ([string]::IsNullOrWhiteSpace($dirty)) { return '' }

    $backupRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeDirectory 'upgrade-backups'))
    $repositoryPrefix = $repositoryRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $backupRoot.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $dirty
    }
    $relativeBackup = $backupRoot.Substring($repositoryPrefix.Length).Replace('\', '/').TrimEnd('/')
    $remaining = @($dirty -split "`r?`n" | Where-Object {
        $line = [string]$_
        if ($line -notmatch '^\?\? (.+)$') { return $true }
        $path = ([string]$Matches[1]).Trim('"').Replace('\', '/')
        return $path -ne $relativeBackup -and -not $path.StartsWith("$relativeBackup/", [StringComparison]::OrdinalIgnoreCase)
    })
    return ($remaining -join "`n").Trim()
}

$gitPath = Get-CommandPath -Name 'git.exe'
if (-not $gitPath) { $gitPath = Get-CommandPath -Name 'git' }
if (-not $gitPath) { throw 'Git was not found.' }
$npmPath = Get-CommandPath -Name 'npm.cmd'
if (-not $npmPath) { $npmPath = Get-CommandPath -Name 'npm.exe' }
if (-not $npmPath) { throw 'npm was not found.' }

$updateRemoteUrl = Invoke-Git -Arguments @('remote', 'get-url', $Remote) -Capture
if (-not $TestMode -and -not (Test-ApprovedUpdateRemote -Url $updateRemoteUrl)) {
    throw "The selected '$Remote' remote is not an approved Feishu Codex Bridge repository; refusing to update it."
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
$dirtyState = Get-DirtyState -RuntimeDirectory $runtimeDirectory
if (-not [string]::IsNullOrWhiteSpace($dirtyState)) {
    throw 'The installation has uncommitted or untracked changes. Preserve them separately before updating; the updater will not reset or clean them.'
}
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$expectedDesktopRelayUrl = [string]$config.sessionRelay.appServerUrl
$currentDesktopRelayUrl = [Environment]::GetEnvironmentVariable(
    'CODEX_APP_SERVER_WS_URL', [EnvironmentVariableTarget]::User)
if ($TestMode -and -not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_URL)) {
    $currentDesktopRelayUrl = $env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_URL
}
$desktopRelayWasEnabled = -not [string]::IsNullOrWhiteSpace($expectedDesktopRelayUrl) -and
    $currentDesktopRelayUrl -eq $expectedDesktopRelayUrl

$desktopRelayBootstrapRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap'
$desktopRelayStatePath = Join-Path $desktopRelayBootstrapRoot 'desktop-relay-state.json'
$desktopRelayBootstrapPath = Join-Path $desktopRelayBootstrapRoot 'desktop-relay-bootstrap.ps1'
if ($TestMode) {
    if (-not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_STATE_PATH)) {
        $desktopRelayStatePath = [IO.Path]::GetFullPath($env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_STATE_PATH)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_BOOTSTRAP_PATH)) {
        $desktopRelayBootstrapPath = [IO.Path]::GetFullPath($env:FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_BOOTSTRAP_PATH)
    }
}

$savedDesktopRelayState = $null
if (Test-Path -LiteralPath $desktopRelayStatePath -PathType Leaf) {
    try {
        $savedDesktopRelayState = Get-Content -Raw -LiteralPath $desktopRelayStatePath | ConvertFrom-Json
    } catch {
        if ($desktopRelayWasEnabled -and
            -not $PSBoundParameters.ContainsKey('Proxy') -and -not $NoProxy) {
            throw 'The saved Desktop relay network selection is unreadable. Retry with an explicit -Proxy or -NoProxy choice before changing the installation.'
        }
    }
}

$desktopNetworkMode = $null
$desktopProxyUrl = $null
if ($PSBoundParameters.ContainsKey('Proxy')) {
    $desktopProxyUrl = ConvertTo-SafeLoopbackProxy -Value $Proxy
    if (-not $desktopProxyUrl) { throw '-Proxy requires a loopback URL.' }
    $desktopNetworkMode = 'proxy'
} elseif ($NoProxy) {
    $desktopNetworkMode = 'direct'
} elseif ($savedDesktopRelayState) {
    $savedExpectedUrl = [string]$savedDesktopRelayState.expectedUrl
    if (-not [string]::IsNullOrWhiteSpace($savedExpectedUrl) -and $savedExpectedUrl -ne $expectedDesktopRelayUrl) {
        throw 'The saved Desktop relay belongs to a different App Server URL. Retry with an explicit -Proxy or -NoProxy choice; the updater will not guess.'
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$savedDesktopRelayState.desktopProxyUrl)) {
        $desktopProxyUrl = ConvertTo-SafeLoopbackProxy -Value ([string]$savedDesktopRelayState.desktopProxyUrl)
        $desktopNetworkMode = 'proxy'
    } else {
        $desktopNetworkMode = 'direct'
    }
}

if ($desktopRelayWasEnabled -and -not $desktopNetworkMode) {
    throw 'Desktop relay is enabled, but its direct/proxy selection cannot be proven. Retry with -NoProxy or -Proxy <loopback-url>; the updater has not changed the installation.'
}

if ($desktopRelayWasEnabled) {
    $networkStatePath = Join-Path $runtimeDirectory 'codex-app-server-environment.json'
    $networkPidPath = Join-Path $runtimeDirectory 'codex-app-server.pid'
    $networkRecordMatches = $false
    try {
        $networkRecord = Get-Content -Raw -LiteralPath $networkStatePath | ConvertFrom-Json
        $networkProcessId = [int](Get-Content -Raw -LiteralPath $networkPidPath)
        if ([int]$networkRecord.processId -ne $networkProcessId) { throw 'App Server PID record mismatch' }
        if ($TestMode) {
            $networkProcess = Get-Process -Id $networkProcessId -ErrorAction Stop
        } else {
            $networkProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$networkProcessId" -ErrorAction Stop
            if (-not $networkProcess -or [string]$networkProcess.CommandLine -notmatch '(?i)(?:^|\s)app-server(?:\s|$)') {
                throw 'The recorded App Server process identity is invalid'
            }
        }
        if ($networkProcess -and $desktopNetworkMode -eq 'proxy') {
            $networkRecordMatches = [string]$networkRecord.mode -eq 'proxy' -and
                [string]$networkRecord.desktopProxyUrl -eq $desktopProxyUrl
        } elseif ($networkProcess) {
            $networkRecordMatches = [string]$networkRecord.mode -eq 'direct' -and
                [string]::IsNullOrWhiteSpace([string]$networkRecord.desktopProxyUrl)
        }
    } catch { }
    if (-not $networkRecordMatches) {
        throw 'Desktop relay is enabled, but the active App Server network mode does not match the preserved selection. Repair or relaunch Desktop relay with the intended -Proxy/-NoProxy mode before updating; the installation is unchanged.'
    }
}

$previousCommit = Invoke-Git -Arguments @('rev-parse', '--verify', 'HEAD') -Capture
Invoke-Git -Arguments @('fetch', '--quiet', $Remote, "refs/tags/${Version}:refs/tags/${Version}")
$targetCommit = Invoke-Git -Arguments @('rev-parse', '--verify', "refs/tags/$Version^{commit}") -Capture
$targetInstallerSource = Invoke-Git -Arguments @('show', "${targetCommit}:install.ps1") -Capture
if ($desktopRelayWasEnabled -and $previousCommit -ne $targetCommit -and
    $targetInstallerSource -notmatch '(?i)SkipDesktopRelayMigration') {
    throw 'The target release installer cannot preserve an active Desktop relay transactionally. The checkout and running Bridge are unchanged; disable Desktop relay first or choose a newer release.'
}
$bridgeWasRunning = Test-BridgeRunning -Config $config -RuntimeDirectory $runtimeDirectory
$shouldStart = $bridgeWasRunning -or $StartBridge -or $desktopRelayWasEnabled

if ($PreflightOnly) {
    Write-Output "Update preflight passed for $Version; the checkout and running services are unchanged."
    exit 0
}

if ($previousCommit -eq $targetCommit) {
    Write-Output "$Version is already installed."
    if ($shouldStart -and -not $bridgeWasRunning) {
        & (Join-Path $repositoryRoot 'start-bridge.ps1')
        $bridgeWasRunning = $true
    }
    $doctorArguments = @{}
    if ($shouldStart) { $doctorArguments['RequireRunning'] = $true }
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
        -SourceCommit $previousCommit -TargetVersion $Version `
        -DesktopRelayStatePath $desktopRelayStatePath `
        -DesktopRelayBootstrapPath $desktopRelayBootstrapPath
    Write-Output 'Created a local recovery backup of configuration, credentials, and relay state.'

    Invoke-Git -Arguments @('checkout', '--quiet', '--detach', $Version)
    $checkoutChanged = $true

    Write-Output 'Installing the dependencies pinned by the target release...'
    & $npmPath ci --prefix $repositoryRoot --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

    $targetInstaller = Join-Path $repositoryRoot 'install.ps1'
    $targetInstallerCommand = Get-Command $targetInstaller -ErrorAction Stop
    if ($desktopRelayWasEnabled -and -not $targetInstallerCommand.Parameters.ContainsKey('SkipDesktopRelayMigration')) {
        throw 'The target release installer cannot preserve an active Desktop relay transactionally. Disable Desktop relay first or choose a newer release.'
    }
    $installParameters = @{ SkipDependencyInstall = $true }
    if ($targetInstallerCommand.Parameters.ContainsKey('SkipDesktopRelayMigration')) {
        $installParameters['SkipDesktopRelayMigration'] = $true
    }
    & $targetInstaller @installParameters

    if ($shouldStart) {
        & (Join-Path $repositoryRoot 'start-bridge.ps1')
        if ($desktopRelayWasEnabled) {
            $relayConfigureParameters = @{}
            if ($desktopNetworkMode -eq 'proxy') { $relayConfigureParameters['Proxy'] = $desktopProxyUrl }
            else { $relayConfigureParameters['NoProxy'] = $true }
            & (Join-Path $repositoryRoot 'configure-codex-desktop-relay.ps1') @relayConfigureParameters
        }
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
            Restore-RecoveryBackup -BackupDirectory $backupDirectory -ConfigPath $configPath `
                -RuntimeDirectory $runtimeDirectory `
                -DesktopRelayStatePath $desktopRelayStatePath `
                -DesktopRelayBootstrapPath $desktopRelayBootstrapPath
        }
        if ($checkoutChanged) {
            & $npmPath ci --prefix $repositoryRoot --ignore-scripts=false
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed while restoring the previous release.' }
            $previousInstaller = Join-Path $repositoryRoot 'install.ps1'
            $previousInstallParameters = @{ SkipDependencyInstall = $true }
            $previousInstallerCommand = Get-Command $previousInstaller -ErrorAction Stop
            if ($previousInstallerCommand.Parameters.ContainsKey('SkipDesktopRelayMigration')) {
                $previousInstallParameters['SkipDesktopRelayMigration'] = $true
            }
            & $previousInstaller @previousInstallParameters
        }
        if ($bridgeWasRunning -or $StartBridge) {
            & (Join-Path $repositoryRoot 'start-bridge.ps1')
        }
        if ($desktopRelayWasEnabled) {
            # The preflight proves the App Server network mode before checkout,
            # and the target configure step is allowed to reuse only that exact
            # process. Restore the previous bootstrap/state without restarting
            # the App Server or silently changing its proxy selection.
            & (Join-Path $repositoryRoot 'doctor.ps1') -RequireDesktopRelay
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
