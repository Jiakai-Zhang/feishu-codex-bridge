param(
    [string]$AppId,
    [string]$OwnerOpenId,
    [string]$Workspace = (Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge'),
    [ValidateRange(1024, 65535)]
    [int]$AppServerPort = 47321,
    [string]$AgentName = 'Codex',
    [switch]$ForceConfig,
    [switch]$SkipDependencyInstall,
    [switch]$NoUserChanges,
    [switch]$SkipDesktopRelayMigration
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This beta installer supports Windows only.'
}

function Get-CommandPath {
    param([Parameter(Mandatory)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    if ($command.Source) { return [IO.Path]::GetFullPath([string]$command.Source) }
    if ($command.Path) { return [IO.Path]::GetFullPath([string]$command.Path) }
    return $null
}

function Invoke-LarkJson {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$EntryPath,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $proxyNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
    $savedEnvironment = @{}
    try {
        foreach ($name in $proxyNames) {
            $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            if ($item) { $savedEnvironment[$name] = [string]$item.Value }
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        $lines = & $NodePath $EntryPath @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        $text = ($lines | ForEach-Object { [string]$_ }) -join "`n"
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return $text | ConvertFrom-Json
    } catch {
        return $null
    } finally {
        foreach ($name in $proxyNames) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            if ($savedEnvironment.ContainsKey($name)) {
                Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
            }
        }
    }
}

function Find-CodexExecutable {
    param([string]$ConfiguredPath)

    $candidates = [Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($ConfiguredPath)) { $candidates.Add($ConfiguredPath) }
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_EXECUTABLE)) { $candidates.Add($env:CODEX_EXECUTABLE) }

    $managedRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $managedRoot -PathType Container) {
        Get-ChildItem -LiteralPath $managedRoot -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            ForEach-Object { $candidates.Add($_.FullName) }
    }
    $commandPath = Get-CommandPath -Name 'codex.exe'
    if ($commandPath) { $candidates.Add($commandPath) }

    $seen = @{}
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        try { $fullPath = [IO.Path]::GetFullPath($candidate) } catch { continue }
        if ($seen.ContainsKey($fullPath)) { continue }
        $seen[$fullPath] = $true
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
        try {
            $help = (& $fullPath app-server --help 2>&1 | Out-String)
            if ($LASTEXITCODE -eq 0 -and $help -match '(?m)^\s*--listen\s+<URL>') {
                return $fullPath
            }
        } catch {
            continue
        }
    }
    return $null
}

$nodePath = Get-CommandPath -Name 'node.exe'
if (-not $nodePath) {
    throw 'Node.js was not found. Install Node.js 22.13 or newer, then reopen PowerShell.'
}
$nodeVersionText = (& $nodePath --version).Trim().TrimStart('v')
try { $nodeVersion = [version]$nodeVersionText } catch { throw "Could not parse Node.js version: $nodeVersionText" }
if ($nodeVersion -lt [version]'22.13.0') {
    throw "Node.js 22.13 or newer is required; found $nodeVersionText."
}

$npmPath = Get-CommandPath -Name 'npm.cmd'
if (-not $npmPath) { $npmPath = Get-CommandPath -Name 'npm.exe' }
if (-not $npmPath) { throw 'npm was not found next to the Node.js installation.' }

if (-not $SkipDependencyInstall) {
    Write-Output 'Installing pinned repository dependencies...'
    & $npmPath ci --prefix $PSScriptRoot --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
}

$larkCliEntry = Join-Path $PSScriptRoot 'node_modules\@larksuite\cli\scripts\run.js'
if (-not (Test-Path -LiteralPath $larkCliEntry -PathType Leaf)) {
    throw 'The pinned Feishu CLI dependency is missing. Run npm ci and try again.'
}

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
$existingConfig = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $existingConfig = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    if (-not $ForceConfig -and [string]$existingConfig.mode -ne 'session-relay') {
        throw 'The existing bridge.config.json is not a Session Relay config. Use a separate checkout or review it before replacing it.'
    }
}

