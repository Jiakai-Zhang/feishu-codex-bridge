param(
    [switch]$PassThru,
    [string]$Proxy,
    [switch]$NoProxy,
    [switch]$AllowProxyRestart
)

$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json not found.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if ([string]$config.mode -ne 'session-relay') {
    throw 'The shared Codex App Server is only available in session-relay mode.'
}

$projectRoot = [IO.Path]::GetFullPath([string]$config.workspace)
$runtimeDir = Join-Path $projectRoot 'work\feishu-codex-bridge'
$appServerPidPath = Join-Path $runtimeDir 'codex-app-server.pid'
$appServerEnvironmentPath = Join-Path $runtimeDir 'codex-app-server-environment.json'
$appServerStdoutPath = Join-Path $runtimeDir 'codex-app-server.stdout.log'
$appServerStderrPath = Join-Path $runtimeDir 'codex-app-server.stderr.log'
$relayStatePath = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap\desktop-relay-state.json'
$configuredCodexExecutable = [IO.Path]::GetFullPath([string]$config.codexExecutable)
$appServerUrlText = [string]$config.sessionRelay.appServerUrl

function Test-PathWithinDirectory {
    param([string]$Path, [string]$Directory)
    try {
        $fullPath = [IO.Path]::GetFullPath($Path)
        $fullDirectory = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        return $fullPath.StartsWith($fullDirectory, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Test-CodexAppServerCapability {
    param([string]$Executable)
    try {
        $help = (& $Executable app-server --help 2>&1 | Out-String)
        return $LASTEXITCODE -eq 0 -and $help -match '(?m)^\s*--listen\s+<URL>'
    } catch {
        return $false
    }
}

function Resolve-ManagedCodexExecutable {
    param([string]$ConfiguredExecutable)

    $managedRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (-not (Test-PathWithinDirectory -Path $ConfiguredExecutable -Directory $managedRoot) -or
        -not (Test-Path -LiteralPath $managedRoot -PathType Container)) {
        return $ConfiguredExecutable
    }

    $candidates = Get-ChildItem -LiteralPath $managedRoot -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending
    foreach ($candidate in $candidates) {
        $candidatePath = [IO.Path]::GetFullPath($candidate.FullName)
        $codeModeHostPath = Join-Path $candidate.DirectoryName 'codex-code-mode-host.exe'
        if (-not (Test-Path -LiteralPath $codeModeHostPath -PathType Leaf)) { continue }
        if ($candidatePath -ieq $ConfiguredExecutable) { return $candidatePath }
        if (Test-CodexAppServerCapability -Executable $candidatePath) { return $candidatePath }
    }
    return $ConfiguredExecutable
}

function Update-ConfiguredCodexExecutable {
    param([string]$PreviousExecutable, [string]$Executable)

    $rawConfig = [IO.File]::ReadAllText($configPath)
    $currentConfig = $rawConfig | ConvertFrom-Json
    $currentExecutable = [IO.Path]::GetFullPath([string]$currentConfig.codexExecutable)
    if ($currentExecutable -ieq $Executable) { return }
    if ($currentExecutable -ine $PreviousExecutable) {
        throw 'bridge.config.json changed during Codex executable selection; refusing to overwrite it.'
    }

    $propertyPattern = [regex]::new('(?m)("codexExecutable"\s*:\s*)"(?:\\.|[^"\\])*"')
    $propertyMatch = $propertyPattern.Match($rawConfig)
    if (-not $propertyMatch.Success) {
        throw 'bridge.config.json has no replaceable codexExecutable property.'
    }
    $jsonExecutable = ConvertTo-Json -InputObject $Executable -Compress
    $updatedConfig = $rawConfig.Substring(0, $propertyMatch.Index) +
        $propertyMatch.Groups[1].Value + $jsonExecutable +
        $rawConfig.Substring($propertyMatch.Index + $propertyMatch.Length)
    $temporaryPath = "$configPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporaryPath, $updatedConfig, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Request-BridgeReloadForCodexSwitch {
    $bridgePidPath = Join-Path $runtimeDir 'bridge.pid'
    $supervisorPidPath = Join-Path $runtimeDir 'bridge-supervisor.pid'
    $supervisorStopPath = Join-Path $runtimeDir 'supervisor-stop.request'
    if ((Test-Path -LiteralPath $supervisorStopPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $bridgePidPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $supervisorPidPath -PathType Leaf)) {
        return
    }

    $bridgeProcessId = 0
    $supervisorProcessId = 0
    if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $bridgePidPath).Trim(), [ref]$bridgeProcessId) -or
        -not [int]::TryParse((Get-Content -Raw -LiteralPath $supervisorPidPath).Trim(), [ref]$supervisorProcessId)) {
        return
    }
    $bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgeProcessId" -ErrorAction SilentlyContinue
    $supervisorProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$supervisorProcessId" -ErrorAction SilentlyContinue
    $expectedBridge = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'session-relay.mjs'))
    $expectedSupervisor = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'bridge-supervisor.ps1'))
    if (-not $bridgeProcess -or $bridgeProcess.Name -ne 'node.exe' -or
        [string]$bridgeProcess.CommandLine -notlike "*$expectedBridge*" -or
        -not $supervisorProcess -or $supervisorProcess.Name -ne 'powershell.exe' -or
        [string]$supervisorProcess.CommandLine -notlike "*$expectedSupervisor*") {
        return
    }

    [IO.File]::WriteAllText((Join-Path $runtimeDir 'restart.request'), "codex-executable-switch`n")
    [IO.File]::WriteAllText((Join-Path $runtimeDir 'stop.request'), "codex-executable-switch`n")
}

