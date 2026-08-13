$ErrorActionPreference = 'Stop'

function Write-SafeResult {
    param([Parameter(Mandatory)][object]$Value, [int]$ExitCode = 0)
    $json = $Value | ConvertTo-Json -Depth 6 -Compress
    [Console]::Out.WriteLine($json)
    exit $ExitCode
}

try {
    $bridgeHome = [Environment]::GetEnvironmentVariable('FEISHU_CODEX_BRIDGE_HOME', [EnvironmentVariableTarget]::Process)
    if ([string]::IsNullOrWhiteSpace($bridgeHome)) {
        $bridgeHome = [Environment]::GetEnvironmentVariable('FEISHU_CODEX_BRIDGE_HOME', [EnvironmentVariableTarget]::User)
    }
    if ([string]::IsNullOrWhiteSpace($bridgeHome)) {
        throw [InvalidOperationException]::new('Bridge installation is not registered for the current user.')
    }
    $configPath = Join-Path $bridgeHome 'bridge.config.json'
    $requestScript = Join-Path $bridgeHome 'request-session-binding.mjs'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $requestScript -PathType Leaf)) {
        throw [InvalidOperationException]::new('The registered Bridge installation is incomplete.')
    }
    $threadId = [string]$env:CODEX_THREAD_ID
    if ($threadId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        throw [InvalidOperationException]::new('The current Codex task ID is unavailable; run this Skill inside a Codex task.')
    }
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $nodePath = [string]$config.nodeExecutable
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        throw [InvalidOperationException]::new('The Bridge Node.js runtime is unavailable.')
    }

    $lines = & $nodePath $requestScript --thread-id $threadId 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($lines | ForEach-Object { [string]$_ }) -join "`n"
    try { $response = $text | ConvertFrom-Json }
    catch { throw [InvalidOperationException]::new('The Bridge returned an invalid binding response.') }

    $safeResponse = [ordered]@{ ok = [bool]$response.ok }
    if ($response.ok) {
        $safeResponse['result'] = [ordered]@{
            alreadyBound = [bool]$response.result.alreadyBound
            groupName = [string]$response.result.groupName
            feedGroupName = [string]$response.result.feedGroupName
            restart = [bool]$response.result.restart
        }
        Write-SafeResult -Value $safeResponse
    }
    $safeResponse['error'] = [ordered]@{
        code = [string]$response.error.code
        message = [string]$response.error.message
        missingScopes = @($response.error.missingScopes | Where-Object { $_ -is [string] } | Select-Object -First 10)
    }
    Write-SafeResult -Value $safeResponse -ExitCode $(if ($exitCode -eq 0) { 1 } else { $exitCode })
} catch {
    Write-SafeResult -Value ([ordered]@{
        ok = $false
        error = [ordered]@{
            code = 'binding_request_unavailable'
            message = [string]$_.Exception.Message
            missingScopes = @()
        }
    }) -ExitCode 1
}
