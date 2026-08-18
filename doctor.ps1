param(
    [switch]$RequireRunning,
    [switch]$RequireDesktopRelay
)

$ErrorActionPreference = 'Stop'
$checks = [Collections.Generic.List[object]]::new()

function Add-Check {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Passed,
        [Parameter(Mandatory)][string]$Detail
    )
    $script:checks.Add([pscustomobject]@{ Name = $Name; Passed = $Passed; Detail = $Detail })
}

function Invoke-LarkJson {
    param([string]$NodePath, [string]$EntryPath, [string[]]$Arguments)
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
        return (($lines | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
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

function Test-LoopbackPort {
    param([string]$HostName, [int]$Port)
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        if (-not $task.Wait(250)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
$config = $null
try {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'bridge.config.json is missing' }
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    if ([string]$config.mode -ne 'session-relay') { throw 'mode is not session-relay' }
    Add-Check -Name 'Session Relay config' -Passed $true -Detail 'present and readable'
} catch {
    Add-Check -Name 'Session Relay config' -Passed $false -Detail $_.Exception.Message
}

if ($config) {
    $nodePath = [string]$config.nodeExecutable
    try {
        if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'configured nodeExecutable does not exist' }
        $versionText = (& $nodePath --version).Trim().TrimStart('v')
        $version = [version]$versionText
        if ($version -lt [version]'22.13.0') { throw "version $versionText is older than 22.13.0" }
        Add-Check -Name 'Node.js runtime' -Passed $true -Detail "version $versionText"
    } catch {
        Add-Check -Name 'Node.js runtime' -Passed $false -Detail $_.Exception.Message
    }

    $dependencyExpectations = [ordered]@{
        '@larksuite/cli' = '1.0.86'
        '@larksuite/channel' = '0.4.1'
    }
    foreach ($dependencyName in $dependencyExpectations.Keys) {
        $packagePath = Join-Path $PSScriptRoot ("node_modules\{0}\package.json" -f $dependencyName)
        try {
            if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'not installed' }
            $installed = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
            $expected = $dependencyExpectations[$dependencyName]
            if ([string]$installed.version -ne $expected) { throw "expected $expected; found $($installed.version)" }
            Add-Check -Name "Dependency $dependencyName" -Passed $true -Detail "version $expected"
        } catch {
            Add-Check -Name "Dependency $dependencyName" -Passed $false -Detail $_.Exception.Message
        }
    }

    $larkCliEntry = [string]$config.larkCliEntry
    $codexPath = [string]$config.codexExecutable
    try {
        if (-not (Test-Path -LiteralPath $larkCliEntry -PathType Leaf)) { throw 'configured larkCliEntry does not exist' }
        $larkVersionText = (& $nodePath $larkCliEntry --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $larkVersionText -notmatch '1\.0\.86') {
            throw 'the configured Feishu CLI is not the supported 1.0.86 release'
        }
        Add-Check -Name 'Feishu CLI entry' -Passed $true -Detail 'configured entry is available at version 1.0.86'
    } catch {
        Add-Check -Name 'Feishu CLI entry' -Passed $false -Detail $_.Exception.Message
    }

    try {
        if (-not (Test-Path -LiteralPath $codexPath -PathType Leaf)) { throw 'configured codexExecutable does not exist' }
        $help = (& $codexPath app-server --help 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0 -or $help -notmatch '(?m)^\s*--listen\s+<URL>') {
            throw 'Codex App Server WebSocket listen support is unavailable'
        }
        Add-Check -Name 'Codex App Server' -Passed $true -Detail 'WebSocket listen support detected'
    } catch {
        Add-Check -Name 'Codex App Server' -Passed $false -Detail $_.Exception.Message
    }

    $runtimeDir = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
    $secretPath = Join-Path $runtimeDir 'channel-secret.dpapi'
    try {
        if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) { throw 'encrypted App Secret is missing' }
        $encrypted = (Get-Content -Raw -LiteralPath $secretPath).Trim()
        $secure = ConvertTo-SecureString $encrypted
        if ($secure.Length -le 0) { throw 'encrypted App Secret is empty' }
        $secure.Dispose()
        Add-Check -Name 'DPAPI App Secret' -Passed $true -Detail 'present and decryptable for the current Windows user'
    } catch {
        Add-Check -Name 'DPAPI App Secret' -Passed $false -Detail $_.Exception.Message
    }

    $configuredHome = [Environment]::GetEnvironmentVariable('FEISHU_CODEX_BRIDGE_HOME', [EnvironmentVariableTarget]::User)
    $expectedHome = [IO.Path]::GetFullPath($PSScriptRoot)
    $homeMatches = $false
    if ($configuredHome) {
        try { $homeMatches = ([IO.Path]::GetFullPath($configuredHome) -ieq $expectedHome) } catch { $homeMatches = $false }
    }
    Add-Check -Name 'Bridge installation pointer' -Passed $homeMatches `
        -Detail $(if ($homeMatches) { 'user environment points to this release' } else { 'FEISHU_CODEX_BRIDGE_HOME is missing or points elsewhere' })

    $expectedAppServerUrl = [string]$config.sessionRelay.appServerUrl
    $configuredAppServerUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', [EnvironmentVariableTarget]::User)
    $appServerMatches = -not [string]::IsNullOrWhiteSpace($expectedAppServerUrl) -and $configuredAppServerUrl -eq $expectedAppServerUrl
    $relayActivationDeferred = -not $RequireDesktopRelay -and [string]::IsNullOrWhiteSpace($configuredAppServerUrl)
    $relayPointerReady = $appServerMatches -or $relayActivationDeferred
    Add-Check -Name 'Codex Desktop relay pointer' -Passed $relayPointerReady `
        -Detail $(if ($appServerMatches) {
            'user environment is configured'
        } elseif ($relayActivationDeferred) {
            'disabled while the Bridge is stopped or before final Desktop relay activation'
        } else {
            'missing or points elsewhere; start the Bridge, then configure Desktop relay if recovery is not installed'
        })

    $taskName = 'FeishuCodexBridge-DesktopRelay-Watchdog'
    $bootstrapRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap'
    $stableBootstrapPath = Join-Path $bootstrapRoot 'desktop-relay-bootstrap.ps1'
    $relayStatePath = Join-Path $bootstrapRoot 'desktop-relay-state.json'
    $watchdogStatusPath = Join-Path $bootstrapRoot 'desktop-relay-watchdog-status.json'
    $relayTaskReady = $false
    $watchdogHeartbeatReady = $false
    try {
        if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
            throw 'Windows Task Scheduler commands are unavailable'
        }
        $relayTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $actionMatches = @($relayTask.Actions | Where-Object {
            ([string]$_.Arguments).IndexOf($stableBootstrapPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }).Count -gt 0
        $relayTaskReady = $actionMatches -and [string]$relayTask.State -ne 'Disabled' -and
            (Test-Path -LiteralPath $stableBootstrapPath -PathType Leaf)
        if (-not $relayTaskReady) { throw 'the task action, state, or stable bootstrap file is invalid' }

        if (-not (Test-Path -LiteralPath $relayStatePath -PathType Leaf)) {
            throw 'the Desktop relay activation state is missing'
        }
        if (-not (Test-Path -LiteralPath $watchdogStatusPath -PathType Leaf)) {
            throw 'the watchdog heartbeat is missing'
        }
        $relayState = Get-Content -Raw -LiteralPath $relayStatePath | ConvertFrom-Json
        $watchdogStatus = Get-Content -Raw -LiteralPath $watchdogStatusPath | ConvertFrom-Json
        $heartbeatAt = [DateTime]::Parse([string]$watchdogStatus.heartbeatAt).ToUniversalTime()
        $heartbeatAgeSeconds = ([DateTime]::UtcNow - $heartbeatAt).TotalSeconds
        $bridgeEnabledProperty = $relayState.PSObject.Properties['bridgeEnabled']
        $bridgeEnabled = -not $bridgeEnabledProperty -or [bool]$bridgeEnabledProperty.Value
        $watchdogHeartbeatReady = [bool]$relayState.enabled -and $bridgeEnabled -and
            [string]$relayState.expectedUrl -eq $expectedAppServerUrl -and
            [string]$watchdogStatus.activationId -eq [string]$relayState.activationId -and
            [string]$watchdogStatus.state -eq 'ready' -and
            $heartbeatAgeSeconds -ge -5 -and $heartbeatAgeSeconds -le 20
        if (-not $watchdogHeartbeatReady) {
            throw 'the watchdog heartbeat is stale, degraded, or belongs to another activation'
        }
        $taskDetail = 'continuous fail-open watchdog is installed and publishing a fresh heartbeat'
    } catch {
        $taskDetail = $_.Exception.Message
    }
    $relayTaskCheckPassed = ($relayTaskReady -and $watchdogHeartbeatReady) -or $relayActivationDeferred
    Add-Check -Name 'Desktop relay continuous watchdog' -Passed $relayTaskCheckPassed `
        -Detail $(if ($relayTaskReady -and $watchdogHeartbeatReady) {
            $taskDetail
        } elseif ($relayActivationDeferred) {
            'paused or not installed; allowed while the Bridge is stopped or before final activation'
        } else {
            "not ready: $taskDetail"
        })

    $appServerListening = $false
    $appServerProcessVerified = $false
    try {
        $appServerUri = [Uri]$expectedAppServerUrl
        $appServerListening = Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port
        $appServerPidPath = Join-Path $runtimeDir 'codex-app-server.pid'
        if ($appServerListening -and (Test-Path -LiteralPath $appServerPidPath -PathType Leaf)) {
            $appServerProcessId = 0
            $pidText = (Get-Content -Raw -LiteralPath $appServerPidPath).Trim()
            if ([int]::TryParse($pidText, [ref]$appServerProcessId)) {
                $appServerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $appServerProcessId" -ErrorAction SilentlyContinue
                if ($appServerProcess) {
                    $expectedCodexPath = [IO.Path]::GetFullPath($codexPath)
                    $actualCodexPath = if ($appServerProcess.ExecutablePath) {
                        [IO.Path]::GetFullPath([string]$appServerProcess.ExecutablePath)
                    } else { '' }
                    $commandLine = [string]$appServerProcess.CommandLine
                    $appServerProcessVerified = $actualCodexPath -ieq $expectedCodexPath -and
                        $commandLine -match '(?i)\bapp-server\b' -and
                        $commandLine -match [regex]::Escape(":$($appServerUri.Port)")
                }
            }
        }
    } catch {
        $appServerListening = $false
        $appServerProcessVerified = $false
    }
    $listenerCheckPassed = ($appServerListening -and $appServerProcessVerified) -or $relayActivationDeferred
    Add-Check -Name 'Shared App Server listener' -Passed $listenerCheckPassed `
        -Detail $(if ($appServerListening -and $appServerProcessVerified) {
            'verified Codex App Server process owns the accepting loopback listener'
        } elseif ($relayActivationDeferred) {
            'not required while the Bridge is stopped or before final Desktop relay activation'
        } else {
            'listener is missing or not owned by the configured Codex executable'
        })

    $appServerEnvironmentPath = Join-Path $runtimeDir 'codex-app-server-environment.json'
    $appServerNetworkReady = $false
    try {
        if (-not ($appServerListening -and $appServerProcessVerified)) {
            throw 'the verified shared App Server is not running'
        }
        if (-not (Test-Path -LiteralPath $appServerEnvironmentPath -PathType Leaf)) {
            throw 'the App Server network-mode record is missing; reconfigure Desktop relay networking'
        }
        $networkState = Get-Content -Raw -LiteralPath $appServerEnvironmentPath | ConvertFrom-Json
        if ([int]$networkState.processId -ne $appServerProcessId) {
            throw 'the App Server network-mode record belongs to another process'
        }
        $expectedDesktopProxyUrl = if ($relayState) { [string]$relayState.desktopProxyUrl } else { '' }
        if ([string]::IsNullOrWhiteSpace($expectedDesktopProxyUrl)) {
            $appServerNetworkReady = [string]$networkState.mode -eq 'direct' -and
                [string]::IsNullOrWhiteSpace([string]$networkState.desktopProxyUrl)
        } else {
            $appServerNetworkReady = [string]$networkState.mode -eq 'proxy' -and
                [string]$networkState.desktopProxyUrl -eq $expectedDesktopProxyUrl
        }
        if (-not $appServerNetworkReady) {
            throw 'the shared App Server does not match the saved direct/proxy selection'
        }
        $networkDetail = if ($expectedDesktopProxyUrl) {
            'shared App Server uses the explicitly selected local proxy'
        } else {
            'shared App Server is in direct mode'
        }
    } catch {
        $networkDetail = $_.Exception.Message
    }
    $networkCheckPassed = $appServerNetworkReady -or $relayActivationDeferred
    Add-Check -Name 'Shared App Server network mode' -Passed $networkCheckPassed `
        -Detail $(if ($appServerNetworkReady) {
            $networkDetail
        } elseif ($relayActivationDeferred) {
            'not required while the Bridge is stopped or before final activation'
        } else {
            $networkDetail
        })

    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $skillRoot = Join-Path $userProfile '.agents\skills\feishu-session-bind'
    $skillReady = (Test-Path -LiteralPath (Join-Path $skillRoot 'SKILL.md') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $skillRoot 'scripts\request-binding.ps1') -PathType Leaf)
    Add-Check -Name 'Codex binding skill' -Passed $skillReady `
        -Detail $(if ($skillReady) { 'installed for the current user' } else { 'missing; run install.ps1 without -NoUserChanges' })

    if ((Test-Path -LiteralPath $nodePath -PathType Leaf) -and (Test-Path -LiteralPath $larkCliEntry -PathType Leaf)) {
        $auth = Invoke-LarkJson -NodePath $nodePath -EntryPath $larkCliEntry `
            -Arguments @('auth', 'status', '--json', '--verify')
        $appMatches = $auth -and ([string]$auth.appId -eq [string]$config.appId)
        Add-Check -Name 'Feishu application binding' -Passed ([bool]$appMatches) `
            -Detail $(if ($appMatches) { 'CLI profile matches the configured application' } else { 'CLI profile is unavailable or belongs to another application' })

        $botVerified = $auth -and $auth.identities.bot.available -and $auth.identities.bot.verified
        Add-Check -Name 'Feishu bot identity' -Passed ([bool]$botVerified) `
            -Detail $(if ($botVerified) { 'available and verified' } else { 'unavailable; check app credentials and app publication' })

        $userVerified = $auth -and $auth.identities.user.available -and $auth.identities.user.verified
        Add-Check -Name 'Feishu user identity' -Passed ([bool]$userVerified) `
            -Detail $(if ($userVerified) { 'available and verified' } else { 'unavailable; complete user OAuth' })

        $scopeText = if ($auth) { [string]$auth.identities.user.scope } else { '' }
        $scopeSet = @{}
        foreach ($scope in ($scopeText -split '[,\s]+' | Where-Object { $_ })) { $scopeSet[$scope] = $true }
        $requiredFeedScopes = @('im:feed_group_v1:read', 'im:feed_group_v1:write')
        $missingFeedScopes = @($requiredFeedScopes | Where-Object { -not $scopeSet.ContainsKey($_) })
        $feedReady = $missingFeedScopes.Count -eq 0
        Add-Check -Name 'Feishu Feed label OAuth scopes' -Passed $feedReady `
            -Detail $(if ($feedReady) { 'read and write scopes granted' } else { "missing: $($missingFeedScopes -join ', ')" })

        $requiredDocumentScopes = @('docx:document:create', 'docx:document:write_only')
        $missingDocumentScopes = @($requiredDocumentScopes | Where-Object { -not $scopeSet.ContainsKey($_) })
        $documentsReady = $missingDocumentScopes.Count -eq 0
        Add-Check -Name 'Feishu long-answer document OAuth scopes' -Passed $documentsReady `
            -Detail $(if ($documentsReady) { 'create and write scopes granted' } else { "missing: $($missingDocumentScopes -join ', ')" })

        $eventDryRun = Invoke-LarkJson -NodePath $nodePath -EntryPath $larkCliEntry `
            -Arguments @('event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--dry-run')
        $eventPreconditions = @{}
        foreach ($precondition in @($eventDryRun.data.decision.preconditions)) {
            if ($precondition -and -not [string]::IsNullOrWhiteSpace([string]$precondition.name)) {
                $eventPreconditions[[string]$precondition.name] = [string]$precondition.status
            }
        }
        $messageEventPublished = $eventPreconditions['console_event_published'] -eq 'ok'
        Add-Check -Name 'Feishu message event publication' -Passed $messageEventPublished `
            -Detail $(if ($messageEventPublished) { 'im.message.receive_v1 is published' } else { 'im.message.receive_v1 is missing or not published' })
        $messageEventScopesReady = $eventPreconditions['scopes_granted'] -eq 'ok'
        Add-Check -Name 'Feishu message event scopes' -Passed $messageEventScopesReady `
            -Detail $(if ($messageEventScopesReady) { 'event-required application scopes are active' } else { 'event-required application scopes are missing or not active' })
    }

    if ($RequireRunning) {
        try {
            $windowsPowerShell = Join-Path $PSHOME 'powershell.exe'
            if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
                $windowsPowerShell = (Get-Process -Id $PID).Path
            }
            $statusLines = & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass `
                -File (Join-Path $PSScriptRoot 'status-bridge.ps1') 2>&1
            $statusText = ($statusLines | ForEach-Object { [string]$_ }) -join ' '
            if ($LASTEXITCODE -ne 0 -or $statusText -notmatch 'connected=True') {
                throw 'Bridge is not running and connected'
            }
            Add-Check -Name 'Live Bridge connection' -Passed $true -Detail 'running and connected'
        } catch {
            Add-Check -Name 'Live Bridge connection' -Passed $false -Detail $_.Exception.Message
        }
    }
}

Write-Output ''
foreach ($check in $checks) {
    $marker = if ($check.Passed) { '[PASS]' } else { '[FAIL]' }
    Write-Output ("{0} {1}: {2}" -f $marker, $check.Name, $check.Detail)
}
$failureCount = @($checks | Where-Object { -not $_.Passed }).Count
Write-Output ''
if ($failureCount -eq 0) {
    Write-Output 'Bridge doctor: all checks passed.'
    exit 0
}
Write-Output "Bridge doctor: $failureCount check(s) failed."
Write-Output 'If Codex Desktop started these checks, set the current conversation to Full access. Approve for me handles approvals but does not remove sandbox boundaries.'
exit 1