$codexExecutable = Resolve-ManagedCodexExecutable -ConfiguredExecutable $configuredCodexExecutable
$codexExecutableChanged = $codexExecutable -ine $configuredCodexExecutable

if (-not (Test-Path -LiteralPath $codexExecutable -PathType Leaf)) {
    throw 'The configured Codex executable does not exist.'
}
if ((Test-PathWithinDirectory -Path $codexExecutable -Directory (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin')) -and
    -not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $codexExecutable) 'codex-code-mode-host.exe') -PathType Leaf)) {
    throw 'No complete managed Codex installation is available yet.'
}
if ([string]::IsNullOrWhiteSpace($appServerUrlText)) {
    throw 'sessionRelay.appServerUrl is required.'
}
$appServerUri = [Uri]$appServerUrlText
if ($appServerUri.Scheme -ne 'ws' -or
    $appServerUri.Host -notin @('127.0.0.1', 'localhost', '::1') -or
    $appServerUri.Port -le 0 -or
    $appServerUri.AbsolutePath -ne '/rpc') {
    throw 'sessionRelay.appServerUrl must be a ws:// loopback URL ending in /rpc.'
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

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

if ($PSBoundParameters.ContainsKey('Proxy') -and $NoProxy) {
    throw '-Proxy cannot be combined with -NoProxy.'
}
$desktopProxyUrl = $null
if ($PSBoundParameters.ContainsKey('Proxy')) {
    $desktopProxyUrl = ConvertTo-SafeLoopbackProxy -Value $Proxy
    if (-not $desktopProxyUrl) { throw '-Proxy requires a loopback URL.' }
} elseif (-not $NoProxy -and (Test-Path -LiteralPath $relayStatePath -PathType Leaf)) {
    try {
        $relayState = Get-Content -Raw -LiteralPath $relayStatePath | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$relayState.desktopProxyUrl)) {
            $desktopProxyUrl = ConvertTo-SafeLoopbackProxy -Value ([string]$relayState.desktopProxyUrl)
        }
    } catch {
        throw 'The saved Desktop proxy selection is invalid; rerun configure-codex-desktop-relay.ps1 with -NoProxy or -Proxy.'
    }
}
$networkMode = if ($desktopProxyUrl) { 'proxy' } else { 'direct' }
$proxyEnvironmentNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')

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

function Get-VerifiedAppServerProcess {
    param([int]$ProcessId, [string]$Executable, [int]$Port)
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $candidate) { return $null }
    $expectedPath = [IO.Path]::GetFullPath($Executable)
    $actualPath = if ($candidate.ExecutablePath) {
        [IO.Path]::GetFullPath([string]$candidate.ExecutablePath)
    } else {
        ''
    }
    if ($actualPath -ine $expectedPath) { return $null }
    $commandLine = [string]$candidate.CommandLine
    if ($commandLine -notmatch '(?i)\bapp-server\b' -or
        $commandLine -notmatch [regex]::Escape(":$Port")) {
        return $null
    }
    return Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
}

function Stop-VerifiedAppServerProcessTree {
    param([Diagnostics.Process]$Process, [string]$Reason)

    $Process.Refresh()
    if ($Process.HasExited) { return }
    $taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $taskkill = Start-Process -FilePath $taskkillPath `
        -ArgumentList @('/PID', [string]$Process.Id, '/T', '/F') `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    $taskkillExitCode = $taskkill.ExitCode
    $Process.Refresh()
    if ($taskkillExitCode -ne 0 -and -not $Process.HasExited) {
        throw "Failed to stop the verified shared App Server process tree for $Reason."
    }
    if (-not $Process.WaitForExit(15000)) {
        throw "The verified shared App Server process tree did not stop for $Reason."
    }
}

