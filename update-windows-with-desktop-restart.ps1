param(
    [ValidatePattern('^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$')]
    [string]$Version,
    [string]$InstallRoot,
    [ValidateSet('origin', 'private')]
    [string]$Remote = 'origin',
    [switch]$Worker,
    [ValidatePattern('^[0-9a-f]{32}$')]
    [string]$RunId,
    [switch]$TestMode
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This foreground updater supports Windows only.'
}

$scriptPath = [IO.Path]::GetFullPath([string]$MyInvocation.MyCommand.Path)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $scriptPath
}
$repositoryRoot = [IO.Path]::GetFullPath($InstallRoot)
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
    throw 'Windows PowerShell was not found.'
}

$stateRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\foreground-upgrade'
if ($TestMode) {
    if ($env:FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST -ne '1' -or
        [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST_ROOT)) {
        throw 'TestMode is restricted to the foreground updater smoke test.'
    }
    $temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $testRoot = [IO.Path]::GetFullPath($env:FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST_ROOT)
    $testLeaf = Split-Path -Leaf $testRoot
    if (-not $testRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -or
        $testLeaf -notlike 'feishu-bridge-foreground-*') {
        throw 'TestMode is restricted to a verified temporary directory.'
    }
    $stateRoot = Join-Path $testRoot 'foreground-state'
}
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null

function Get-RequestPath {
    param([Parameter(Mandatory)][string]$Id)
    return Join-Path $stateRoot "$Id.request.json"
}

function Get-StatusPath {
    param([Parameter(Mandatory)][string]$Id)
    return Join-Path $stateRoot "$Id.status.json"
}

