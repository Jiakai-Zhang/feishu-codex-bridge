$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$projectRoot = [string]$config.workspace
$runtimeDir = Join-Path $projectRoot 'work\feishu-codex-bridge'
$pidPath = Join-Path $runtimeDir 'bridge.pid'
$supervisorPidPath = Join-Path $runtimeDir 'bridge-supervisor.pid'
$restartPath = Join-Path $runtimeDir 'restart.request'
$supervisorStopPath = Join-Path $runtimeDir 'supervisor-stop.request'
$stdoutPath = Join-Path $runtimeDir 'bridge.stdout.log'
$stderrPath = Join-Path $runtimeDir 'bridge.stderr.log'
$supervisorLogPath = Join-Path $runtimeDir 'bridge-supervisor.log'
$secretPath = Join-Path $runtimeDir 'channel-secret.dpapi'
$desktopRelayPointerScript = Join-Path $PSScriptRoot 'desktop-relay-pointer.ps1'
$node = [string]$config.nodeExecutable
$mode = if ([string]::IsNullOrWhiteSpace([string]$config.mode)) { 'project-agent' } else { [string]$config.mode }
switch ($mode) {
    'project-agent' { $bridge = Join-Path $PSScriptRoot 'channel-bridge.mjs' }
    'session-relay' { $bridge = Join-Path $PSScriptRoot 'session-relay.mjs' }
    default { throw "Unsupported bridge mode: $mode" }
}

function Write-SupervisorLog {
    param([string]$Message)
    $line = "[$([DateTime]::UtcNow.ToString('o'))] $Message`r`n"
    [System.IO.File]::AppendAllText($supervisorLogPath, $line)
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
[System.IO.File]::WriteAllText($supervisorPidPath, [string]$PID)

try {
    Write-SupervisorLog "supervisor started; pid=$PID; mode=$mode"
    while (-not (Test-Path -LiteralPath $supervisorStopPath)) {
        if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
            throw 'Encrypted Channel SDK secret is missing.'
        }
        if (Test-Path -LiteralPath $pidPath) {
            $savedPid = [int](Get-Content -Raw -LiteralPath $pidPath)
            if (Get-Process -Id $savedPid -ErrorAction SilentlyContinue) {
                throw "Another Bridge process is already running (PID $savedPid)."
            }
            Remove-Item -LiteralPath $pidPath -Force
        }

        $encrypted = [System.IO.File]::ReadAllText($secretPath)
        $secure = ConvertTo-SecureString $encrypted
        $secretPtr = [IntPtr]::Zero
        $plainSecret = $null
        try {
            $secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr)
            $env:LARK_APP_SECRET = $plainSecret
            $bridgeProcess = Start-Process -FilePath $node `
                -ArgumentList @("`"$bridge`"") `
                -WorkingDirectory $projectRoot `
                -WindowStyle Hidden `
                -RedirectStandardOutput $stdoutPath `
                -RedirectStandardError $stderrPath `
                -PassThru
        } finally {
            Remove-Item Env:LARK_APP_SECRET -ErrorAction SilentlyContinue
            $plainSecret = $null
            if ($secretPtr -ne [IntPtr]::Zero) {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr)
            }
            $secure.Dispose()
        }

        Write-SupervisorLog "Bridge started; pid=$($bridgeProcess.Id)"
        $bridgeProcess.WaitForExit()
        Write-SupervisorLog "Bridge exited; pid=$($bridgeProcess.Id); code=$($bridgeProcess.ExitCode)"

        if (Test-Path -LiteralPath $supervisorStopPath) { break }
        if (Test-Path -LiteralPath $restartPath) {
            Remove-Item -LiteralPath $restartPath -Force
            Write-SupervisorLog 'explicit reload requested; starting replacement Bridge'
            Start-Sleep -Milliseconds 250
            continue
        }
        break
    }
} catch {
    Write-SupervisorLog "supervisor failed: $($_.Exception.GetType().Name)"
    exit 1
} finally {
    $intentionalStop = Test-Path -LiteralPath $supervisorStopPath
    if ($mode -eq 'session-relay') {
        try {
            if ($intentionalStop) {
                & $desktopRelayPointerScript -Url ([string]$config.sessionRelay.appServerUrl) -Disable | Out-Null
            } else {
                & $desktopRelayPointerScript -Url ([string]$config.sessionRelay.appServerUrl) -Preparing | Out-Null
            }
        } catch {
            Write-SupervisorLog 'Could not pause Desktop relay during supervisor shutdown.'
        }
    }
    Remove-Item -LiteralPath $supervisorStopPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $restartPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $supervisorPidPath -Force -ErrorAction SilentlyContinue
    Write-SupervisorLog 'supervisor stopped'
}
