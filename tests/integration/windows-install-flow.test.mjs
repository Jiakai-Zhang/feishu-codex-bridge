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

test("Windows Desktop launcher defaults direct and accepts only explicit loopback proxy", async () => {
  const [launcher, configure, appServer, bridge, installer] = await Promise.all([
    read("launch-codex-desktop-with-relay.ps1"),
    read("configure-codex-desktop-relay.ps1"),
    read("start-app-server.ps1"),
    read("start-bridge.ps1"),
    read("install.ps1"),
  ]);
  assert.match(launcher, /if \(\$PSBoundParameters\.ContainsKey\('Proxy'\)\)/);
  assert.match(launcher, /127\\\.0\\\.0\\\.1\|localhost\|\\\[::1\\\]/);
  assert.match(launcher, /else \{ \$configureParameters\['NoProxy'\] = \$true \}/);
  assert.match(launcher, /--proxy-server=\$desktopProxyUrl/);
  assert.match(configure, /AllowProxyRestart/);
  assert.match(configure, /desktopProxyUrl/);
  assert.match(configure, /if \(\$proxyHostName -eq '\[::1\]'\) \{ \$proxyHostName = '::1' \}/);
  assert.match(configure, /Wait-RelayTaskStopped/);
  assert.match(configure, /watchdogStatus\.state -eq 'ready'/);
  assert.match(appServer, /codex-app-server-environment\.json/);
  assert.match(appServer, /Start-AppServerWithNetworkEnvironment/);
  assert.match(appServer, /refusing to restart it for a proxy change/);
  assert.match(bridge, /Remove-Item -LiteralPath "Env:\$name"/);
  assert.match(installer, /launch-codex-desktop-with-relay\.ps1/);
});

test("Windows install prompt matches the macOS onboarding contract", async () => {
  const [prompt, index, readme] = await Promise.all([
    read("docs/INSTALL_WINDOWS_PROMPT.md"),
    read("docs/INSTALL_AGENT_PROMPT.md"),
    read("README.md"),
  ]);
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
  assert.match(index, /raw\.githubusercontent\.com\/ninmon\/feishu-codex-bridge\/v0\.3\.2-windows-rc\.1\/docs\/INSTALL_WINDOWS_PROMPT\.md/);
  assert.match(readme, /INSTALL_WINDOWS_PROMPT\.md/);
});
