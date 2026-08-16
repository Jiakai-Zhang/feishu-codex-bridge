import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("macOS installer creates a valid private config and launchd package without exposing identities", async (t) => {
  if (process.platform !== "darwin") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-macos-install-smoke-"));
  const repositoryRoot = path.join(root, "repo");
  const testHome = path.join(root, "home");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(repositoryRoot, { recursive: true });
  await fs.mkdir(testHome, { recursive: true });
  const resolvedRepositoryRoot = await fs.realpath(repositoryRoot);
  await fs.cp(path.join(sourceRoot, "src"), path.join(repositoryRoot, "src"), {
    recursive: true,
    force: true,
  });
  for (const name of [
    "channel-bridge.mjs",
    "session-relay.mjs",
    "request-session-binding.mjs",
  ]) {
    await fs.copyFile(path.join(sourceRoot, name), path.join(repositoryRoot, name));
  }

  const larkEntry = path.join(repositoryRoot, "node_modules", "@larksuite", "cli", "scripts", "run.js");
  await fs.mkdir(path.dirname(larkEntry), { recursive: true });
  await fs.writeFile(larkEntry, [
    'const args = process.argv.slice(2);',
    'if (args[0] === "auth") console.log(JSON.stringify({',
    '  appId: "cli_smoke_test",',
    '  identities: {',
    '    user: { available: true, verified: true, openId: "ou_smoke_owner", scope: "im:feed_group_v1:read im:feed_group_v1:write docx:document:create docx:document:write_only" },',
    '    bot: { available: true, verified: true, openId: "ou_smoke_bot" },',
    '  },',
    '}));',
    'else console.log(JSON.stringify({ available: true, appId: "cli_smoke_test", onBehalfOf: { openId: "ou_smoke_owner" } }));',
    '',
  ].join("\n"));

  const codex = path.join(root, "codex-test");
  await fs.writeFile(codex, '#!/bin/sh\nprintf "%s\\n" "      --listen <URL>"\n', { mode: 0o755 });
  const { stdout, stderr } = await execFile(process.execPath, [
    path.join(repositoryRoot, "src", "runtime", "platform", "macos", "admin-cli.mjs"),
    "install",
    "--skip-dependency-install",
    "--no-user-changes",
    "--force-config",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: testHome, CODEX_EXECUTABLE: codex },
    timeout: 30_000,
  });
  assert.match(stdout, /installation prepared/);
  assert.equal(`${stdout}\n${stderr}`.includes("cli_smoke_test"), false);
  assert.equal(`${stdout}\n${stderr}`.includes("ou_smoke_owner"), false);

  const configPath = path.join(repositoryRoot, "bridge.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.mode, "session-relay");
  assert.equal(config.schemaVersion, 4);
  assert.equal(config.sessionRelay.inboundAttachments.enabled, true);
  assert.equal("appSecret" in config, false);
  assert.equal("secret" in config, false);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);

  const privateDirectories = [
    config.workspace,
    path.join(config.workspace, "work", "feishu-codex-bridge"),
    path.join(testHome, "Library", "Application Support", "FeishuCodexBridge", "installation"),
    path.join(testHome, "Library", "Application Support", "FeishuCodexBridge", "bootstrap"),
    path.join(testHome, "Library", "Logs", "FeishuCodexBridge"),
  ];
  for (const directory of privateDirectories) {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  }

  const launchAgents = path.join(testHome, "Library", "LaunchAgents");
  const plistNames = [
    "com.feishu-codex-bridge.environment.plist",
    "com.feishu-codex-bridge.app-server.plist",
    "com.feishu-codex-bridge.bridge.plist",
  ];
  for (const name of plistNames) {
    const plistPath = path.join(launchAgents, name);
    assert.equal((await fs.stat(plistPath)).mode & 0o777, 0o600);
    await execFile("/usr/bin/plutil", ["-lint", plistPath]);
    const plist = await fs.readFile(plistPath, "utf8");
    assert.equal(plist.includes("LARK_APP_SECRET"), false);
    assert.equal(plist.includes(resolvedRepositoryRoot), false);
  }

  const installation = path.join(testHome, "Library", "Application Support", "FeishuCodexBridge", "installation");
  const stagedConfigPath = path.join(installation, "bridge.config.json");
  let stagedConfig = JSON.parse(await fs.readFile(stagedConfigPath, "utf8"));
  assert.equal(stagedConfig.macosKeychainRepositoryRoot, resolvedRepositoryRoot);
  assert.equal(stagedConfig.larkCliEntry, path.join(installation, "node_modules", "@larksuite", "cli", "scripts", "run.js"));
  assert.equal((await fs.stat(stagedConfigPath)).mode & 0o777, 0o600);
  await fs.access(path.join(installation, "src", "runtime", "platform", "macos", "app-server-entry.mjs"));
  await fs.access(path.join(installation, "src", "runtime", "platform", "macos", "launch-environment.mjs"));
  await fs.access(stagedConfig.larkCliEntry);

  stagedConfig.sessionRelay.bindings = [{
    groupChatId: "oc_runtime_binding",
    threadId: "019ff5b8-decb-7ca3-802c-f115f2f196de",
    ownerOpenId: "ou_runtime_owner",
  }];
  await fs.writeFile(stagedConfigPath, `${JSON.stringify(stagedConfig, null, 2)}\n`, { mode: 0o600 });
  const relayStatePath = path.join(testHome, "Library", "Application Support", "FeishuCodexBridge", "bootstrap", "desktop-relay-state.json");
  await fs.writeFile(relayStatePath, `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    url: "ws://127.0.0.1:47321/rpc",
    desktopProxyUrl: "http://127.0.0.1:7788",
  }, null, 2)}\n`, { mode: 0o600 });
  await execFile(process.execPath, [
    path.join(repositoryRoot, "src", "runtime", "platform", "macos", "admin-cli.mjs"),
    "install",
    "--skip-dependency-install",
    "--no-user-changes",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: testHome, CODEX_EXECUTABLE: codex },
    timeout: 30_000,
  });
  stagedConfig = JSON.parse(await fs.readFile(stagedConfigPath, "utf8"));
  assert.equal(stagedConfig.sessionRelay.bindings.length, 1);
  assert.equal(stagedConfig.sessionRelay.bindings[0].groupChatId, "oc_runtime_binding");
  const appServerPlist = await fs.readFile(path.join(launchAgents, "com.feishu-codex-bridge.app-server.plist"), "utf8");
  const bridgePlist = await fs.readFile(path.join(launchAgents, "com.feishu-codex-bridge.bridge.plist"), "utf8");
  assert.match(appServerPlist, /<key>HTTP_PROXY<\/key><string>http:\/\/127\.0\.0\.1:7788<\/string>/);
  assert.match(appServerPlist, /<key>NO_PROXY<\/key><string>127\.0\.0\.1,localhost,::1<\/string>/);
  assert.equal(bridgePlist.includes("HTTP_PROXY"), false);
});
