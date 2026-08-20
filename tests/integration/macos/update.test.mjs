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

async function git(cwd, args) {
  const { stdout } = await execFile("/usr/bin/git", args, { cwd, encoding: "utf8" });
  return String(stdout || "").trim();
}

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

async function commitRelease(repository, value, message, tag) {
  await fs.writeFile(path.join(repository, "release.txt"), `${value}\n`);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", message]);
  await git(repository, ["tag", tag]);
}

test("macOS updater preserves private state and rolls back a broken fixed tag", async (t) => {
  if (process.platform !== "darwin") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-bridge-macos-update-"));
  const source = path.join(root, "source");
  const installation = path.join(root, "install");
  const workspace = path.join(root, "runtime-root");
  const testHome = path.join(root, "home");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(testHome, { recursive: true });
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.email", "update-test@example.invalid"]);
  await git(source, ["config", "user.name", "macOS Update Test"]);
  await fs.cp(path.join(sourceRoot, "src", "runtime"), path.join(source, "src", "runtime"), {
    recursive: true,
    force: true,
  });
  await fs.writeFile(path.join(source, ".gitignore"), "bridge.config.json\n");
  await writeExecutable(path.join(source, "bootstrap.sh"), "#!/bin/sh\nexit 0\n");
  await writeExecutable(path.join(source, "install.sh"), [
    "#!/bin/sh",
    "set -eu",
    "if grep -q retry release.txt && [ ! -f \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_INSTALL_RETRY\" ]; then",
    "  /usr/bin/touch \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_INSTALL_RETRY\"",
    "  printf '%s\\n' 'macOS Bridge command failed: synthetic transient install failure' >&2",
    "  exit 31",
    "fi",
    "if grep -q broken release.txt; then",
    "  printf '%s\\n' target-only > \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_NEW_STATE\"",
    "  printf '%s\\n' target-only > \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_TEMPORARY_CHAT_STATE\"",
    "  printf '%s\\n' target-only > \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_ACCESS_STATE\"",
    "fi",
    "exit 0",
    "",
  ].join("\n"));
  await writeExecutable(path.join(source, "start-bridge.sh"), [
    "#!/bin/sh",
    "set -eu",
    "if [ \"${FEISHU_CODEX_BRIDGE_UPDATE_TEST_ASSERT_NO_RELAY_PLIST:-0}\" = 1 ]; then",
    "  test ! -e \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_PLIST\"",
    "fi",
    "/usr/bin/touch \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_RUNNING\"",
    "",
  ].join("\n"));
  await writeExecutable(path.join(source, "stop-bridge.sh"), "#!/bin/sh\nset -eu\n/bin/rm -f \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_RUNNING\"\n");
  await writeExecutable(path.join(source, "configure-codex-desktop-relay.sh"), [
    "#!/bin/sh",
    "set -eu",
    "/usr/bin/touch \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_MARKER\"",
    "/usr/bin/touch \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_PLIST\"",
    "",
  ].join("\n"));
  await writeExecutable(path.join(source, "doctor.sh"), [
    "#!/bin/sh",
    "set -eu",
    "printf '%s\\n' \"$*\" > \"$FEISHU_CODEX_BRIDGE_UPDATE_TEST_DOCTOR_ARGS\"",
    "if grep -q broken release.txt; then exit 23; fi",
    "exit 0",
    "",
  ].join("\n"));
  await commitRelease(source, "one", "release one", "v1.0.0");
  await commitRelease(source, "two", "release two", "v1.1.0");
  await commitRelease(source, "broken", "broken release", "v1.2.0");
  await commitRelease(source, "retry", "retry release", "v1.3.0");

  await git(root, ["clone", "--quiet", source, installation]);
  await git(installation, ["remote", "add", "private", source]);
  await git(installation, ["checkout", "--quiet", "--detach", "v1.0.0"]);
  const config = {
    schemaVersion: 4,
    mode: "session-relay",
    appId: "cli_update_smoke",
    workspace,
    agent: { ownerOpenId: "ou_update_smoke" },
    sessionRelay: { appServerUrl: "ws://127.0.0.1:47321/rpc", bindings: [] },
    nodeExecutable: process.execPath,
    codexExecutable: "/usr/bin/true",
  };
  const configPath = path.join(installation, "bridge.config.json");
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const runtime = path.join(workspace, "work", "feishu-codex-bridge");
  await fs.mkdir(path.join(runtime, "session-relay-inbound-attachments", "message"), { recursive: true });
  await fs.writeFile(path.join(runtime, "session-relay-settings.json"), '{"keep":"one"}\n', { mode: 0o600 });
  const temporaryChatState = path.join(runtime, "session-relay-temporary-chats.json");
  await fs.writeFile(temporaryChatState, '[{"keep":"chat-one"}]\n', { mode: 0o600 });
  const accessState = path.join(runtime, "session-relay-access.json");
  await fs.writeFile(accessState, '{"keep":"access-one"}\n', { mode: 0o600 });
  await fs.writeFile(path.join(runtime, "session-relay-inbound-attachments", "message", "sample.bin"), "attachment-state", { mode: 0o600 });
  const relayStatePath = path.join(testHome, "Library", "Application Support", "FeishuCodexBridge", "bootstrap", "desktop-relay-state.json");
  const relayPlistPath = path.join(testHome, "Library", "LaunchAgents", "com.feishu-codex-bridge.desktop-relay.plist");
  await fs.mkdir(path.dirname(relayStatePath), { recursive: true });
  await fs.mkdir(path.dirname(relayPlistPath), { recursive: true });
  await fs.writeFile(relayStatePath, '{"enabled":false,"keep":"relay"}\n', { mode: 0o600 });
  await fs.writeFile(relayPlistPath, "stale release relay\n", { mode: 0o600 });
  const runningMarker = path.join(runtime, "test-bridge-running");
  const relayMarker = path.join(runtime, "test-relay-configured");
  const doctorArgs = path.join(runtime, "test-doctor-args");
  const targetOnlyState = path.join(runtime, "session-relay-completed.json");
  const installRetryMarker = path.join(runtime, "test-install-retry");
  await fs.writeFile(runningMarker, "");
  const environment = {
    ...process.env,
    HOME: testHome,
    FEISHU_CODEX_BRIDGE_UPDATE_TEST: "1",
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY: "1",
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_RUNNING: runningMarker,
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_MARKER: relayMarker,
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY_PLIST: relayPlistPath,
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_ASSERT_NO_RELAY_PLIST: "1",
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_DOCTOR_ARGS: doctorArgs,
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_NEW_STATE: targetOnlyState,
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_TEMPORARY_CHAT_STATE: temporaryChatState,
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_ACCESS_STATE: accessState,
    FEISHU_CODEX_BRIDGE_UPDATE_TEST_INSTALL_RETRY: installRetryMarker,
  };

  const dirtyPath = path.join(installation, "local-user-change.txt");
  await fs.writeFile(dirtyPath, "preserve me\n");
  await assert.rejects(() => execFile(process.execPath, [
    path.join(installation, "src", "runtime", "platform", "macos", "update.mjs"), "--version", "v1.1.0", "--test-mode",
  ], { cwd: installation, env: environment, encoding: "utf8", timeout: 30_000 }), /exit code|Command failed/);
  assert.equal(await git(installation, ["rev-parse", "HEAD"]), await git(installation, ["rev-parse", "v1.0.0^{commit}"]));
  await fs.unlink(dirtyPath);

  const success = await execFile(process.execPath, [
    path.join(installation, "src", "runtime", "platform", "macos", "update.mjs"),
    "--version", "v1.1.0", "--remote", "private", "--test-mode",
  ], { cwd: installation, env: environment, encoding: "utf8", timeout: 30_000 });
  assert.match(success.stdout, /Upgrade completed successfully: v1\.1\.0/);
  assert.equal(success.stdout.includes(root), false);
  assert.equal(success.stdout.includes(config.appId), false);
  assert.equal(await git(installation, ["rev-parse", "HEAD"]), await git(installation, ["rev-parse", "v1.1.0^{commit}"]));
  assert.equal((await fs.readFile(path.join(installation, "release.txt"), "utf8")).trim(), "two");
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), config);
  assert.equal((await fs.readFile(path.join(runtime, "session-relay-settings.json"), "utf8")).trim(), '{"keep":"one"}');
  assert.equal((await fs.readFile(temporaryChatState, "utf8")).trim(), '[{"keep":"chat-one"}]');
  assert.equal((await fs.readFile(accessState, "utf8")).trim(), '{"keep":"access-one"}');
  assert.equal(await fs.readFile(path.join(runtime, "session-relay-inbound-attachments", "message", "sample.bin"), "utf8"), "attachment-state");
  assert.equal(await exists(runningMarker), true);
  assert.equal(await exists(relayMarker), true);
  assert.equal((await fs.readFile(doctorArgs, "utf8")).trim(), "--require-running --require-desktop-relay");

  await fs.rm(runningMarker, { force: true });
  const sameVersion = await execFile(process.execPath, [
    path.join(installation, "src", "runtime", "platform", "macos", "update.mjs"),
    "--version", "v1.1.0", "--remote", "private", "--test-mode",
  ], {
    cwd: installation,
    env: { ...environment, FEISHU_CODEX_BRIDGE_UPDATE_TEST_ASSERT_NO_RELAY_PLIST: "0" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.match(sameVersion.stdout, /v1\.1\.0 is already installed/);
  assert.equal(await exists(runningMarker), true);
  assert.equal((await fs.readFile(doctorArgs, "utf8")).trim(), "--require-running --require-desktop-relay");

  const retried = await execFile(process.execPath, [
    path.join(installation, "src", "runtime", "platform", "macos", "update.mjs"),
    "--version", "v1.3.0", "--remote", "private", "--test-mode",
  ], { cwd: installation, env: environment, encoding: "utf8", timeout: 30_000 });
  assert.match(retried.stdout, /Upgrade completed successfully: v1\.3\.0/);
  assert.match(retried.stderr, /retrying the idempotent installation once/);
  assert.equal(await exists(installRetryMarker), true);
  assert.equal(await git(installation, ["rev-parse", "HEAD"]), await git(installation, ["rev-parse", "v1.3.0^{commit}"]));

  await fs.writeFile(path.join(runtime, "session-relay-settings.json"), '{"keep":"two"}\n', { mode: 0o600 });
  await fs.writeFile(temporaryChatState, '[{"keep":"chat-two"}]\n', { mode: 0o600 });
  await fs.writeFile(accessState, '{"keep":"access-two"}\n', { mode: 0o600 });
  let failure;
  try {
    await execFile(process.execPath, [
      path.join(installation, "src", "runtime", "platform", "macos", "update.mjs"), "--version", "v1.2.0", "--test-mode",
    ], { cwd: installation, env: environment, encoding: "utf8", timeout: 30_000 });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.match(String(failure.stderr), /previous release and local state were restored/);
  assert.equal(String(failure.stderr).includes(root), false);
  assert.equal(await git(installation, ["rev-parse", "HEAD"]), await git(installation, ["rev-parse", "v1.3.0^{commit}"]));
  assert.equal((await fs.readFile(path.join(installation, "release.txt"), "utf8")).trim(), "retry");
  assert.equal((await fs.readFile(path.join(runtime, "session-relay-settings.json"), "utf8")).trim(), '{"keep":"two"}');
  assert.equal((await fs.readFile(temporaryChatState, "utf8")).trim(), '[{"keep":"chat-two"}]');
  assert.equal((await fs.readFile(accessState, "utf8")).trim(), '{"keep":"access-two"}');
  assert.equal(JSON.parse(await fs.readFile(relayStatePath, "utf8")).keep, "relay");
  assert.equal(await exists(targetOnlyState), false);
  const backupRoot = path.join(runtime, "upgrade-backups");
  assert.ok((await fs.readdir(backupRoot)).length >= 2);
});

async function exists(filePath) {
  try { await fs.access(filePath); return true; }
  catch { return false; }
}