function Write-RunStatus {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$TargetVersion,
        [Parameter(Mandatory)][string]$State,
        [Parameter(Mandatory)][string]$Detail,
        [AllowNull()][object]$Succeeded = $null
    )
    $status = [ordered]@{
        schemaVersion = 1
        runId = $Id
        targetVersion = $TargetVersion
        state = $State
        detail = $Detail
        updatedAt = [DateTime]::UtcNow.ToString(
            "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
            [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($null -ne $Succeeded) { $status['succeeded'] = [bool]$Succeeded }
    $statusPath = Get-StatusPath -Id $Id
    $temporaryPath = "$statusPath.$PID.tmp"
    try {
        [IO.File]::WriteAllText(
            $temporaryPath,
            (($status | ConvertTo-Json -Depth 4) + "`n"),
            [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $statusPath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$Capture
    )
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & git -C $repositoryRoot @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { throw "git $($Arguments[0]) failed." }
    if ($Capture) {
        return (($lines | ForEach-Object { [string]$_ }) -join "`n").Trim()
    }
}

function Test-ApprovedUpdateRemote {
    param([Parameter(Mandatory)][string]$Url)
    if ($TestMode) { return $true }
    return $Url -match '(?i)^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)(?:(?:ninmon|Jiakai-Zhang)/feishu-codex-bridge|ninmon/feishu-codex-bridge-private)(?:\.git)?/?$'
}

function Get-RunningDesktopProcesses {
    if ($TestMode) {
        $marker = Join-Path $stateRoot 'desktop-running'
        if (Test-Path -LiteralPath $marker -PathType Leaf) {
            return @([pscustomobject]@{ ProcessId = 1 })
        }
        return @()
    }
    $results = @()
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if ([string]$process.Name -notmatch '(?i)(ChatGPT|Codex).*\.exe$') { continue }
        if ([string]$process.CommandLine -match '(?i)\bapp-server\b') { continue }
        $results += $process
    }
    return @($results)
}

function Get-RelayStatePath {
    if ($TestMode -and
        -not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST_RELAY_STATE)) {
        return [IO.Path]::GetFullPath($env:FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE_TEST_RELAY_STATE)
    }
    return Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge\bootstrap\desktop-relay-state.json'
}

function Get-SavedDesktopNetwork {
    $configPath = Join-Path $repositoryRoot 'bridge.config.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'bridge.config.json is missing.'
    }
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $expectedUrl = [string]$config.sessionRelay.appServerUrl
    $relayStatePath = Get-RelayStatePath
    if (-not (Test-Path -LiteralPath $relayStatePath -PathType Leaf)) {
        throw 'The saved Desktop relay state is missing.'
    }
    $relayState = Get-Content -Raw -LiteralPath $relayStatePath | ConvertFrom-Json
    if (-not [bool]$relayState.enabled -or
        [string]$relayState.expectedUrl -ne $expectedUrl) {
        throw 'The saved Desktop relay state does not match this installation.'
    }
    $proxyUrl = ([string]$relayState.desktopProxyUrl).Trim().TrimEnd('/')
    if (-not [string]::IsNullOrWhiteSpace($proxyUrl)) {
        if ($proxyUrl -notmatch '^(?i)(https?|socks4|socks5)://(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$') {
            throw 'The saved Desktop proxy is not an unauthenticated loopback URL.'
        }
        return [pscustomobject]@{ Mode = 'proxy'; ProxyUrl = $proxyUrl }
    }
    return [pscustomobject]@{ Mode = 'direct'; ProxyUrl = $null }
}

function Invoke-StrictDoctor {
    $doctorPath = Join-Path $repositoryRoot 'doctor.ps1'
    if (-not (Test-Path -LiteralPath $doctorPath -PathType Leaf)) {
        throw 'doctor.ps1 is missing.'
    }
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        if (-not $TestMode) {
            $config = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'bridge.config.json') | ConvertFrom-Json
            $expectedUrl = [string]$config.sessionRelay.appServerUrl
            $pointerDeadline = [DateTime]::UtcNow.AddSeconds(20)
            do {
                $configuredUrl = [Environment]::GetEnvironmentVariable(
                    'CODEX_APP_SERVER_WS_URL', [EnvironmentVariableTarget]::User)
                if (-not [string]::IsNullOrWhiteSpace($expectedUrl) -and $configuredUrl -eq $expectedUrl) {
                    break
                }
                Start-Sleep -Milliseconds 500
            } while ([DateTime]::UtcNow -lt $pointerDeadline)
            if ($configuredUrl -ne $expectedUrl) {
                throw 'The Desktop relay pointer did not recover before strict Doctor.'
            }
        }
        & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File $doctorPath -RequireRunning -RequireDesktopRelay
        if ($LASTEXITCODE -eq 0) { return }
        if ($attempt -lt 2) {
            Write-Host 'Strict Doctor saw a transient relay state; waiting once for the watchdog to settle.' -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        }
    }
    throw 'Strict Doctor failed.'
}

function Invoke-DesktopLauncher {
    param([Parameter(Mandatory)][object]$Network)
    $launcherPath = Join-Path $repositoryRoot 'launch-codex-desktop-with-relay.ps1'
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw 'The target release has no Desktop relay launcher.'
    }
    if ([string]$Network.Mode -eq 'proxy') {
        & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File $launcherPath -Proxy ([string]$Network.ProxyUrl)
    } else {
        & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File $launcherPath -NoProxy
    }
    if ($LASTEXITCODE -ne 0) { throw 'Desktop relay launcher failed.' }
}

function Invoke-TargetUpdater {
    param(
        [Parameter(Mandatory)][string]$UpdaterPath,
        [Parameter(Mandatory)][hashtable]$Parameters
    )
    $arguments = [Collections.Generic.List[string]]::new()
    foreach ($name in @('InstallRoot', 'Version', 'Remote')) {
        if (-not $Parameters.ContainsKey($name)) { continue }
        $arguments.Add("-$name")
        $arguments.Add([string]$Parameters[$name])
    }
    foreach ($name in @('PreflightOnly', 'TestMode')) {
        if ([bool]$Parameters[$name]) { $arguments.Add("-$name") }
    }
    & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File $UpdaterPath @arguments
    if ($LASTEXITCODE -ne 0) { throw 'The target updater failed.' }
}