$configuredCodexPath = if ($existingConfig) { [string]$existingConfig.codexExecutable } else { '' }
$codexPath = Find-CodexExecutable -ConfiguredPath $configuredCodexPath
if (-not $codexPath) {
    throw 'A Codex executable with WebSocket App Server support was not found. Install or update Codex Desktop, then retry.'
}

if ($existingConfig -and -not $ForceConfig) {
    Write-Output 'Keeping the existing Session Relay configuration.'
} else {
    $authStatus = $null
    if ([string]::IsNullOrWhiteSpace($AppId) -or [string]::IsNullOrWhiteSpace($OwnerOpenId)) {
        Write-Output 'Reading the verified local Feishu CLI identity...'
        $authStatus = Invoke-LarkJson -NodePath $nodePath -EntryPath $larkCliEntry `
            -Arguments @('auth', 'status', '--json', '--verify')
    }
    if ([string]::IsNullOrWhiteSpace($AppId) -and $authStatus -and $authStatus.appId) {
        $AppId = [string]$authStatus.appId
    }
    if ([string]::IsNullOrWhiteSpace($OwnerOpenId) -and $authStatus -and $authStatus.identities.user.verified) {
        $OwnerOpenId = [string]$authStatus.identities.user.openId
    }
    if ([string]::IsNullOrWhiteSpace($OwnerOpenId)) {
        $whoami = Invoke-LarkJson -NodePath $nodePath -EntryPath $larkCliEntry -Arguments @('whoami', '--as', 'user')
        if ($whoami -and $whoami.available) { $OwnerOpenId = [string]$whoami.onBehalfOf.openId }
        if ([string]::IsNullOrWhiteSpace($AppId) -and $whoami) { $AppId = [string]$whoami.appId }
    }
    if ($AppId -notmatch '^cli_[A-Za-z0-9_-]+$') {
        throw 'A valid Feishu App ID was not supplied or discovered. Complete the Feishu CLI app setup first.'
    }
    if ($OwnerOpenId -notmatch '^ou_[A-Za-z0-9_-]+$') {
        throw 'A verified Feishu user identity was not supplied or discovered. Complete user OAuth first.'
    }

    $botOpenId = ''
    if ($authStatus -and $authStatus.identities.bot.verified) {
        $botOpenId = [string]$authStatus.identities.bot.openId
    }
    $agentConfig = [ordered]@{
        ownerOpenId = $OwnerOpenId
    }
    if ($botOpenId -match '^ou_[A-Za-z0-9_-]+$') {
        $agentConfig['botOpenId'] = $botOpenId
    }

    $resolvedWorkspace = [IO.Path]::GetFullPath($Workspace)
    New-Item -ItemType Directory -Force -Path $resolvedWorkspace | Out-Null
    $config = [ordered]@{
        schemaVersion = 4
        mode = 'session-relay'
        appId = $AppId
        workspace = $resolvedWorkspace
        agent = $agentConfig
        sessionRelay = [ordered]@{
            nameSync = 'none'
            appServerUrl = "ws://127.0.0.1:$AppServerPort/rpc"
            displayTimeZone = 'Asia/Shanghai'
            promptPreviewChars = 4000
            feedGroup = [ordered]@{
                enabled = $true
                agentName = $AgentName
            }
            bindings = @()
        }
        nodeExecutable = $nodePath
        larkCliEntry = [IO.Path]::GetFullPath($larkCliEntry)
        codexExecutable = $codexPath
        sandboxMode = 'workspace-write'
        completionPollMs = 30000
        completionStableMs = 15000
        httpTimeoutMs = 20000
        handshakeTimeoutMs = 20000
        deliveryRetryMs = 60000
        maxInputChars = 12000
        maxReplyChars = 10000
    }
    $json = $config | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($configPath, $json + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output 'Created the local Session Relay configuration without exposing account identifiers.'
}

if (-not $NoUserChanges) {
    $homeVariable = 'FEISHU_CODEX_BRIDGE_HOME'
    $repositoryRoot = [IO.Path]::GetFullPath($PSScriptRoot)
    $existingHome = [Environment]::GetEnvironmentVariable($homeVariable, [EnvironmentVariableTarget]::User)
    if ($existingHome -and ([IO.Path]::GetFullPath($existingHome) -ine $repositoryRoot) -and -not $ForceConfig) {
        throw "$homeVariable already points to a different installation. Re-run with -ForceConfig only after reviewing that installation."
    }
    [Environment]::SetEnvironmentVariable($homeVariable, $repositoryRoot, [EnvironmentVariableTarget]::User)
    [Environment]::SetEnvironmentVariable($homeVariable, $repositoryRoot, [EnvironmentVariableTarget]::Process)

    $skillSource = Join-Path $PSScriptRoot 'skills\feishu-session-bind'
    if (-not (Test-Path -LiteralPath $skillSource -PathType Container)) {
        throw 'The portable feishu-session-bind skill is missing from this release.'
    }
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $skillTarget = Join-Path $userProfile '.agents\skills\feishu-session-bind'
    New-Item -ItemType Directory -Force -Path (Join-Path $skillTarget 'agents') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $skillTarget 'scripts') | Out-Null
    Copy-Item -LiteralPath (Join-Path $skillSource 'SKILL.md') -Destination (Join-Path $skillTarget 'SKILL.md') -Force
    Copy-Item -LiteralPath (Join-Path $skillSource 'agents\openai.yaml') -Destination (Join-Path $skillTarget 'agents\openai.yaml') -Force
    Copy-Item -LiteralPath (Join-Path $skillSource 'scripts\request-binding.ps1') -Destination (Join-Path $skillTarget 'scripts\request-binding.ps1') -Force
    Write-Output 'Installed the user-level Codex session binding skill.'

    # Existing installations may already have the Desktop relay pointer. Repair
    # those installations in place by adding the continuous fail-open watchdog.
    # A fresh install deliberately leaves Codex Desktop untouched until the App
    # Secret, Bridge, and shared App Server have all been verified.
    $effectiveConfig = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $expectedRelayUrl = [string]$effectiveConfig.sessionRelay.appServerUrl
    $currentRelayUrl = [Environment]::GetEnvironmentVariable(
        'CODEX_APP_SERVER_WS_URL', [EnvironmentVariableTarget]::User)
    if (-not $SkipDesktopRelayMigration -and
        -not [string]::IsNullOrWhiteSpace($currentRelayUrl) -and $currentRelayUrl -eq $expectedRelayUrl) {
        try {
            & (Join-Path $PSScriptRoot 'configure-codex-desktop-relay.ps1')
            Write-Output 'Migrated the existing Desktop relay activation to the continuous fail-open watchdog.'
        } catch {
            Write-Warning 'The existing Desktop relay could not be continuously guarded, so its pointer was disabled. The Bridge installation can continue; rerun configure-codex-desktop-relay.ps1 after correcting the reported startup issue.'
        }
    }
}

Write-Output ''
Write-Output 'Local installation is prepared.'
$effectiveConfig = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$effectiveRuntimeDir = Join-Path ([string]$effectiveConfig.workspace) 'work\feishu-codex-bridge'
$effectiveSecretPath = Join-Path $effectiveRuntimeDir 'channel-secret.dpapi'
if (Test-Path -LiteralPath $effectiveSecretPath -PathType Leaf) {
    Write-Output 'The preconfigured DPAPI Channel Secret is available in the selected runtime workspace.'
} else {
    Write-Warning 'The DPAPI Channel Secret is missing from the selected runtime workspace. Run setup-channel-secret.ps1 before starting the Bridge.'
}
Write-Output 'Next: start the Bridge, configure Desktop relay networking, then complete strict Doctor and real message tests.'
if (-not $NoUserChanges) {
    Write-Output 'After the Bridge is connected, choose direct or local-proxy mode, fully exit Codex Desktop, then run launch-codex-desktop-with-relay.ps1.'
    Write-Output 'A fresh install does not change Codex Desktop until that final activation succeeds.'
}
