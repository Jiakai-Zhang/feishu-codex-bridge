param(
    [Parameter(Mandatory = $true)]
    [int]$OldProcessId
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$runtimeDir = Join-Path ([string]$config.workspace) 'work\feishu-codex-bridge'
$pidPath = Join-Path $runtimeDir 'bridge.pid'
$logPath = Join-Path $runtimeDir 'restart-watcher.log'
$startScript = Join-Path $PSScriptRoot 'start-bridge.ps1'

# A Codex turn can legitimately run for much longer than ten minutes. Wait for
# the bridge to finish the active turn instead of abandoning the restart.
while (Get-Process -Id $OldProcessId -ErrorAction SilentlyContinue) {
    Start-Sleep -Milliseconds 500
}

$pidDeadline = [DateTime]::UtcNow.AddSeconds(10)
while ((Test-Path -LiteralPath $pidPath) -and [DateTime]::UtcNow -lt $pidDeadline) {
    Start-Sleep -Milliseconds 250
}

try {
    $result = & $startScript 2>&1 | Out-String
    [System.IO.File]::WriteAllText($logPath, "Restart completed.`r`n$result")
} catch {
    [System.IO.File]::WriteAllText($logPath, "Restart failed: $($_.Exception.Message)")
    exit 1
}