function ConvertTo-SafeFailureText {
    param([Parameter(Mandatory)][string]$Text)
    $safe = $Text
    foreach ($path in @($repositoryRoot, $stateRoot, $scriptPath)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$path)) {
            $safe = $safe.Replace([string]$path, '<local-path>')
        }
    }
    return $safe
}

function Start-ForegroundWorker {
    if ([string]::IsNullOrWhiteSpace($Version)) {
        throw '-Version is required.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot '.git'))) {
        throw 'InstallRoot is not a Git checkout of Feishu Codex Bridge.'
    }

    $newRunId = [guid]::NewGuid().ToString('N')
    $taskName = if ($TestMode) { '' } else { "FeishuCodexBridge-ForegroundUpgrade-$newRunId" }
    $request = [ordered]@{
        schemaVersion = 1
        runId = $newRunId
        version = $Version
        remote = $Remote
        installRoot = $repositoryRoot
        taskName = $taskName
    }
    $requestPath = Get-RequestPath -Id $newRunId
    [IO.File]::WriteAllText(
        $requestPath,
        (($request | ConvertTo-Json -Depth 3) + "`n"),
        [Text.UTF8Encoding]::new($false))

    try {
        if ($TestMode) {
            $workerArguments = @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath,
                '-Worker', '-RunId', $newRunId, '-TestMode'
            )
            Start-Process -FilePath $windowsPowerShell -ArgumentList $workerArguments `
                -WorkingDirectory $repositoryRoot -WindowStyle Hidden | Out-Null
        } else {
            foreach ($staleTask in @(Get-ScheduledTask -TaskName 'FeishuCodexBridge-ForegroundUpgrade-*' -ErrorAction SilentlyContinue)) {
                if ([string]$staleTask.State -eq 'Running') {
                    throw 'Another foreground Bridge upgrade is still active. Use its visible PowerShell window instead of starting a second update.'
                }
                Unregister-ScheduledTask -TaskName ([string]$staleTask.TaskName) -Confirm:$false -ErrorAction SilentlyContinue
            }
            $actionArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Worker -RunId $newRunId"
            $action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $actionArguments -WorkingDirectory $repositoryRoot
            $principal = New-ScheduledTaskPrincipal `
                -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
                -LogonType Interactive -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries `
                -StartWhenAvailable `
                -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
                -MultipleInstances IgnoreNew
            $definition = New-ScheduledTask -Action $action -Principal $principal -Settings $settings `
                -Description 'Runs one visible transactional Bridge update and restarts Codex Desktop.'
            Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
            Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
        }

        $workerStartedAt = [DateTime]::UtcNow
        $deadline = $workerStartedAt.AddMinutes(3)
        while ([DateTime]::UtcNow -lt $deadline) {
            $statusPath = Get-StatusPath -Id $newRunId
            if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
                $status = $null
                try {
                    $status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
                } catch { }
                if ($status) {
                    if ([string]$status.state -eq 'waiting-for-desktop-exit') {
                        Write-Output 'Foreground upgrade is ready. Fully exit ChatGPT/Codex Desktop; the visible PowerShell will update, relaunch, and verify it.'
                        return
                    }
                    if ([string]$status.state -eq 'completed') {
                        Write-Output 'Foreground upgrade completed before a Desktop exit wait was needed.'
                        return
                    }
                    if ([string]$status.state -eq 'failed') {
                        throw ([string]$status.detail)
                    }
                }
            }
            if (-not $TestMode) {
                $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
                if (-not $task) { throw 'The foreground upgrade task exited before it became ready.' }
                if ([DateTime]::UtcNow -ge $workerStartedAt.AddSeconds(5) -and
                    [string]$task.State -ne 'Running') {
                    throw 'The foreground upgrade task stopped before it became ready.'
                }
            }
            Start-Sleep -Milliseconds 250
        }
        throw 'The foreground upgrade did not become ready within three minutes.'
    } catch {
        if (-not $TestMode) {
            try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
            try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
        }
        Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Invoke-ForegroundWorker {
    if ([string]::IsNullOrWhiteSpace($RunId)) { throw '-RunId is required in Worker mode.' }
    $requestPath = Get-RequestPath -Id $RunId
    if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) {
        throw 'The foreground upgrade request is missing.'
    }
    $request = Get-Content -Raw -LiteralPath $requestPath | ConvertFrom-Json
    $requestVersion = [string]$request.version
    $requestRemote = [string]$request.remote
    $requestTaskName = [string]$request.taskName
    if ([int]$request.schemaVersion -ne 1 -or [string]$request.runId -ne $RunId -or
        $requestVersion -notmatch '^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$' -or
        $requestRemote -notin @('origin', 'private') -or
        (-not $TestMode -and $requestTaskName -ne "FeishuCodexBridge-ForegroundUpgrade-$RunId") -or
        ($TestMode -and -not [string]::IsNullOrWhiteSpace($requestTaskName))) {
        throw 'The foreground upgrade request identity is invalid.'
    }
    $script:Version = $requestVersion
    $script:Remote = $requestRemote
    $script:repositoryRoot = [IO.Path]::GetFullPath([string]$request.installRoot)
    $taskName = $requestTaskName
    $temporaryUpdaterPath = Join-Path $stateRoot "$RunId.update.ps1"
    $network = $null
    $desktopExited = $false
    $failure = $null

    try {
        try { $Host.UI.RawUI.WindowTitle = "Feishu Codex Bridge upgrade $Version" } catch { }
        Write-Host 'Feishu Codex Bridge foreground upgrade' -ForegroundColor Cyan
        Write-Host 'Running safety preflight. Keep Codex Desktop open until this window asks you to exit.'
        Write-RunStatus -Id $RunId -TargetVersion $Version -State 'preflighting' `
            -Detail 'Checking the exact release, worktree, relay, and network state.'

        if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot '.git'))) {
            throw 'The recorded installation is not a Git checkout.'
        }
        $remoteUrl = Invoke-Git -Arguments @('remote', 'get-url', $Remote) -Capture
        if (-not (Test-ApprovedUpdateRemote -Url $remoteUrl)) {
            throw 'The selected update remote is not an approved Bridge repository.'
        }
        Invoke-Git -Arguments @('fetch', '--quiet', $Remote, "refs/tags/${Version}:refs/tags/${Version}")
        $targetCommit = Invoke-Git -Arguments @('rev-parse', '--verify', "refs/tags/$Version^{commit}") -Capture
        $updaterSource = Invoke-Git -Arguments @('show', "${targetCommit}:update.ps1") -Capture
        if ($updaterSource -notmatch '(?i)PreflightOnly' -or
            $updaterSource -notmatch "ValidateSet\('origin', 'private'\)") {
            throw 'The target release updater does not support the foreground transaction contract.'
        }
        [IO.File]::WriteAllText(
            $temporaryUpdaterPath,
            ($updaterSource + "`n"),
            [Text.UTF8Encoding]::new($true))

        $preflightParameters = @{
            InstallRoot = $repositoryRoot
            Version = $Version
            Remote = $Remote
            PreflightOnly = $true
        }
        if ($TestMode) { $preflightParameters['TestMode'] = $true }
        Invoke-StrictDoctor
        Invoke-TargetUpdater -UpdaterPath $temporaryUpdaterPath -Parameters $preflightParameters
        $network = Get-SavedDesktopNetwork

        Write-RunStatus -Id $RunId -TargetVersion $Version -State 'waiting-for-desktop-exit' `
            -Detail 'Preflight passed; waiting for the user to fully exit Desktop.'
        Write-Host ''
        Write-Host 'Preflight passed.' -ForegroundColor Green
        Write-Host 'Now fully exit ChatGPT/Codex Desktop. Do not reopen it yourself.' -ForegroundColor Yellow
        Write-Host 'This window will continue the update and reopen Desktop automatically.'

        $exitDeadline = [DateTime]::UtcNow.AddMinutes(30)
        while (@(Get-RunningDesktopProcesses).Count -gt 0) {
            if ([DateTime]::UtcNow -ge $exitDeadline) {
                throw 'Desktop did not fully exit within 30 minutes.'
            }
            Start-Sleep -Milliseconds 500
        }
        Start-Sleep -Seconds 2
        if (@(Get-RunningDesktopProcesses).Count -gt 0) {
            throw 'Desktop restarted before the foreground updater could begin.'
        }
        $desktopExited = $true

        Write-RunStatus -Id $RunId -TargetVersion $Version -State 'updating' `
            -Detail 'Desktop exited; running the transactional updater.'
        Write-Host 'Desktop exited. Running the transactional update...' -ForegroundColor Cyan
        $updateParameters = @{
            InstallRoot = $repositoryRoot
            Version = $Version
            Remote = $Remote
        }
        if ($TestMode) { $updateParameters['TestMode'] = $true }
        Invoke-TargetUpdater -UpdaterPath $temporaryUpdaterPath -Parameters $updateParameters

        $installedCommit = Invoke-Git -Arguments @('rev-parse', '--verify', 'HEAD') -Capture
        $expectedCommit = Invoke-Git -Arguments @('rev-parse', '--verify', "refs/tags/$Version^{commit}") -Capture
        if ($installedCommit -ne $expectedCommit) {
            throw 'The installed commit does not match the requested release tag.'
        }
        $dirty = Invoke-Git -Arguments @('status', '--porcelain', '--untracked-files=all') -Capture
        if (-not [string]::IsNullOrWhiteSpace($dirty)) {
            throw 'The target release left the installation worktree dirty.'
        }
        Invoke-StrictDoctor

        Write-RunStatus -Id $RunId -TargetVersion $Version -State 'launching-desktop' `
            -Detail 'The update passed Doctor; relaunching Desktop with the preserved network mode.'
        Write-Host 'Update and strict Doctor passed. Relaunching Desktop...' -ForegroundColor Cyan
        Invoke-DesktopLauncher -Network $network
        Invoke-StrictDoctor

        $installedCommit = Invoke-Git -Arguments @('rev-parse', '--verify', 'HEAD') -Capture
        if ($installedCommit -ne $expectedCommit) {
            throw 'The installed commit changed during final verification.'
        }
        $dirty = Invoke-Git -Arguments @('status', '--porcelain', '--untracked-files=all') -Capture
        if (-not [string]::IsNullOrWhiteSpace($dirty)) {
            throw 'The final installation worktree is not clean.'
        }
        Write-RunStatus -Id $RunId -TargetVersion $Version -State 'completed' `
            -Detail 'Update, Desktop relaunch, and strict Doctor completed.' -Succeeded $true
        Write-Host ''
        Write-Host 'Upgrade completed. Desktop was relaunched and strict Doctor passed.' -ForegroundColor Green
        if (-not $TestMode) { Start-Sleep -Seconds 8 }
    } catch {
        $failure = $_
        $safeFailure = ConvertTo-SafeFailureText -Text ([string]$_.Exception.Message)
        if ($desktopExited -and @(Get-RunningDesktopProcesses).Count -eq 0 -and $network) {
            try {
                Write-Host 'The update did not complete; attempting to reopen Desktop with the preserved network mode.' -ForegroundColor Yellow
                Invoke-DesktopLauncher -Network $network
            } catch {
                $safeFailure += ' Desktop recovery launch also failed.'
            }
        }
        Write-RunStatus -Id $RunId -TargetVersion $Version -State 'failed' `
            -Detail 'Foreground upgrade failed; see the visible PowerShell window.' -Succeeded $false
        Write-Host ''
        Write-Host 'Foreground upgrade failed:' -ForegroundColor Red
        Write-Host $safeFailure -ForegroundColor Red
    } finally {
        Remove-Item -LiteralPath $temporaryUpdaterPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
        if (-not [string]::IsNullOrWhiteSpace($taskName) -and -not $TestMode) {
            try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
        }
    }

    if ($failure) {
        if (-not $TestMode) {
            [void](Read-Host 'Press Enter to close this window')
        }
        exit 1
    }
}

if ($Worker) {
    Invoke-ForegroundWorker
} else {
    Start-ForegroundWorker
}
