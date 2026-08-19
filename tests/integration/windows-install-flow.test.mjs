import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function read(relativePath) {
  return fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("Windows Feishu app setup uses safe template and verification entrypoints", async () => {
  const [configure, verify, entry] = await Promise.all([
    read("configure-feishu-app.ps1"),
    read("verify-feishu-app.ps1"),
    read("src/runtime/platform/windows/feishu-app-entry.mjs"),
  ]);
  assert.match(configure, /feishu-app-entry\.mjs'[\s\S]*configure/);
  assert.match(verify, /feishu-app-entry\.mjs'[\s\S]*verify/);
  assert.match(entry, /buildFeishuBridgeAppTemplateUrl\(appId\)/);
  assert.match(entry, /openPrivateFeishuUrl\(targetUrl, \{/);
  assert.match(entry, /open: openWindowsUrl/);
  assert.match(entry, /timeoutMs: 120_000/);
  assert.match(entry, /onReady: \(localUrl\)/);
  assert.match(entry, /process\.stdout\.write[\s\S]*localUrl/);
  assert.match(entry, /summarizeFeishuBridgeAppVerification/);
  assert.match(entry, /env: directNetworkEnvironment\(\)/);
  assert.doesNotMatch(entry, /process\.stdout\.write\([^)]*appId/s);
  assert.doesNotMatch(entry, /rundll32[^\n]*targetUrl/);
});

test("Windows secret setup works before bridge.config.json exists", async () => {
  const source = await read("setup-channel-secret.ps1");
  const configBranch = source.indexOf("if (Test-Path -LiteralPath $configPath");
  const defaultWorkspace = source.indexOf("Join-Path $env:LOCALAPPDATA 'FeishuCodexBridge'");
  const prompt = source.indexOf("Read-Host 'App Secret' -AsSecureString");
  assert.ok(configBranch >= 0);
  assert.ok(defaultWorkspace > configBranch);
  assert.ok(prompt > defaultWorkspace);
  assert.match(source, /ConvertFrom-SecureString -SecureString \$secret/);
  assert.doesNotMatch(source, /param\([\s\S]*AppSecret/);
});

test("Windows Lark CLI and Doctor isolate inherited Desktop proxy variables", async () => {
  const [lark, doctor, installer] = await Promise.all([
    read("lark-cli.ps1"),
    read("doctor.ps1"),
    read("install.ps1"),
  ]);
  for (const source of [lark, doctor, installer]) {
    assert.match(source, /HTTP_PROXY/);
    assert.match(source, /Remove-Item -LiteralPath "Env:\$name"/);
    assert.match(source, /savedEnvironment/);
  }
  assert.match(doctor, /im\.message\.receive_v1/);
  assert.match(doctor, /console_event_published/);
  assert.match(doctor, /scopes_granted/);
});

test("Windows Desktop launcher preserves the saved network mode and accepts only loopback proxy", async () => {
  const [launcher, configure, appServer, bridge, installer] = await Promise.all([
    read("launch-codex-desktop-with-relay.ps1"),
    read("configure-codex-desktop-relay.ps1"),
    read("start-app-server.ps1"),
    read("start-bridge.ps1"),
    read("install.ps1"),
  ]);
  assert.match(launcher, /if \(\$PSBoundParameters\.ContainsKey\('Proxy'\)\)/);
  assert.match(launcher, /127\\\.0\\\.0\\\.1\|localhost\|\\\[::1\\\]/);
  assert.match(launcher, /desktop-relay-state\.json/);
  assert.match(launcher, /savedRelayState\.desktopProxyUrl/);
  assert.match(launcher, /Re-run with an explicit -Proxy or -NoProxy choice/);
  assert.match(launcher, /--proxy-server=\$desktopProxyUrl/);
  assert.match(launcher, /Get-AppxPackage -Name OpenAI\.Codex/);
  assert.match(launcher, /AppxManifest\.xml/);
  assert.match(launcher, /packagedDesktop\.ExecutablePath/);
  assert.doesNotMatch(launcher, /packaged Desktop launcher cannot receive an isolated proxy/);
  assert.match(configure, /AllowProxyRestart/);
  assert.match(configure, /desktopProxyUrl/);
  assert.match(configure, /if \(\$proxyHostName -eq '\[::1\]'\) \{ \$proxyHostName = '::1' \}/);
  assert.match(configure, /Wait-RelayTaskStopped/);
  assert.match(configure, /watchdogStatus\.state -eq 'ready'/);
  assert.match(configure, /current conversation to Full access/);
  assert.match(configure, /Approve for me[^\r\n]*does not remove sandbox boundaries/);
  assert.match(appServer, /codex-app-server-environment\.json/);
  assert.match(appServer, /Start-AppServerWithNetworkEnvironment/);
  assert.match(appServer, /refusing to restart it for a proxy change/);
  assert.match(bridge, /Remove-Item -LiteralPath "Env:\$name"/);
  assert.match(installer, /launch-codex-desktop-with-relay\.ps1/);
  assert.match(installer, /SkipDesktopRelayMigration/);
});

test("Windows updater locks and backs up the Desktop network selection before checkout", async () => {
  const updater = await read("update.ps1");
  assert.match(updater, /\[ValidateSet\('origin', 'private'\)\]/);
  assert.match(updater, /ninmon\/feishu-codex-bridge-private/);
  assert.match(updater, /remote', 'get-url', \$Remote/);
  assert.match(updater, /fetch', '--quiet', \$Remote/);
  assert.match(updater, /\[string\]\$Proxy/);
  assert.match(updater, /\[switch\]\$NoProxy/);
  assert.match(updater, /active App Server network mode does not match the preserved selection/);
  assert.match(updater, /SkipDesktopRelayMigration/);
  assert.match(updater, /desktop-relay-state\.json/);
  assert.match(updater, /desktop-relay-bootstrap\.ps1/);
  assert.match(updater, /session-relay-access\.json/);
  assert.match(updater, /session-relay-inbound-attachments/);
  assert.match(updater, /\[switch\]\$PreflightOnly/);
  assert.match(updater, /Update preflight passed/);
  assert.match(updater, /\$MyInvocation\.MyCommand\.Path/);
  assert.match(updater, /function Get-DirtyState/);
  assert.match(updater, /upgrade-backups/);
});

test("Windows multi-user Project root setup keeps the absolute path off command arguments", async () => {
  const [setup, entry] = await Promise.all([
    read("setup-project-root.ps1"),
    read("src/app/configure-session-access.mjs"),
  ]);
  assert.match(setup, /Read-Host 'Bridge Project root/);
  assert.match(setup, /ConvertTo-Json -Compress/);
  assert.match(setup, /\$request \| & \$node \$entry/);
  assert.doesNotMatch(setup, /-ProjectRoot/);
  assert.match(entry, /session-relay-access\.json/);
  assert.match(entry, /no path was printed/);
});

test("Windows install prompt matches the macOS onboarding contract", async () => {
  const [prompt, index, upgrade, readme, doctor, installAgent] = await Promise.all([
    read("docs/INSTALL_WINDOWS_PROMPT.md"),
    read("docs/INSTALL_AGENT_PROMPT.md"),
    read("docs/UPGRADE_WINDOWS_PROMPT.md"),
    read("README.md"),
    read("doctor.ps1"),
    read("docs/INSTALL_AGENT.md"),
  ]);
  assert.match(prompt, /完全访问（Full access）/);
  assert.match(prompt, /替我审批（Approve for me）/);
  assert.ok(prompt.indexOf("完全访问（Full access）") < prompt.indexOf("1. 先做只读预检"));
  assert.match(prompt, /\[Environment\]::MachineName/);
  assert.match(prompt, /setup-channel-secret\.ps1[\s\S]*configure-feishu-app\.ps1/);
  assert.match(prompt, /im\.message\.receive_v1/);
  assert.match(prompt, /\u9ed8\u8ba4\u4e3a\u76f4\u8fde/);
  assert.match(prompt, /launch-codex-desktop-with-relay\.ps1 -Proxy/);
  assert.match(prompt, /\$feishu-session-bind/);
  assert.match(prompt, /\u4e0d\u8981(?:\u518d)?\u8981\u6c42\u7528\u6237\u5148\u641c\u7d22 Bot[\s\S]*\/add/);
  assert.match(prompt, /\u5c0f\u56fe[\s\S]*\u666e\u901a\u5c0f\u6587\u4ef6[\s\S]*\u539f\u751f\u9644\u4ef6/);
  assert.match(prompt, /CLI \u539f\u6837\u8f93\u51fa\u7684\u8be5 URL \u4f5c\u4e3a\u53ef\u70b9\u51fb\u7684\u5907\u7528\u94fe\u63a5/);
  assert.match(prompt, /\u4e34\u65f6\u672c\u673a loopback \u5907\u7528 URL/);
  assert.match(prompt, /tag：v0\.4\.0-windows-rc\.5/);
  assert.match(prompt, /https:\/\/github\.com\/ninmon\/feishu-codex-bridge-private\.git/);
  assert.match(prompt, /setup-project-root\.ps1/);
  assert.match(prompt, /没有明确要求“同机多用户”[^\n]*不要额外询问/);
  assert.match(prompt, /Session owner 使用 `\/permissions`/);
  assert.match(index, /tag：v0\.4\.0-windows-rc\.5[\s\S]*文件：docs\/INSTALL_WINDOWS_PROMPT\.md/);
  assert.match(index, /tag：v0\.4\.0-windows-rc\.5[\s\S]*文件：docs\/UPGRADE_WINDOWS_PROMPT\.md/);
  assert.doesNotMatch(index, /raw\.githubusercontent\.com/);
  assert.match(upgrade, /update-windows-with-desktop-restart\.ps1/);
  assert.match(upgrade, /v0\.4\.0-windows-rc\.5/);
  assert.match(upgrade, /不得要求用户复制、粘贴或运行升级命令/);
  assert.match(upgrade, /Foreground upgrade is ready/);
  assert.match(upgrade, /只负责.*关闭.*可见窗口.*不负责.*重新打开/);
  assert.match(upgrade, /可执行路径完全一致的 Desktop 残留进程/);
  assert.match(upgrade, /Interactive、Limited、无自动触发器/);
  assert.match(upgrade, /原有代理模式/);
  assert.match(readme, /docs\/UPGRADE_WINDOWS_PROMPT\.md/);
  assert.match(installAgent, /v0\.4\.0-windows-rc\.5/);
  assert.match(doctor, /current conversation to Full access/);
  assert.match(doctor, /Approve for me[^\r\n]*does not remove sandbox boundaries/);
});
