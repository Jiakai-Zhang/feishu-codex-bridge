import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensurePrivateDirectory,
  writeJsonAtomic,
} from "../../shared/private-state.mjs";
import { parseLoopbackAppServerUrl } from "../../shared/network-probes.mjs";
import { safeError } from "../../shared/safe-error.mjs";
import {
  assertMacOS,
  MACOS_LABELS,
  RELAY_ENVIRONMENT_VARIABLE,
} from "./constants.mjs";
import {
  bootoutLaunchAgent,
  getLaunchEnvironment,
  setLaunchAgentEnabled,
  unsetLaunchEnvironmentIfOwned,
} from "./launchd-service-manager.mjs";
import {
  embeddedDesktopAppServerRunning,
  runningDesktopApplications,
} from "./desktop-runtime.mjs";
import { isExpectedProcess, readPid } from "./process-inspector.mjs";
import { readBridgeConfig, runtimeLayout } from "./runtime-layout.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "../../../..");
const VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const PERSISTENT_FILES = Object.freeze([
  "completed.json",
  "pending-deliveries.json",
  "pending-agent-events.json",
  "audit.jsonl",
  "task-leases.json",
  "team-tasks.json",
  "temporary-chat.json",
  "session-relay-completed.json",
  "session-relay-pending-deliveries.json",
  "session-relay-input-ledger.json",
  "session-relay-prompt-queue.json",
  "session-relay-settings.json",
  "session-relay-long-answer-documents.json",
  "session-relay-stream-cards.json",
  "session-relay-attachment-drafts.json",
]);
const PERSISTENT_DIRECTORIES = Object.freeze([
  "session-relay-inbound-attachments",
  "session-binding-requests",
  "collaboration-inbox",
]);

