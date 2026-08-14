$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json not found.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$mode = if ([string]::IsNullOrWhiteSpace([string]$config.mode)) { 'project-agent' } else { [string]$config.mode }
$runtimeDir = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
$pidPath = Join-Path $runtimeDir 'bridge.pid'
$stopPath = Join-Path $runtimeDir 'stop.request'
$supervisorPidPath = Join-Path $runtimeDir 'bridge-supervisor.pid'
$supervisorStopPath = Join-Path $runtimeDir 'supervisor-stop.request'
$desktopRelayPointerScript = Join-Path $PSScriptRoot 'desktop-relay-pointer.ps1'

function Disable-DesktopRelayPointer {
    if ($mode -ne 'session-relay') { return }
    & $desktopRelayPointerScript -Url ([string]$config.sessionRelay.appServerUrl) -Disable | Out-Null
}

$supervisorPid = $null
if (Test-Path -LiteralPath $supervisorPidPath -PathType Leaf) {
    $supervisorPid = [int](Get-Content -Raw -LiteralPath $supervisorPidPath)
}
$bridgeName = if ($mode -eq 'session-relay') { 'session-relay.mjs' } else { 'channel-bridge.mjs' }
$bridge = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $bridgeName))

if (-not (Test-Path -LiteralPath $pidPath)) {
    if ($supervisorPid -and (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) {
        New-Item -ItemType File -Force -Path $supervisorStopPath | Out-Null
        Disable-DesktopRelayPointer
        Write-Output 'Bridge is between supervised runs; requested supervisor stop.'
    } else {
        Disable-DesktopRelayPointer
        Write-Output 'Bridge is not running.'
    }
    exit 0
}

$bridgePid = [int](Get-Content -Raw -LiteralPath $pidPath)
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid" -ErrorAction SilentlyContinue
$isBridge = $processInfo -and $processInfo.Name -eq 'node.exe' -and [string]$processInfo.CommandLine -like "*$bridge*"
if (-not $isBridge) {
    Remove-Item -LiteralPath $pidPath -Force
    Disable-DesktopRelayPointer
    Write-Output 'Bridge was not running; removed the stale PID file without touching the unrelated process.'
    exit 0
}
$process = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue

New-Item -ItemType File -Force -Path $stopPath | Out-Null
if ($supervisorPid) {
    New-Item -ItemType File -Force -Path $supervisorStopPath | Out-Null
}
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) {
        if (-not $supervisorPid -or -not (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) {
            Disable-DesktopRelayPointer
            Write-Output "Bridge stopped gracefully (PID $bridgePid)."
            exit 0
        }
    }
    Start-Sleep -Milliseconds 250
}

throw "Bridge did not stop within 20 seconds; no forced termination was attempted."
