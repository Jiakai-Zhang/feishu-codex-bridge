import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  desktopProxySelection,
  installedDesktopBundlePath,
  proxyEnvironmentMatches,
  safeDesktopLaunchArguments,
  safeLoopbackProxyArgument,
} from "../../../src/runtime/platform/macos/desktop-runtime.mjs";

const execFile = promisify(nodeExecFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("macOS lifecycle wrappers route through the single safe Node launcher", async () => {
  const commands = new Map([
    ["bootstrap.sh", "dependencies"],
    ["install.sh", "install"],
    ["setup-channel-secret.sh", "setup-secret"],
    ["configure-feishu-app.sh", "configure-feishu-app"],
    ["verify-feishu-app.sh", "verify-feishu-app"],
    ["setup-project-root.sh", "setup-project-root"],
    ["start-bridge.sh", "start"],
    ["stop-bridge.sh", "stop"],
    ["status-bridge.sh", "status"],
    ["doctor.sh", "doctor"],
    ["configure-codex-desktop-relay.sh", "configure-desktop-relay"],
    ["launch-codex-desktop-with-relay.sh", "launch-desktop-relay"],
    ["lark-cli.sh", "lark-cli"],
    ["update.sh", "update"],
  ]);
  for (const [name, command] of commands) {
    const content = await fs.readFile(path.join(repositoryRoot, name), "utf8");
    assert.match(content, new RegExp(`macos-node\\.sh\" ${command.replace("-", "\\-")} `));
    assert.doesNotMatch(content, /LARK_APP_SECRET|security\s+add-generic-password/);
  }
});

test("macOS multi-user Project root setup is local, interactive, and argument-free", async () => {
  const [wrapper, admin, configurator] = await Promise.all([
    fs.readFile(path.join(repositoryRoot, "setup-project-root.sh"), "utf8"),
    fs.readFile(path.join(
      repositoryRoot,
      "src",
      "runtime",
      "platform",
      "macos",
      "admin-cli.mjs",
    ), "utf8"),
    fs.readFile(path.join(repositoryRoot, "src", "app", "configure-session-access.mjs"), "utf8"),
  ]);
  assert.match(wrapper, /macos-node\.sh" setup-project-root/);
  assert.doesNotMatch(wrapper, /--project-root|--owner-directory/);
  const setupStart = admin.indexOf("async function setupProjectRootCommand");
  const setupEnd = admin.indexOf("async function resumeRelayIfEnabled", setupStart);
  const setupSource = admin.slice(setupStart, setupEnd);
  assert.match(setupSource, /args\.length > 0/);
  assert.match(setupSource, /process\.stdin\.isTTY/);
  assert.match(setupSource, /createInterface\(\{ input: process\.stdin/);
  assert.match(setupSource, /configureSessionAccess\(\{ repositoryDirectory: repositoryRoot, projectRoot, ownerDirectoryName \}\)/);
  assert.doesNotMatch(setupSource, /process\.argv.*projectRoot|--project-root/);
  assert.match(configurator, /export async function configureSessionAccess/);
  assert.match(configurator, /no path was printed/);
});

test("macOS updater selects only maintained public or private remotes", async () => {
  const source = await fs.readFile(path.join(
    repositoryRoot,
    "src",
    "runtime",
    "platform",
    "macos",
    "update.mjs",
  ), "utf8");
  assert.match(source, /\["origin", "private"\]\.includes\(remote\)/);
  assert.match(source, /\["remote", "get-url", remote\]/);
  assert.match(source, /\["fetch", "--quiet", remote/);
  assert.match(source, /session-relay-access\.json/);
});

test("macOS Desktop relay activation reloads the launchd registration", async () => {
  const source = await fs.readFile(path.join(
    repositoryRoot,
    "src",
    "runtime",
    "platform",
    "macos",
    "admin-cli.mjs",
  ), "utf8");
  const activationStart = source.indexOf("async function activateDesktopRelay");
  const activationEnd = source.indexOf("async function configureRelayCommand", activationStart);
  const activationSource = source.slice(activationStart, activationEnd);
  const bootout = activationSource.indexOf("bootoutLaunchAgent(MACOS_LABELS.relay)");
  const activate = activationSource.indexOf("writeJsonAtomic(status.layout.relayStatePath, activation)");
  const register = activationSource.indexOf("registerRelayWatchdog(status, activation)");
  assert.ok(bootout >= 0);
  assert.ok(activate > bootout);
  assert.ok(register > activate);
  const registrationStart = source.indexOf("async function registerRelayWatchdog");
  const registrationEnd = source.indexOf("async function activateDesktopRelay", registrationStart);
  const registrationSource = source.slice(registrationStart, registrationEnd);
  assert.match(registrationSource, /attempt <= 2/);
  assert.match(registrationSource, /bootoutLaunchAgent\(MACOS_LABELS\.relay\)/);
  assert.match(registrationSource, /bootstrapLaunchAgent\(MACOS_LABELS\.relay/);
  assert.match(registrationSource, /"kickstart", "-k"/);
  assert.match(registrationSource, /relayActivationReady\(status, activation\)/);
  const proxyStart = source.indexOf("async function ensureSharedAppServerProxy");
  const proxyEnd = source.indexOf("async function launchDesktopRelayCommand", proxyStart);
  assert.match(source.slice(proxyStart, proxyEnd), /await activateDesktopRelay\(status, proxyUrl\)/);
  const configureStart = source.indexOf("async function configureRelayCommand");
  const configureEnd = source.indexOf("async function larkCliCommand", configureStart);
  assert.match(source.slice(configureStart, configureEnd), /await activateDesktopRelay\(status, desktopProxyUrl\)/);
});

test("macOS Feishu CLI checks remove inherited Desktop proxy variables", async () => {
  const [admin, installer] = await Promise.all([
    fs.readFile(path.join(
      repositoryRoot,
      "src",
      "runtime",
      "platform",
      "macos",
      "admin-cli.mjs",
    ), "utf8"),
    fs.readFile(path.join(
      repositoryRoot,
      "src",
      "runtime",
      "platform",
      "macos",
      "installer.mjs",
    ), "utf8"),
  ]);
  const commandStart = admin.indexOf("async function larkCliCommand");
  const commandEnd = admin.indexOf("async function main", commandStart);
  assert.match(admin.slice(commandStart, commandEnd), /env: directNetworkEnvironment\(\)/);
  const jsonStart = installer.indexOf("export async function larkJson");
  const jsonEnd = installer.indexOf("async function larkIdentity", jsonStart);
  assert.match(installer.slice(jsonStart, jsonEnd), /env: directNetworkEnvironment\(\)/);
});

test("macOS secret setup uses an interactive Keychain prompt, never a password argument", async () => {
  const content = await fs.readFile(path.join(
    repositoryRoot,
    "src",
    "runtime",
    "platform",
    "macos",
    "keychain-credential-store.mjs",
  ), "utf8");
  assert.match(content, /"add-generic-password", "-U"/);
  assert.match(content, /identity\.label, "-w"/);
  assert.match(content, /Full access/);
  assert.doesNotMatch(content, /"-w",\s*(?:secret|options|get\()/i);
  assert.doesNotMatch(content, /bridge\.config\.json[\s\S]{0,120}LARK_APP_SECRET/);

  const admin = await fs.readFile(path.join(
    repositoryRoot,
    "src",
    "runtime",
    "platform",
    "macos",
    "admin-cli.mjs",
  ), "utf8");
  const setupStart = admin.indexOf("async function setupSecretCommand");
  const setupEnd = admin.indexOf("async function configureFeishuAppCommand", setupStart);
  assert.doesNotMatch(admin.slice(setupStart, setupEnd), /readBridgeConfig/);
});

test("macOS Feishu app template handoff never prints or passes the App ID to open", async () => {
  const admin = await fs.readFile(path.join(
    repositoryRoot,
    "src",
    "runtime",
    "platform",
    "macos",
    "admin-cli.mjs",
  ), "utf8");
  const configureStart = admin.indexOf("async function configureFeishuAppCommand");
  const configureEnd = admin.indexOf("async function resumeRelayIfEnabled", configureStart);
  const configureSource = admin.slice(configureStart, configureEnd);
  assert.match(configureSource, /buildFeishuBridgeAppTemplateUrl\(appId\)/);
  assert.match(configureSource, /openPrivateFeishuUrl\(targetUrl, \{/);
  assert.match(configureSource, /timeoutMs: 120_000/);
  assert.match(configureSource, /onReady: \(localUrl\)/);
  assert.match(configureSource, /process\.stdout\.write[\s\S]*localUrl/);
  assert.doesNotMatch(configureSource, /process\.stdout\.write\([^)]*appId/s);

  const [redirect, sharedRedirect] = await Promise.all([
    fs.readFile(path.join(
      repositoryRoot,
      "src",
      "runtime",
      "platform",
      "macos",
      "private-browser-redirect.mjs",
    ), "utf8"),
    fs.readFile(path.join(
      repositoryRoot,
      "src",
      "runtime",
      "shared",
      "private-browser-redirect.mjs",
    ), "utf8"),
  ]);
  assert.match(redirect, /execFile\("\/usr\/bin\/open", \[url\]/);
  assert.match(sharedRedirect, /http:\/\/127\.0\.0\.1:/);
  assert.match(sharedRedirect, /onReady\?\.\(localUrl\)/);
});

test("macOS install prompt names the Feishu app after the Codex Mac, not the CLI profile", async () => {
  const prompt = await fs.readFile(path.join(
    repositoryRoot,
    "docs",
    "INSTALL_MACOS_PROMPT.md",
  ), "utf8");
  assert.match(prompt, /scutil --get ComputerName/);
  assert.match(prompt, /应用展示名称必须与运行 Codex Desktop.*系统.*电脑名称.*完全一致/);
  assert.match(prompt, /--name 参数表示 Lark CLI 本地 profile 名称，不是飞书应用展示名称/);
  assert.doesNotMatch(prompt, /\.\/lark-cli\.sh config init[^\n]*--name/);
  assert.match(prompt, /完全访问（Full access）/);
  assert.ok(prompt.indexOf("完全访问（Full access）") < prompt.indexOf("1. 先做只读预检"));
  assert.match(prompt, /CLI 原样输出的该 URL 作为可点击的备用链接/);
  assert.match(prompt, /临时本机 loopback 备用 URL/);
  assert.match(prompt, /https:\/\/github\.com\/ninmon\/feishu-codex-bridge-private\.git/);
  assert.match(prompt, /tag：v0\.4\.0-macos-rc\.2/);
  assert.match(prompt, /setup-project-root\.sh/);
  assert.match(prompt, /没有明确要求“同机多用户”[^\n]*不要额外询问/);
  assert.match(prompt, /成功后 Bot 主动私聊成员并提示发送 `\/add`/);
});

test("macOS binding helper returns only a safe JSON error when no installation exists", async (t) => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-binding-home-"));
  t.after(() => fs.rm(temporaryHome, { recursive: true, force: true }));
  const script = path.join(repositoryRoot, "skills", "feishu-session-bind", "scripts", "request-binding.mjs");
  let output = "";
  try {
    ({ stdout: output } = await execFile(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, HOME: temporaryHome, FEISHU_CODEX_BRIDGE_HOME: "" },
    }));
  } catch (error) {
    output = error.stdout;
  }
  const response = JSON.parse(output);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "binding_request_unavailable");
  assert.deepEqual(response.error.missingScopes, []);
  assert.equal(output.includes(temporaryHome), false);
});

test("session binding skill documents both macOS and Windows entrypoints", async () => {
  const skill = await fs.readFile(path.join(repositoryRoot, "skills", "feishu-session-bind", "SKILL.md"), "utf8");
  assert.match(skill, /request-binding\.sh/);
  assert.match(skill, /request-binding\.ps1/);
});

test("macOS Desktop relay accepts only an explicit unauthenticated loopback proxy", () => {
  assert.equal(safeLoopbackProxyArgument("http://127.0.0.1:7897"), "--proxy-server=http://127.0.0.1:7897");
  assert.equal(safeLoopbackProxyArgument("socks5://localhost:1080"), "--proxy-server=socks5://localhost:1080");
  assert.equal(safeLoopbackProxyArgument("https://proxy.example.com:443"), undefined);
  assert.equal(safeLoopbackProxyArgument("http://user:password@127.0.0.1:7897"), undefined);
});

test("macOS Desktop launcher defaults to direct and enables proxy only when explicitly requested", () => {
  assert.deepEqual(desktopProxySelection(), { mode: "direct", proxyUrl: undefined });
  assert.deepEqual(desktopProxySelection({
    persistedValue: "http://127.0.0.1:7897",
  }), { mode: "direct", proxyUrl: undefined });
  assert.deepEqual(desktopProxySelection({
    requestedValue: "socks5://localhost:1080",
    persistedValue: "http://127.0.0.1:7897",
  }), { mode: "explicit", proxyUrl: "socks5://localhost:1080" });
  assert.deepEqual(desktopProxySelection({
    noProxy: true,
    persistedValue: "http://127.0.0.1:7897",
  }), { mode: "direct", proxyUrl: undefined });
  assert.throws(() => desktopProxySelection({
    noProxy: true,
    requestedValue: "http://127.0.0.1:7897",
  }), /cannot be combined/);
  assert.throws(() => desktopProxySelection({
    requestedValue: "https://proxy.example.com:443",
  }), /loopback URL/);
  assert.deepEqual(safeDesktopLaunchArguments(), []);
  assert.deepEqual(
    safeDesktopLaunchArguments("http://127.0.0.1:7897"),
    ["--proxy-server=http://127.0.0.1:7897"],
  );

  const proxyUrl = "http://127.0.0.1:7897";
  const completeProxyEnvironment = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ].map((name) => `${name}=${proxyUrl}`).join(" ");
  assert.equal(proxyEnvironmentMatches(completeProxyEnvironment, proxyUrl), true);
  assert.equal(proxyEnvironmentMatches("HTTP_PROXY=http://127.0.0.1:7897", proxyUrl), false);
  assert.equal(proxyEnvironmentMatches("CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:47321/rpc", undefined), true);
  assert.equal(proxyEnvironmentMatches("HTTP_PROXY=http://127.0.0.1:7897", undefined), false);
});

test("macOS Desktop launcher selects the first installed application bundle", async () => {
  const checked = [];
  const applications = [
    { bundlePath: "/Applications/Missing.app" },
    { bundlePath: "/Applications/Available.app" },
    { bundlePath: "/Applications/Later.app" },
  ];
  const selected = await installedDesktopBundlePath({
    applications,
    access: async (bundlePath) => {
      checked.push(bundlePath);
      if (bundlePath !== "/Applications/Available.app") throw new Error("missing");
    },
  });
  assert.equal(selected, "/Applications/Available.app");
  assert.deepEqual(checked, ["/Applications/Missing.app", "/Applications/Available.app"]);
});