function optionMap(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected update argument: ${token}`);
    const separator = token.indexOf("=");
    if (separator > 2) {
      options.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const name = token.slice(2);
    if (args[index + 1] != null && !args[index + 1].startsWith("--")) options.set(name, args[++index]);
    else options.set(name, true);
  }
  return options;
}

function approvedOrigin(value) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(?:ninmon|Jiakai-Zhang)\/feishu-codex-bridge(?:\.git)?\/?$/i.test(String(value || ""));
}

export async function assertSafeUpdateContext({
  testMode = false,
  environment = process.env,
  listDesktopApplications = runningDesktopApplications,
  isEmbeddedDesktopAppServerRunning = embeddedDesktopAppServerRunning,
} = {}) {
  if (testMode) return;
  if (environment.CODEX_THREAD_ID || environment.CODEX_SESSION_ID) {
    throw new Error("Run update.sh from an independent Terminal, not from inside an active Codex task.");
  }
  const [desktopApplications, embeddedAppServer] = await Promise.all([
    listDesktopApplications(),
    isEmbeddedDesktopAppServerRunning(),
  ]);
  if (desktopApplications.length > 0 || embeddedAppServer) {
    throw new Error("Fully quit ChatGPT/Codex Desktop before updating, then run update.sh from an independent Terminal.");
  }
}

function runFile(executable, args, { cwd = repositoryRoot, capture = false, allowFailure = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { if (stdout.length < 4_000_000) stdout += chunk; });
      child.stderr.on("data", (chunk) => { if (stderr.length < 1_000_000) stderr += chunk; });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { ok: code === 0, code: code ?? 1, stdout, stderr };
      if (result.ok || allowFailure) resolve(result);
      else reject(new Error(`${path.basename(executable)} ${args[0] || "command"} failed with exit code ${result.code}.`));
    });
  });
}

async function git(args, options = {}) {
  return runFile("/usr/bin/git", ["-C", repositoryRoot, ...args], { ...options, capture: true });
}

async function gitText(args) {
  return (await git(args)).stdout.trim();
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; }
  catch { return false; }
}

async function copyPrivateTree(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error("A persistent update path is a symbolic link; refusing an unsafe backup.");
  if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination);
    await fs.chmod(destination, 0o600);
    return;
  }
  if (!stat.isDirectory()) throw new Error("A persistent update path has an unsupported file type.");
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.chmod(destination, 0o700);
  for (const entry of await fs.readdir(source)) {
    await copyPrivateTree(path.join(source, entry), path.join(destination, entry));
  }
}

async function createBackup({ configPath, layout, sourceCommit, targetVersion }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safeVersion = targetVersion.replace(/[^0-9A-Za-z.-]/g, "_");
  const backupDirectory = path.join(layout.runtimeDir, "upgrade-backups", `${stamp}-${safeVersion}-${randomUUID().slice(0, 8)}`);
  const runtimeBackup = path.join(backupDirectory, "runtime");
  await fs.mkdir(runtimeBackup, { recursive: true, mode: 0o700 });
  await copyPrivateTree(configPath, path.join(backupDirectory, "bridge.config.json"));
  const copied = [];
  for (const name of PERSISTENT_FILES) {
    const source = path.join(layout.runtimeDir, name);
    if (!(await exists(source))) continue;
    await copyPrivateTree(source, path.join(runtimeBackup, name));
    copied.push(name);
  }
  let runtimeEntries = [];
  try { runtimeEntries = await fs.readdir(layout.runtimeDir); } catch {}
  for (const name of runtimeEntries.filter((entry) => /^selected-thread(?:\..+)?\.json$/.test(entry))) {
    if (copied.includes(name)) continue;
    await copyPrivateTree(path.join(layout.runtimeDir, name), path.join(runtimeBackup, name));
    copied.push(name);
  }
  for (const name of PERSISTENT_DIRECTORIES) {
    const source = path.join(layout.runtimeDir, name);
    if (!(await exists(source))) continue;
    await copyPrivateTree(source, path.join(runtimeBackup, name));
    copied.push(`${name}/`);
  }
  if (await exists(layout.relayStatePath)) {
    await copyPrivateTree(layout.relayStatePath, path.join(backupDirectory, "desktop-relay-state.json"));
  }
  await writeJsonAtomic(path.join(backupDirectory, "manifest.json"), {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceCommit,
    targetVersion,
    files: copied,
    relayState: await exists(layout.relayStatePath),
  });
  return backupDirectory;
}

async function restoreBackup({ backupDirectory, configPath, layout }) {
  await fs.rm(configPath, { recursive: true, force: true });
  await copyPrivateTree(path.join(backupDirectory, "bridge.config.json"), configPath);
  const manifest = JSON.parse(await fs.readFile(path.join(backupDirectory, "manifest.json"), "utf8"));
  for (const name of [...PERSISTENT_FILES, ...PERSISTENT_DIRECTORIES]) {
    await fs.rm(path.join(layout.runtimeDir, name), { recursive: true, force: true });
  }
  let runtimeEntries = [];
  try { runtimeEntries = await fs.readdir(layout.runtimeDir); } catch {}
  for (const name of runtimeEntries.filter((entry) => /^selected-thread(?:\..+)?\.json$/.test(entry))) {
    await fs.rm(path.join(layout.runtimeDir, name), { recursive: true, force: true });
  }
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    const name = String(entry).replace(/\/$/, "");
    if (![...PERSISTENT_FILES, ...PERSISTENT_DIRECTORIES].includes(name)
      && !/^selected-thread(?:\..+)?\.json$/.test(name)) continue;
    const source = path.join(backupDirectory, "runtime", name);
    if (await exists(source)) await copyPrivateTree(source, path.join(layout.runtimeDir, name));
  }
  const relayBackup = path.join(backupDirectory, "desktop-relay-state.json");
  await fs.rm(layout.relayStatePath, { recursive: true, force: true });
  if (manifest.relayState && await exists(relayBackup)) await copyPrivateTree(relayBackup, layout.relayStatePath);
}

async function serviceState(config, layout, testMode) {
  if (testMode) {
    return {
      bridgeRunning: await exists(path.join(layout.runtimeDir, "test-bridge-running")),
      relayEnabled: process.env.FEISHU_CODEX_BRIDGE_UPDATE_TEST_RELAY === "1",
    };
  }
  const [bridgePid, supervisorPid] = await Promise.all([
    readPid(layout.bridgePidPath),
    readPid(layout.supervisorPidPath),
  ]);
  const nodeExecutable = path.resolve(repositoryRoot, String(config.nodeExecutable));
  const entry = config.mode === "session-relay" ? "session-relay.mjs" : "channel-bridge.mjs";
  const [bridgeRunning, supervisorRunning] = await Promise.all([
    bridgePid ? isExpectedProcess(bridgePid, [nodeExecutable, entry]) : false,
    supervisorPid ? isExpectedProcess(supervisorPid, [nodeExecutable, "bridge-supervisor-entry.mjs"]) : false,
  ]);
  const endpoint = parseLoopbackAppServerUrl(config.sessionRelay?.appServerUrl);
  let relayState;
  try { relayState = JSON.parse(await fs.readFile(layout.relayStatePath, "utf8")); } catch {}
  const pointer = await getLaunchEnvironment(RELAY_ENVIRONMENT_VARIABLE);
  return {
    bridgeRunning: bridgeRunning || supervisorRunning,
    relayEnabled: Boolean(relayState?.enabled && pointer === endpoint.href),
  };
}

async function runRepositoryScript(name, args = []) {
  const filePath = path.join(repositoryRoot, name);
  await fs.access(filePath);
  return runFile(filePath, args);
}

async function runDoctor({ running, relay }) {
  const args = [];
  if (running) args.push("--require-running");
  if (relay) args.push("--require-desktop-relay");
  await runRepositoryScript("doctor.sh", args);
}

async function quiesceCurrentServices(layout, endpoint, testMode) {
  if (testMode) return;
  await Promise.all([
    bootoutLaunchAgent(MACOS_LABELS.relay),
    bootoutLaunchAgent(MACOS_LABELS.bridge),
    bootoutLaunchAgent(MACOS_LABELS.appServer),
  ]);
  await Promise.all([
    setLaunchAgentEnabled(MACOS_LABELS.relay, false),
    setLaunchAgentEnabled(MACOS_LABELS.bridge, false),
    setLaunchAgentEnabled(MACOS_LABELS.appServer, false),
  ]);
  await unsetLaunchEnvironmentIfOwned(RELAY_ENVIRONMENT_VARIABLE, endpoint.href);
}

function assertTestMode(testMode) {
  if (!testMode) return;
  const temporaryRoot = fs.realpath(os.tmpdir());
  return temporaryRoot.then(async (resolvedTemporaryRoot) => {
    const resolvedRepository = await fs.realpath(repositoryRoot);
    const relative = path.relative(resolvedTemporaryRoot, resolvedRepository);
    const container = relative.split(path.sep)[0];
    if (process.env.FEISHU_CODEX_BRIDGE_UPDATE_TEST !== "1"
      || relative.startsWith("..") || path.isAbsolute(relative)
      || !container.startsWith("feishu-bridge-macos-update-")) {
      throw new Error("Test mode is restricted to the macOS updater smoke-test directory.");
    }
  });
}

export async function runMacOSUpdate(args = process.argv.slice(2)) {
  assertMacOS();
  const options = optionMap(args);
  for (const name of options.keys()) {
    if (!["version", "start-bridge", "test-mode"].includes(name)) throw new Error(`Unknown update option: --${name}`);
  }
  const version = String(options.get("version") || "");
  const startRequested = options.has("start-bridge");
  const testMode = options.has("test-mode");
  if (!VERSION_PATTERN.test(version)) throw new Error("--version must be an explicit semantic release tag such as v1.2.3.");
  await assertTestMode(testMode);
  await assertSafeUpdateContext({ testMode });

  const gitDirectory = path.join(repositoryRoot, ".git");
  if (!(await exists(gitDirectory))) throw new Error("This updater must run from a Git checkout of Feishu Codex Bridge.");
  const origin = await gitText(["remote", "get-url", "origin"]);
  if (!testMode && !approvedOrigin(origin)) throw new Error("The origin remote is not an approved Feishu Codex Bridge repository.");
  const dirty = await gitText(["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty) throw new Error("The installation has tracked or untracked changes; preserve them separately before updating.");

  const { raw: config, configPath } = await readBridgeConfig(repositoryRoot);
  if (config.mode !== "session-relay") throw new Error("The existing installation is not in session-relay mode.");
  const layout = runtimeLayout(repositoryRoot, config);
  const endpoint = parseLoopbackAppServerUrl(config.sessionRelay?.appServerUrl);
  await ensurePrivateDirectory(layout.runtimeDir);
  const state = await serviceState(config, layout, testMode);
  const shouldStart = state.bridgeRunning || startRequested;

  const previousCommit = await gitText(["rev-parse", "--verify", "HEAD"]);
  await git(["fetch", "--quiet", "origin", `refs/tags/${version}:refs/tags/${version}`]);
  const targetCommit = await gitText(["rev-parse", "--verify", `refs/tags/${version}^{commit}`]);
  if (targetCommit === previousCommit) {
    process.stdout.write(`${version} is already installed.\n`);
    if (startRequested && !state.bridgeRunning) await runRepositoryScript("start-bridge.sh");
    await runDoctor({ running: state.bridgeRunning || startRequested, relay: state.relayEnabled });
    return;
  }

  let backupDirectory;
  let checkoutChanged = false;
  let bridgeStopped = false;
  try {
    if (state.bridgeRunning) {
      await runRepositoryScript("stop-bridge.sh");
      bridgeStopped = true;
    }
    backupDirectory = await createBackup({ configPath, layout, sourceCommit: previousCommit, targetVersion: version });
    process.stdout.write("Created a private local recovery backup of configuration and relay state.\n");

    await git(["checkout", "--quiet", "--detach", targetCommit]);
    checkoutChanged = true;
    await runRepositoryScript("bootstrap.sh");
    await runRepositoryScript("install.sh", ["--skip-dependency-install"]);
    if (shouldStart) {
      await runRepositoryScript("start-bridge.sh");
      if (state.relayEnabled) await runRepositoryScript("configure-codex-desktop-relay.sh");
    }
    await runDoctor({ running: shouldStart, relay: state.relayEnabled && shouldStart });
    if (await gitText(["rev-parse", "--verify", "HEAD"]) !== targetCommit) {
      throw new Error("The checked-out commit changed during verification.");
    }
    process.stdout.write(`Upgrade completed successfully: ${version}.\n`);
    if (!shouldStart) process.stdout.write("The Bridge was stopped before the upgrade and remains stopped.\n");
  } catch (error) {
    const updateError = safeError(error);
    let rollbackError;
    try {
      await quiesceCurrentServices(layout, endpoint, testMode);
      if (checkoutChanged) await git(["checkout", "--quiet", "--detach", previousCommit]);
      if (backupDirectory) await restoreBackup({ backupDirectory, configPath, layout });
      if (checkoutChanged) {
        await runRepositoryScript("bootstrap.sh");
        await runRepositoryScript("install.sh", ["--skip-dependency-install"]);
      }
      if (shouldStart) {
        await runRepositoryScript("start-bridge.sh");
        if (state.relayEnabled) await runRepositoryScript("configure-codex-desktop-relay.sh");
      }
      await runDoctor({ running: shouldStart, relay: state.relayEnabled && shouldStart });
    } catch (rollbackFailure) {
      rollbackError = safeError(rollbackFailure);
    }
    if (rollbackError) {
      throw new Error(`Upgrade failed and automatic rollback also failed. Upgrade: ${updateError} Rollback: ${rollbackError}`);
    }
    if (checkoutChanged || bridgeStopped) {
      throw new Error(`Upgrade failed; the previous release and local state were restored. Cause: ${updateError}`);
    }
    throw new Error(`Upgrade failed before the installation changed. Cause: ${updateError}`);
  }
}

const invokedPath = await fs.realpath(path.resolve(process.argv[1] || "")).catch(() => path.resolve(process.argv[1] || ""));
const resolvedModulePath = await fs.realpath(modulePath).catch(() => modulePath);
if (invokedPath === resolvedModulePath) {
  try { await runMacOSUpdate(); }
  catch (error) {
    process.stderr.write(`macOS update failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  }
}
