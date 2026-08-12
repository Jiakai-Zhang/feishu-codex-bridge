$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json not found. Copy bridge.config.example.json and fill in your local values first.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$projectRoot = [string]$config.workspace
$runtimeDir = Join-Path $projectRoot 'work\feishu-codex-bridge'
$pidPath = Join-Path $runtimeDir 'bridge.pid'
$stdoutPath = Join-Path $runtimeDir 'bridge.stdout.log'
$stderrPath = Join-Path $runtimeDir 'bridge.stderr.log'
$secretPath = Join-Path $runtimeDir 'channel-secret.dpapi'
$node = [string]$config.nodeExecutable
$bridge = Join-Path $PSScriptRoot 'channel-bridge.mjs'
$expectedBridge = [System.IO.Path]::GetFullPath($bridge)

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

if (Test-Path -LiteralPath $pidPath) {
    $existingPid = [int](Get-Content -Raw -LiteralPath $pidPath)
    $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
    $isBridge = $existingProcess -and
        $existingProcess.Name -eq 'node.exe' -and
        [string]$existingProcess.CommandLine -like "*$expectedBridge*"
    if ($isBridge) {
        Write-Output "Bridge is already running (PID $existingPid)."
        exit 0
    }
    # A PID can be reused after Windows restarts. Never treat an unrelated
    # process as the bridge and never terminate it during stale-file cleanup.
    Remove-Item -LiteralPath $pidPath -Force
}

if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw "Encrypted Channel SDK secret not found. Run setup-channel-secret.ps1 first."
}

$encrypted = [System.IO.File]::ReadAllText($secretPath)
$secure = ConvertTo-SecureString $encrypted
$secretPtr = [IntPtr]::Zero
$plainSecret = $null
try {
    $secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr)
    $env:LARK_APP_SECRET = $plainSecret
    $process = Start-Process -FilePath $node `
        -ArgumentList @($bridge) `
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

$deadline = [DateTime]::UtcNow.AddSeconds(25)
while ([DateTime]::UtcNow -lt $deadline) {
    if ($process.HasExited) {
        throw "Bridge exited during startup. Check $stderrPath and $stdoutPath"
    }
    if ((Test-Path -LiteralPath $stdoutPath) -and
        (Select-String -LiteralPath $stdoutPath -Pattern 'READY: Channel SDK connected' -Quiet)) {
        Write-Output "Bridge is connected (PID $($process.Id))."
        exit 0
    }
    Start-Sleep -Milliseconds 250
    $process.Refresh()
}

throw "Bridge did not become ready within 25 seconds. Check $stderrPath and $stdoutPath"
