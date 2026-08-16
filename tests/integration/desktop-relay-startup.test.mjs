import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readScript(name) {
  return readFile(path.join(repositoryRoot, name), "utf8");
}

test("fresh install does not persist the Desktop relay pointer", async () => {
  const source = await readScript("install.ps1");
  const configureInvocation =
    "& (Join-Path $PSScriptRoot 'configure-codex-desktop-relay.ps1')";
  assert.equal(source.split(configureInvocation).length - 1, 1);
  assert.match(
    source,
    /if \(-not \[string\]::IsNullOrWhiteSpace\(\$currentRelayUrl\) -and \$currentRelayUrl -eq \$expectedRelayUrl\) \{[\s\S]*configure-codex-desktop-relay\.ps1/,
  );
  assert.match(
    source,
    /A fresh install does not change Codex Desktop until that final activation succeeds\./,
  );
});

test("Desktop relay activation verifies listener and watchdog before completion", async () => {
  const source = await readScript("configure-codex-desktop-relay.ps1");
  const startIndex = source.indexOf("start-app-server.ps1");
  const taskIndex = source.indexOf("Register-ScheduledTask -TaskName $taskName");
  const pointerIndex = source.lastIndexOf("desktopRelayPointerScript -Url $url.AbsoluteUri");
  const startTaskIndex = source.indexOf("Start-ScheduledTask -TaskName $taskName");
  const heartbeatIndex = source.indexOf("$watchdogStatus.state -eq 'ready'");
  assert.ok(startIndex >= 0);
  assert.ok(taskIndex > startIndex);
  assert.ok(pointerIndex > taskIndex);
  assert.ok(startTaskIndex > pointerIndex);
  assert.ok(heartbeatIndex > startTaskIndex);
  assert.match(source, /FeishuCodexBridge-DesktopRelay-Watchdog/);
  assert.match(source, /did not publish a ready heartbeat within 20 seconds/);
  assert.match(source, /Start the Bridge and wait for its authenticated Channel connection/);
});

test("Desktop relay disable path removes dependency before official tasks", async () => {
  const source = await readScript("configure-codex-desktop-relay.ps1");
  const disableStart = source.indexOf("if ($Disable)");
  const enableStart = source.indexOf("$url = Get-RelayUrl", disableStart);
  const disableBody = source.slice(disableStart, enableStart);
  const pointerRemoval = disableBody.indexOf(
    "SetEnvironmentVariable($variableName, $null",
  );
  const taskRemoval = disableBody.indexOf("Remove-OwnedTask -Name $taskName");
  assert.ok(pointerRemoval >= 0);
  assert.ok(taskRemoval > pointerRemoval);
  assert.match(disableBody, /External guardians were left untouched/);
});

test("continuous watchdog clears pointer before restart and restores it only after verification", async () => {
  const source = await readScript("start-at-login.ps1");
  const outageIndex = source.indexOf("if (-not $portListening)");
  const clearIndex = source.indexOf(
    "Set-DesktopRelayPointer -ExpectedUrl $appServerUri.AbsoluteUri -Enabled $false",
    outageIndex,
  );
  const restartIndex = source.indexOf("start-app-server.ps1", clearIndex);
  const restoreIndex = source.indexOf(
    "Set-DesktopRelayPointer -ExpectedUrl $appServerUri.AbsoluteUri -Enabled $true",
    restartIndex,
  );
  assert.ok(outageIndex >= 0);
  assert.ok(clearIndex > outageIndex);
  assert.ok(restartIndex > clearIndex);
  assert.ok(restoreIndex > restartIndex);
  assert.match(source, /\[int\]\$CheckIntervalSeconds = 3/);
  assert.match(source, /FeishuCodexBridgeDesktopRelayWatchdog-/);
  assert.match(source, /Another official Desktop relay watchdog[\s\S]*duplicate startup was ignored/);
});

test("continuous watchdog publishes heartbeat and keeps Bridge recovery asynchronous", async () => {
  const source = await readScript("start-at-login.ps1");
  assert.match(source, /desktop-relay-watchdog-status\.json/);
  assert.match(source, /heartbeatAt = \[DateTime\]::UtcNow\.ToString\('o'\)/);
  assert.match(source, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
  assert.match(source, /Start-BridgeRecoveryIfNeeded/);
  assert.match(source, /Start-Process -FilePath \$windowsPowerShell[\s\S]*start-bridge\.ps1/);
  assert.match(
    source,
    /\$bridgeRecoveryChecked = \[bool\]\(Start-BridgeRecoveryIfNeeded/,
  );
});

test("stable bootstrap clears only the pointer recorded in owned activation state", async () => {
  const source = await readScript("desktop-relay-bootstrap.ps1");
  assert.match(source, /desktop-relay-state\.json/);
  assert.match(source, /FEISHU_CODEX_BRIDGE_HOME[\s\S]*bridge\.config\.json/);
  assert.match(source, /\$current -ne \$expectedUrl[\s\S]*left unchanged/);
  assert.match(
    source,
    /Bridge installation pointer is missing[\s\S]*Disable-OwnedDesktopRelayPointer/,
  );
  assert.match(
    source,
    /The installed release has no login startup script[\s\S]*Disable-OwnedDesktopRelayPointer/,
  );
  assert.match(source, /continuous Desktop relay watchdog exited/);
});

test("custom guardians are detected but never removed during migration", async () => {
  const source = await readScript("configure-codex-desktop-relay.ps1");
  assert.match(source, /Get-PotentialExternalGuardianKinds/);
  assert.match(source, /scheduled task/);
  assert.match(source, /Windows service/);
  assert.match(source, /running process/);
  assert.match(source, /scriptLauncherNames/);
  assert.match(source, /strongGuardianPattern/);
  assert.match(source, /\[AllowEmptyCollection\(\)\]/);
  assert.match(source, /Potential custom guardian detected/);
  assert.match(source, /It was left untouched/);
  assert.match(
    source,
    /\$legacyTask -and \(Test-RelayTaskOwnership -Task \$legacyTask\)[\s\S]*Unregister-ScheduledTask -TaskName \$legacyTaskName/,
  );
});

test("Bridge delegates shared App Server ownership to the standalone starter", async () => {
  const source = await readScript("start-bridge.ps1");
  assert.match(source, /start-app-server\.ps1'\) -PassThru/);
  assert.doesNotMatch(
    source,
    /-ArgumentList @\('app-server', '--listen'/,
  );
  const pointerDisableIndex = source.indexOf("desktopRelayPointerScript -Url", source.indexOf("$appServerInfo = $null"));
  const appServerIndex = source.indexOf("start-app-server.ps1", pointerDisableIndex);
  const pointerEnableIndex = source.lastIndexOf("desktopRelayPointerScript -Url");
  assert.ok(pointerDisableIndex >= 0);
  assert.ok(appServerIndex > pointerDisableIndex);
  assert.ok(pointerEnableIndex > appServerIndex);
});

test("Session binding reloads use the Supervisor handshake", async () => {
  const relaySource = await readFile(path.join(repositoryRoot, "src/app/session-relay.mjs"), "utf8");
  const supervisorSource = await readScript("bridge-supervisor.ps1");
  assert.match(relaySource, /restartRequestPath[\s\S]*restart\.request/);
  assert.match(relaySource, /fs\.writeFile\(restartRequestPath/);
  assert.match(supervisorSource, /\$restartPath = Join-Path \$runtimeDir 'restart\.request'/);
  assert.match(supervisorSource, /explicit reload requested; starting replacement Bridge/);
});

test("Bridge stop pauses the watchdog and removes the owned Desktop pointer", async () => {
  const stopSource = await readScript("stop-bridge.ps1");
  const supervisorSource = await readScript("bridge-supervisor.ps1");
  const watchdogSource = await readScript("start-at-login.ps1");
  const pointerSource = await readScript("desktop-relay-pointer.ps1");
  assert.match(stopSource, /function Disable-DesktopRelayPointer[\s\S]*-Disable/);
  assert.match(stopSource, /Disable-DesktopRelayPointer[\s\S]*Bridge stopped gracefully/);
  assert.match(supervisorSource, /finally \{[\s\S]*desktopRelayPointerScript[\s\S]*-Disable/);
  assert.match(watchdogSource, /bridgeEnabled[\s\S]*State 'paused'/);
  assert.match(watchdogSource, /Bridge was stopped intentionally; Desktop relay recovery is paused/);
  assert.match(pointerSource, /Write-BridgeState[\s\S]*BridgeEnabled \$false/);
  assert.match(pointerSource, /Desktop relay recovery is not configured; the pointer remains disabled/);
});

test("Bridge readiness wait covers authenticated Channel startup", async () => {
  const source = await readScript("start-bridge.ps1");
  assert.match(source, /\[int\]\$ReadyTimeoutSeconds = 90/);
  assert.match(source, /AddSeconds\(\$ReadyTimeoutSeconds\)/);
  assert.match(source, /within \$ReadyTimeoutSeconds seconds/);
});

test("standalone App Server startup is serialized and verifies ownership", async () => {
  const source = await readScript("start-app-server.ps1");
  assert.match(source, /FeishuCodexBridgeAppServer-/);
  assert.match(source, /Port .* is already in use by an unverified process/);
  assert.match(source, /Find-VerifiedAppServerProcess/);
  assert.match(source, /AbsolutePath -ne '\/rpc'/);
});

test("doctor requires a fresh continuous watchdog heartbeat and owned listener", async () => {
  const source = await readScript("doctor.ps1");
  assert.match(source, /Desktop relay continuous watchdog/);
  assert.match(source, /desktop-relay-watchdog-status\.json/);
  assert.match(source, /heartbeatAgeSeconds[\s\S]*-le 20/);
  assert.match(source, /FeishuCodexBridge-DesktopRelay-Watchdog/);
  assert.match(source, /verified Codex App Server process owns the accepting loopback listener/);
});

test("Bridge status exposes the continuous watchdog health", async () => {
  const source = await readScript("status-bridge.ps1");
  assert.match(source, /desktopRelayWatchdog=\$watchdogState/);
  assert.match(source, /desktop-relay-watchdog-status\.json/);
  assert.match(source, /heartbeatAgeSeconds[\s\S]*-le 20/);
});

test("updater requires strict relay verification when the previous relay was enabled", async () => {
  const source = await readScript("update.ps1");
  assert.match(source, /\$desktopRelayWasEnabled/);
  assert.match(source, /doctor\.ps1'\) -RequireRunning -RequireDesktopRelay/);
  assert.match(source, /doctor\.ps1'\) -RequireDesktopRelay/);
  assert.match(
    source,
    /Never roll back to an enabled v0\.2 pointer[\s\S]*configure-codex-desktop-relay\.ps1'\) -Disable/,
  );
});