function Find-VerifiedAppServerProcess {
    param([string]$Executable, [int]$Port)
    $leafName = [IO.Path]::GetFileName($Executable).Replace("'", "''")
    $candidates = Get-CimInstance Win32_Process -Filter "Name = '$leafName'" -ErrorAction SilentlyContinue
    foreach ($candidate in $candidates) {
        $verified = Get-VerifiedAppServerProcess -ProcessId ([int]$candidate.ProcessId) `
            -Executable $Executable -Port $Port
        if ($verified) { return $verified }
    }
    return $null
}

function Read-AppServerEnvironmentState {
    if (-not (Test-Path -LiteralPath $appServerEnvironmentPath -PathType Leaf)) { return $null }
    try { return Get-Content -Raw -LiteralPath $appServerEnvironmentPath | ConvertFrom-Json }
    catch { return $null }
}

function Test-AppServerEnvironmentState {
    param([int]$ProcessId, [AllowNull()][string]$ExpectedProxyUrl)
    $state = Read-AppServerEnvironmentState
    if (-not $state -or [int]$state.processId -ne $ProcessId) { return $false }
    $actualProxyUrl = [string]$state.desktopProxyUrl
    if ([string]::IsNullOrWhiteSpace($ExpectedProxyUrl)) {
        return [string]::IsNullOrWhiteSpace($actualProxyUrl) -and [string]$state.mode -eq 'direct'
    }
    return [string]$state.mode -eq 'proxy' -and $actualProxyUrl -eq $ExpectedProxyUrl
}

function Write-AppServerEnvironmentState {
    param([int]$ProcessId, [AllowNull()][string]$ProxyUrl)
    $state = [ordered]@{
        schemaVersion = 1
        processId = $ProcessId
        mode = $(if ($ProxyUrl) { 'proxy' } else { 'direct' })
        configuredAt = [DateTime]::UtcNow.ToString('o')
    }
    if ($ProxyUrl) { $state['desktopProxyUrl'] = $ProxyUrl }
    $temporaryPath = "$appServerEnvironmentPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText(
            $temporaryPath,
            (($state | ConvertTo-Json -Depth 3) + "`n"),
            [Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporaryPath -Destination $appServerEnvironmentPath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Start-AppServerWithNetworkEnvironment {
    param([string]$ListenUrl, [AllowNull()][string]$ProxyUrl)
    # Desktop supplies codex_app tool selections as dotted per-thread overrides.
    # Seed a disabled transport so those overrides merge into a valid MCP table.
    $desktopCodexAppTransportOverride = "mcp_servers.codex_app={command='',enabled=false}"
    $savedEnvironment = @{}
    try {
        foreach ($name in $proxyEnvironmentNames) {
            $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            if ($item) { $savedEnvironment[$name] = [string]$item.Value }
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        if ($ProxyUrl) {
            foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
                Set-Item -LiteralPath "Env:$name" -Value $ProxyUrl
            }
            Set-Item -LiteralPath 'Env:NO_PROXY' -Value '127.0.0.1,localhost,::1'
        }
        return Start-Process -FilePath $codexExecutable `
            -ArgumentList @(
                '-c', $desktopCodexAppTransportOverride,
                'app-server', '--listen', $ListenUrl
            ) `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $appServerStdoutPath `
            -RedirectStandardError $appServerStderrPath `
            -PassThru
    } finally {
        foreach ($name in $proxyEnvironmentNames) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            if ($savedEnvironment.ContainsKey($name)) {
                Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
            }
        }
    }
}

$mutex = [Threading.Mutex]::new($false, "Local\FeishuCodexBridgeAppServer-$($appServerUri.Port)")
$lockTaken = $false
try {
    try {
        $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(30))
    } catch [Threading.AbandonedMutexException] {
        $lockTaken = $true
    }
    if (-not $lockTaken) {
        throw 'Timed out waiting for another shared App Server startup attempt.'
    }

    $appServerProcess = $null
    $savedAppServerPid = 0
    if (Test-Path -LiteralPath $appServerPidPath -PathType Leaf) {
        $pidText = (Get-Content -Raw -LiteralPath $appServerPidPath).Trim()
        if ([int]::TryParse($pidText, [ref]$savedAppServerPid)) {
            $appServerProcess = Get-VerifiedAppServerProcess -ProcessId $savedAppServerPid `
                -Executable $codexExecutable -Port $appServerUri.Port
            if (-not $appServerProcess -and $codexExecutableChanged) {
                $previousAppServerProcess = Get-VerifiedAppServerProcess -ProcessId $savedAppServerPid `
                    -Executable $configuredCodexExecutable -Port $appServerUri.Port
                if ($previousAppServerProcess) {
                    Stop-VerifiedAppServerProcessTree -Process $previousAppServerProcess `
                        -Reason 'a managed Codex upgrade'
                    $portDeadline = [DateTime]::UtcNow.AddSeconds(5)
                    while ([DateTime]::UtcNow -lt $portDeadline -and
                        (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port)) {
                        Start-Sleep -Milliseconds 200
                    }
                    if (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port) {
                        throw 'The previous shared App Server listener remained active after a managed Codex upgrade.'
                    }
                    Remove-Item -LiteralPath $appServerEnvironmentPath -Force -ErrorAction SilentlyContinue
                }
            }
        }
        if (-not $appServerProcess) {
            Remove-Item -LiteralPath $appServerPidPath -Force
        }
    }

    if ($appServerProcess -and
        -not (Test-AppServerEnvironmentState -ProcessId $appServerProcess.Id -ExpectedProxyUrl $desktopProxyUrl) -and
        $AllowProxyRestart) {
        if ($savedAppServerPid -ne $appServerProcess.Id) {
            throw 'The running shared App Server was not started by this installation; refusing to restart it for a proxy change.'
        }
        Stop-VerifiedAppServerProcessTree -Process $appServerProcess -Reason 'proxy reconfiguration'
        $portDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while ([DateTime]::UtcNow -lt $portDeadline -and
            (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port)) {
            Start-Sleep -Milliseconds 200
        }
        if (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port) {
            throw 'The previous shared App Server listener remained active after proxy reconfiguration.'
        }
        Remove-Item -LiteralPath $appServerPidPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $appServerEnvironmentPath -Force -ErrorAction SilentlyContinue
        $appServerProcess = $null
    }

    $started = $false
    if (-not $appServerProcess) {
        $appServerProcess = Find-VerifiedAppServerProcess -Executable $codexExecutable -Port $appServerUri.Port
    }
    if ($appServerProcess -and $AllowProxyRestart -and
        -not (Test-AppServerEnvironmentState -ProcessId $appServerProcess.Id -ExpectedProxyUrl $desktopProxyUrl)) {
        throw 'A matching shared App Server is running without this installation ownership record; refusing to restart it for a proxy change.'
    }

    if (-not $appServerProcess) {
        if (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port) {
            throw "Port $($appServerUri.Port) is already in use by an unverified process; refusing to start the shared Codex App Server."
        }
        $listenHost = if ($appServerUri.Host -eq '::1') { '[::1]' } else { $appServerUri.Host }
        $listenUrl = "ws://${listenHost}:$($appServerUri.Port)"
        $appServerProcess = Start-AppServerWithNetworkEnvironment `
            -ListenUrl $listenUrl -ProxyUrl $desktopProxyUrl
        $started = $true
    }

    $appServerDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $appServerDeadline) {
        $appServerProcess.Refresh()
        if ($appServerProcess.HasExited) {
            Remove-Item -LiteralPath $appServerPidPath -Force -ErrorAction SilentlyContinue
            throw "Shared Codex App Server exited during startup. Check $appServerStderrPath"
        }
        if (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-LoopbackPort -HostName $appServerUri.Host -Port $appServerUri.Port)) {
        throw "Shared Codex App Server did not listen within 15 seconds. Check $appServerStderrPath"
    }

    [IO.File]::WriteAllText($appServerPidPath, [string]$appServerProcess.Id)
    if ($started) {
        Write-AppServerEnvironmentState -ProcessId $appServerProcess.Id -ProxyUrl $desktopProxyUrl
    }
    if ($codexExecutableChanged) {
        Update-ConfiguredCodexExecutable -PreviousExecutable $configuredCodexExecutable `
            -Executable $codexExecutable
        Request-BridgeReloadForCodexSwitch
    }
    if ($PassThru) {
        [pscustomobject]@{
            ProcessId = [int]$appServerProcess.Id
            AppServerUrl = $appServerUri.AbsoluteUri
            Started = $started
            NetworkMode = $networkMode
        }
    } else {
        $verb = if ($started) { 'started' } else { 'is already running' }
        Write-Output "Shared Codex App Server $verb (PID $($appServerProcess.Id), network mode $networkMode)."
    }
} finally {
    if ($lockTaken) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
