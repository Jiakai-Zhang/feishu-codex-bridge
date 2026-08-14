import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

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

test("Desktop relay activation writes the persistent pointer last", async () => {
  const source = await readScript("configure-codex-desktop-relay.ps1");
  const startIndex = source.indexOf("start-app-server.ps1");
  const taskIndex = source.indexOf("Register-ScheduledTask -TaskName $taskName");
  const pointerIndex = source.lastIndexOf(
    "[Environment]::SetEnvironmentVariable($variableName, $url.AbsoluteUri",
  );
  assert.ok(startIndex >= 0);
  assert.ok(taskIndex > startIndex);
  assert.ok(pointerIndex > taskIndex);
  assert.match(source, /the Desktop relay pointer was not enabled/);
});

test("Desktop relay disable path removes dependency before startup task", async () => {
  const source = await readScript("configure-codex-desktop-relay.ps1");
  const disableStart = source.indexOf("if ($Disable)");
  const enableStart = source.indexOf("$url = Get-RelayUrl", disableStart);
  const disableBody = source.slice(disableStart, enableStart);
  const pointerRemoval = disableBody.indexOf(
    "SetEnvironmentVariable($variableName, $null",
  );
  const taskRemoval = disableBody.indexOf("Unregister-ScheduledTask");
  assert.ok(pointerRemoval >= 0);
  assert.ok(taskRemoval > pointerRemoval);
});

test("logon startup restores App Server before Bridge and fails open", async () => {
  const source = await readScript("start-at-login.ps1");
  const appServerIndex = source.indexOf("start-app-server.ps1");
  const bridgeIndex = source.indexOf("start-bridge.ps1");
  assert.ok(appServerIndex >= 0);
  assert.ok(bridgeIndex > appServerIndex);
  assert.match(
    source,
    /Shared App Server startup failed[\s\S]*Disable-DesktopRelayPointer[\s\S]*exit 1/,
  );
  assert.match(
    source,
    /Bridge startup failed while the App Server remained available/,
  );
});

test("stable bootstrap fails open if the installation moved or rolled back", async () => {
  const source = await readScript("desktop-relay-bootstrap.ps1");
  assert.match(
    source,
    /Bridge installation pointer is missing[\s\S]*Disable-OwnedDesktopRelayPointer/,
  );
  assert.match(
    source,
    /The installed release has no login startup script[\s\S]*Disable-OwnedDesktopRelayPointer/,
  );
});

test("Bridge delegates shared App Server ownership to the standalone starter", async () => {
  const source = await readScript("start-bridge.ps1");
  assert.match(source, /start-app-server\.ps1'\) -PassThru/);
  assert.doesNotMatch(
    source,
    /-ArgumentList @\('app-server', '--listen'/,
  );
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

test("doctor requires fail-open recovery and a live listener", async () => {
  const source = await readScript("doctor.ps1");
  assert.match(source, /Desktop relay logon recovery/);
  assert.match(source, /Shared App Server listener/);
  assert.match(source, /FeishuCodexBridge-DesktopRelay/);
});
