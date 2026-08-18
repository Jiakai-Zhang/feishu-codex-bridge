param(
    [string]$Proxy,
    [switch]$NoProxy,
    [string]$DesktopExecutable
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This Codex Desktop launcher supports Windows only.'
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

function Get-RunningDesktopProcesses {
    $results = @()
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $name = [string]$process.Name
        if ($name -notmatch '(?i)(ChatGPT|Codex).*\.exe$') { continue }
        if ([string]$process.CommandLine -match '(?i)\bapp-server\b') { continue }
        $results += $process
    }
    return @($results)
}

function Add-ExecutableCandidate {
    param(
        [Collections.Generic.List[string]]$Candidates,
        [string]$Value
    )
    if ([string]::IsNullOrWhiteSpace($Value)) { return }
    try { $fullPath = [IO.Path]::GetFullPath($Value) } catch { return }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { return }
    if ([IO.Path]::GetExtension($fullPath) -ine '.exe') { return }
    if (-not $Candidates.Contains($fullPath)) { $Candidates.Add($fullPath) }
}

function Find-DesktopExecutable {
    param([string]$RequestedPath)
    $candidates = [Collections.Generic.List[string]]::new()
    Add-ExecutableCandidate -Candidates $candidates -Value $RequestedPath

    foreach ($name in @('Codex.exe', 'ChatGPT.exe')) {
        foreach ($registryPath in @(
            "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$name",
            "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\$name"
        )) {
            try {
                Add-ExecutableCandidate -Candidates $candidates `
                    -Value ([string](Get-ItemPropertyValue -LiteralPath $registryPath -Name '(default)' -ErrorAction Stop))
            } catch { }
        }
    }

    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Codex\Codex.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\ChatGPT\ChatGPT.exe'),
        (Join-Path $env:ProgramFiles 'Codex\Codex.exe'),
        (Join-Path $env:ProgramFiles 'ChatGPT\ChatGPT.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Codex\Codex.exe' }),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'ChatGPT\ChatGPT.exe' })
    )) {
        Add-ExecutableCandidate -Candidates $candidates -Value $candidate
    }

    $startMenuRoots = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::StartMenu),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonStartMenu)
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Container) }
    if ($startMenuRoots.Count -gt 0) {
        try {
            $shell = New-Object -ComObject WScript.Shell
            foreach ($shortcut in @(Get-ChildItem -LiteralPath $startMenuRoots -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.BaseName -match '(?i)^(Codex|ChatGPT)' })) {
                try {
                    Add-ExecutableCandidate -Candidates $candidates -Value ([string]$shell.CreateShortcut($shortcut.FullName).TargetPath)
                } catch { }
            }
        } catch { }
    }
    return $candidates | Select-Object -First 1
}

function Find-PackagedDesktopAppId {
    if (-not (Get-Command Get-StartApps -ErrorAction SilentlyContinue)) { return $null }
    try {
        $app = Get-StartApps | Where-Object { [string]$_.Name -match '(?i)^(Codex|ChatGPT)$' } |
            Sort-Object @{ Expression = { if ([string]$_.Name -ieq 'Codex') { 0 } else { 1 } } } |
            Select-Object -First 1
        return [string]$app.AppID
    } catch {
        return $null
    }
}

$configPath = Join-Path $PSScriptRoot 'bridge.config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'bridge.config.json not found. Run install.ps1 first.'
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if (@(Get-RunningDesktopProcesses).Count -gt 0) {
    throw 'ChatGPT/Codex Desktop is still running. Fully quit it, then run this launcher again.'
}

$desktopProxyUrl = $null
if ($PSBoundParameters.ContainsKey('Proxy')) {
    $desktopProxyUrl = ConvertTo-SafeLoopbackProxy -Value $Proxy
    if (-not $desktopProxyUrl) { throw '-Proxy requires a loopback URL.' }
}

$relayUrl = [string]$config.sessionRelay.appServerUrl
$desktopPath = Find-DesktopExecutable -RequestedPath $DesktopExecutable
$packagedAppId = $null
if (-not $desktopPath) { $packagedAppId = Find-PackagedDesktopAppId }
if (-not $desktopPath -and -not $packagedAppId) {
    throw 'ChatGPT/Codex Desktop could not be found in App Paths, standard locations, Start Menu shortcuts, or packaged apps.'
}
if ($desktopProxyUrl -and -not $desktopPath) {
    throw 'The packaged Desktop launcher cannot receive an isolated proxy. Install the Win32 Desktop build or use its system proxy, then retry without -Proxy.'
}

$configureParameters = @{}
if ($desktopProxyUrl) { $configureParameters['Proxy'] = $desktopProxyUrl }
else { $configureParameters['NoProxy'] = $true }
& (Join-Path $PSScriptRoot 'configure-codex-desktop-relay.ps1') @configureParameters

$environmentNames = @('CODEX_APP_SERVER_WS_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
$savedEnvironment = @{}
try {
    foreach ($name in $environmentNames) {
        $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        if ($item) { $savedEnvironment[$name] = [string]$item.Value }
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    Set-Item -LiteralPath 'Env:CODEX_APP_SERVER_WS_URL' -Value $relayUrl
    $desktopArguments = @()
    if ($desktopProxyUrl) {
        foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
            Set-Item -LiteralPath "Env:$name" -Value $desktopProxyUrl
        }
        Set-Item -LiteralPath 'Env:NO_PROXY' -Value '127.0.0.1,localhost,::1'
        $desktopArguments += "--proxy-server=$desktopProxyUrl"
    }
    if ($desktopPath) {
        if ($desktopArguments.Count -gt 0) {
            Start-Process -FilePath $desktopPath -ArgumentList $desktopArguments | Out-Null
        } else {
            Start-Process -FilePath $desktopPath | Out-Null
        }
    } else {
        Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$packagedAppId" | Out-Null
    }
} finally {
    foreach ($name in $environmentNames) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        if ($savedEnvironment.ContainsKey($name)) {
            Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
        }
    }
}

$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
    if (@(Get-RunningDesktopProcesses).Count -gt 0) {
        $networkMode = if ($desktopProxyUrl) { 'local proxy' } else { 'direct' }
        Write-Output "ChatGPT/Codex Desktop launched with the verified shared App Server relay in $networkMode mode."
        exit 0
    }
    Start-Sleep -Milliseconds 250
}
throw 'ChatGPT/Codex Desktop did not remain running within 30 seconds.'
