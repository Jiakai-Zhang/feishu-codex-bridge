import { execFile as nodeExecFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseLoopbackAppServerUrl } from "../../shared/network-probes.mjs";
import {
  ensurePrivateDirectory,
  writeFileAtomic,
  writeJsonAtomic,
} from "../../shared/private-state.mjs";
import { safeError } from "../../shared/safe-error.mjs";
import { waitUntil } from "../../shared/wait-until.mjs";
import {
  embeddedDesktopAppServerRunning,
  installedDesktopApplications,
  processProxyEnvironmentMatches,
  relayHeartbeatReady,
  runningDesktopApplications,
  safeLoopbackProxyArgument,
} from "./desktop-runtime.mjs";
import { directNetworkEnvironment } from "./launch-environment.mjs";
import { pidIsRunning, readPid } from "./process-inspector.mjs";
import { readBridgeConfig, runtimeLayout } from "./runtime-layout.mjs";

const execFile = promisify(nodeExecFile);
const modulePath = fileURLToPath(import.meta.url);
const moduleRepositoryRoot = path.resolve(path.dirname(modulePath), "../../../..");
const VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const RUN_ID_PATTERN = /^[0-9a-f]{32}$/;

function foregroundStateRoot() {
  return path.join(os.homedir(), "Library", "Application Support", "FeishuCodexBridge", "foreground-upgrade");
}

function requestPath(stateRoot, runId) {
  return path.join(stateRoot, `${runId}.request.json`);
}

function statusPath(stateRoot, runId) {
  return path.join(stateRoot, `${runId}.status.json`);
}

function commandPath(stateRoot, runId) {
  return path.join(stateRoot, `${runId}.command`);
}

async function assertNoActiveForegroundUpdate(stateRoot) {
  let entries = [];
  try { entries = await fs.readdir(stateRoot); } catch {}
  for (const entry of entries.filter((name) => RUN_ID_PATTERN.test(name.replace(/\.request\.json$/, "")))) {
    const existingRunId = entry.replace(/\.request\.json$/, "");
    try {
      const [request, status] = await Promise.all([
        fs.readFile(requestPath(stateRoot, existingRunId), "utf8").then(JSON.parse),
        fs.readFile(statusPath(stateRoot, existingRunId), "utf8").then(JSON.parse).catch(() => undefined),
      ]);
      if (pidIsRunning(Number(status?.workerPid)) || pidIsRunning(Number(request?.coordinatorPid))) {
        throw new Error("Another visible Bridge foreground upgrade is still active.");
      }
    } catch (error) {
      if (error?.message === "Another visible Bridge foreground upgrade is still active.") throw error;
    }
  }
}

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error("Unexpected foreground update argument.");
    const separator = token.indexOf("=");
    if (separator > 2) {
      values.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const name = token.slice(2);
    if (args[index + 1] != null && !args[index + 1].startsWith("--")) values.set(name, args[++index]);
    else values.set(name, true);
  }
  for (const name of values.keys()) {
    if (!["version", "remote", "worker", "run-id"].includes(name)) throw new Error(`Unknown foreground update option: --${name}`);
  }
  return values;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function runFile(executable, args, {
  cwd,
  capture = false,
  allowFailure = false,
  env = process.env,
} = {}) {
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
      child.stdout.on("data", (chunk) => { if (stdout.length < 2_000_000) stdout += chunk; });
      child.stderr.on("data", (chunk) => { if (stderr.length < 512_000) stderr += chunk; });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { ok: code === 0, code: code ?? 1, stdout, stderr };
      if (result.ok || allowFailure) resolve(result);
      else reject(new Error(`${path.basename(executable)} ${args[0] || "command"} failed.`));
    });
  });
}

async function git(repositoryRoot, args) {
  const result = await runFile("/usr/bin/git", ["-C", repositoryRoot, ...args], {
    cwd: repositoryRoot,
    capture: true,
  });
  return result.stdout.trim();
}

async function writeStatus(stateRoot, runId, version, state, detail, succeeded) {
  const value = {
    schemaVersion: 1,
    runId,
    targetVersion: version,
    state,
    detail,
    workerPid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  if (succeeded != null) value.succeeded = Boolean(succeeded);
  await writeJsonAtomic(statusPath(stateRoot, runId), value);
}

async function strictDoctor(repositoryRoot, { attached = false } = {}) {
  const args = ["--require-running", "--require-desktop-relay"];
  if (attached) args.push("--require-desktop-attached");
  await runFile(path.join(repositoryRoot, "doctor.sh"), args, {
    cwd: repositoryRoot,
    env: directNetworkEnvironment(),
  });
}

export async function readSavedDesktopNetwork(repositoryRoot) {
  const { raw: config } = await readBridgeConfig(repositoryRoot);
  const layout = runtimeLayout(repositoryRoot, config);
  const endpoint = parseLoopbackAppServerUrl(config.sessionRelay?.appServerUrl);
  const activation = JSON.parse(await fs.readFile(layout.relayStatePath, "utf8"));
  if (activation.enabled !== true || activation.url !== endpoint.href) {
    throw new Error("The saved Desktop relay state does not match this installation.");
  }
  if (!(await relayHeartbeatReady(layout, endpoint.href))) {
    throw new Error("The Desktop relay watchdog is not healthy.");
  }
  const rawProxy = String(activation.desktopProxyUrl || "").trim();
  const proxyArgument = rawProxy ? safeLoopbackProxyArgument(rawProxy) : undefined;
  if (rawProxy && !proxyArgument) throw new Error("The saved Desktop proxy is not a safe loopback URL.");
  const proxyUrl = proxyArgument?.slice("--proxy-server=".length);
  const appServerPid = await readPid(layout.appServerPidPath);
  if (!appServerPid || !(await processProxyEnvironmentMatches(appServerPid, proxyUrl))) {
    throw new Error("The active App Server network mode does not match the saved Desktop selection.");
  }
  return Object.freeze({ mode: proxyUrl ? "proxy" : "direct", proxyUrl });
}

async function runTargetUpdater(repositoryRoot, runId, version, remote, preflightOnly = false) {
  process.env.FEISHU_CODEX_BRIDGE_FOREGROUND_UPDATE = "1";
  process.env.FEISHU_CODEX_BRIDGE_FOREGROUND_INSTALL_ROOT = repositoryRoot;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_SESSION_ID;
  const target = await import(`./update.mjs?foreground=${runId}`);
  const args = ["--version", version, "--remote", remote];
  if (preflightOnly) args.push("--preflight-only");
  await target.runMacOSUpdate(args);
}

async function verifyExactInstallation(repositoryRoot, version) {
  const [installedCommit, targetCommit, dirty] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]),
    git(repositoryRoot, ["rev-parse", "--verify", `refs/tags/${version}^{commit}`]),
    git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]),
  ]);
  if (installedCommit !== targetCommit) throw new Error("The installed commit does not match the requested release tag.");
  if (dirty) throw new Error("The target release left the installation worktree dirty.");
}

async function launchDesktop(repositoryRoot) {
  await runFile(path.join(repositoryRoot, "launch-codex-desktop-with-relay.sh"), ["--preserve-network"], {
    cwd: repositoryRoot,
  });
}

function safeFailureText(error, privatePaths) {
  let message = safeError(error);
  for (const privatePath of privatePaths) {
    if (privatePath) message = message.replaceAll(String(privatePath), "<local-path>");
  }
  return message;
}

async function safeRemoveSourceRoot(sourceRoot) {
  try {
    const temporaryRoot = await fs.realpath(os.tmpdir());
    const resolved = await fs.realpath(sourceRoot);
    const relative = path.relative(temporaryRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)
      || !path.basename(resolved).startsWith("feishu-bridge-macos-foreground-")) return;
    await fs.rm(resolved, { recursive: true, force: true });
  } catch {}
}

async function waitForDesktopExit(applications) {
  return waitUntil(async () => {
    const [running, embedded] = await Promise.all([
      runningDesktopApplications({ applications }),
      embeddedDesktopAppServerRunning({ applications }),
    ]);
    return running.length === 0 && !embedded;
  }, 30 * 60_000, 500);
}

async function invokeWorker(runId) {
  const stateRoot = foregroundStateRoot();
  const recordedRequestPath = requestPath(stateRoot, runId);
  const request = JSON.parse(await fs.readFile(recordedRequestPath, "utf8"));
  const repositoryRoot = path.resolve(String(request.installRoot || ""));
  const sourceRoot = path.resolve(String(request.sourceRoot || ""));
  const version = String(request.version || "");
  const remote = String(request.remote || "");
  if (request.schemaVersion !== 1 || request.runId !== runId || !RUN_ID_PATTERN.test(runId)
    || !VERSION_PATTERN.test(version) || !["origin", "private"].includes(remote)
    || sourceRoot !== moduleRepositoryRoot) {
    throw new Error("The foreground update request identity is invalid.");
  }
  const privatePaths = [repositoryRoot, sourceRoot, stateRoot, os.homedir()];
  let desktopExited = false;
  let network;
  try {
    process.stdout.write("\u001b]0;Feishu Codex Bridge upgrade\u0007");
    process.stdout.write("Feishu Codex Bridge foreground upgrade\n");
    process.stdout.write("Running safety preflight. Keep Codex Desktop open until this window asks you to quit it.\n");
    await writeStatus(stateRoot, runId, version, "preflighting", "Checking the exact release, worktree, relay, and network state.");
    await fs.access(path.join(repositoryRoot, ".git"));
    await strictDoctor(repositoryRoot, { attached: true });
    await runTargetUpdater(repositoryRoot, runId, version, remote, true);
    network = await readSavedDesktopNetwork(repositoryRoot);
    const installed = await installedDesktopApplications();
    const running = await runningDesktopApplications({ applications: installed });
    if (running.length === 0) throw new Error("ChatGPT/Codex Desktop is not running from an approved application bundle.");
    const applications = running.map(({ pids: _pids, commands: _commands, ...application }) => application);

    await writeStatus(stateRoot, runId, version, "waiting-for-desktop-exit", "Preflight passed; waiting for the user to fully quit Desktop.");
    process.stdout.write("\nPreflight passed.\n");
    process.stdout.write("Now fully quit ChatGPT/Codex Desktop with Command-Q. Do not reopen it yourself.\n");
    process.stdout.write("This Terminal window will update, preserve the network mode, and reopen Desktop automatically.\n");
    if (!(await waitForDesktopExit(applications))) throw new Error("Desktop was not fully quit within 30 minutes.");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const [restarted, embedded] = await Promise.all([
      runningDesktopApplications({ applications }),
      embeddedDesktopAppServerRunning({ applications }),
    ]);
    if (restarted.length > 0 || embedded) throw new Error("Desktop restarted before the foreground updater could begin.");
    desktopExited = true;

    await writeStatus(stateRoot, runId, version, "updating", "Desktop exited; running the transactional updater.");
    process.stdout.write("Desktop exited. Running the transactional update...\n");
    await runTargetUpdater(repositoryRoot, runId, version, remote, false);
    await verifyExactInstallation(repositoryRoot, version);
    await strictDoctor(repositoryRoot);

    await writeStatus(stateRoot, runId, version, "launching-desktop", "The update passed Doctor; relaunching Desktop with the preserved network mode.");
    process.stdout.write("Update and strict Doctor passed. Relaunching Desktop...\n");
    await launchDesktop(repositoryRoot);
    await strictDoctor(repositoryRoot, { attached: true });
    await verifyExactInstallation(repositoryRoot, version);
    await writeStatus(stateRoot, runId, version, "completed", "Update, Desktop relaunch, and strict Doctor completed.", true);
    process.stdout.write("\nUpgrade completed. Desktop was relaunched with the preserved network mode and strict Doctor passed.\n");
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  } catch (error) {
    let failure = safeFailureText(error, privatePaths);
    if (desktopExited && network) {
      try {
        const running = await runningDesktopApplications();
        if (running.length === 0) {
          process.stdout.write("The update did not complete; attempting to reopen Desktop with the preserved network mode.\n");
          await launchDesktop(repositoryRoot);
        }
      } catch {
        failure += " Desktop recovery launch also failed.";
      }
    }
    await writeStatus(stateRoot, runId, version, "failed", "Foreground upgrade failed; see the visible Terminal window.", false);
    process.stderr.write(`\nForeground upgrade failed: ${failure}\n`);
    process.exitCode = 1;
  } finally {
    await fs.rm(recordedRequestPath, { force: true });
    await fs.rm(commandPath(stateRoot, runId), { force: true });
    await safeRemoveSourceRoot(sourceRoot);
  }
}

async function startWorker(version, remote) {
  if (!VERSION_PATTERN.test(version)) throw new Error("--version must be an explicit semantic release tag.");
  if (!["origin", "private"].includes(remote)) throw new Error("--remote must be either origin or private.");
  const repositoryRoot = path.resolve(String(process.env.FEISHU_CODEX_BRIDGE_FOREGROUND_INSTALL_ROOT || process.cwd()));
  const sourceRoot = path.resolve(String(process.env.FEISHU_CODEX_BRIDGE_FOREGROUND_SOURCE_ROOT || moduleRepositoryRoot));
  const nodeExecutable = path.resolve(String(process.env.FEISHU_CODEX_BRIDGE_FOREGROUND_NODE || process.execPath));
  if (sourceRoot !== moduleRepositoryRoot) throw new Error("The foreground source identity does not match the running target module.");
  await fs.access(path.join(repositoryRoot, ".git"));
  await ensurePrivateDirectory(foregroundStateRoot());
  await assertNoActiveForegroundUpdate(foregroundStateRoot());
  const runId = randomUUID().replaceAll("-", "");
  const stateRoot = foregroundStateRoot();
  const request = {
    schemaVersion: 1,
    runId,
    version,
    remote,
    installRoot: repositoryRoot,
    sourceRoot,
    nodeExecutable,
    coordinatorPid: process.pid,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(requestPath(stateRoot, runId), request);
  const command = [
    "#!/bin/bash",
    "set -u",
    "unset CODEX_THREAD_ID CODEX_SESSION_ID",
    `${shellQuote(nodeExecutable)} ${shellQuote(modulePath)} --worker --run-id ${runId}`,
    "status=$?",
    "if (( status != 0 )); then",
    "  printf '\\nThe foreground upgrade did not complete. Review the message above.\\n'",
    "  read -r -p 'Press Return to close this window.' _",
    "fi",
    "exit \"$status\"",
    "",
  ].join("\n");
  const localCommandPath = commandPath(stateRoot, runId);
  await writeFileAtomic(localCommandPath, command, { mode: 0o700 });
  let workerOpened = false;
  try {
    await execFile("/usr/bin/open", ["-a", "Terminal", localCommandPath], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 128_000,
    });
    workerOpened = true;
    await writeFileAtomic(path.join(sourceRoot, ".foreground-worker-opened"), `${runId}\n`);
    const ready = await waitUntil(async () => {
      try {
        const status = JSON.parse(await fs.readFile(statusPath(stateRoot, runId), "utf8"));
        if (status.runId !== runId) return false;
        if (status.state === "failed") throw new Error(status.detail);
        return ["waiting-for-desktop-exit", "completed"].includes(status.state);
      } catch (error) {
        if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
        throw error;
      }
    }, 3 * 60_000, 250);
    if (!ready) throw new Error("The visible foreground upgrade did not become ready within three minutes.");
    process.stdout.write("Foreground upgrade is ready. Fully quit ChatGPT/Codex Desktop with Command-Q; the visible Terminal will update, reopen it with the preserved network mode, and verify the result.\n");
  } catch (error) {
    if (!workerOpened) {
      await fs.rm(requestPath(stateRoot, runId), { force: true });
      await fs.rm(localCommandPath, { force: true });
      await safeRemoveSourceRoot(sourceRoot);
    }
    throw error;
  }
}

export async function runForegroundMacOSUpdate(args = process.argv.slice(2)) {
  if (process.platform !== "darwin") throw new Error("This foreground updater supports macOS only.");
  const options = parseOptions(args);
  if (options.has("worker")) {
    const runId = String(options.get("run-id") || "");
    if (!RUN_ID_PATTERN.test(runId)) throw new Error("--run-id is invalid.");
    await invokeWorker(runId);
    return;
  }
  if (options.has("run-id")) throw new Error("--run-id is valid only with --worker.");
  await startWorker(String(options.get("version") || ""), String(options.get("remote") || "origin"));
}

const invokedPath = await fs.realpath(path.resolve(process.argv[1] || "")).catch(() => path.resolve(process.argv[1] || ""));
const resolvedModulePath = await fs.realpath(modulePath).catch(() => modulePath);
if (invokedPath === resolvedModulePath) {
  try {
    await runForegroundMacOSUpdate();
  } catch (error) {
    const failure = safeFailureText(error, [process.cwd(), moduleRepositoryRoot, foregroundStateRoot(), os.homedir(), os.tmpdir()]);
    process.stderr.write(`macOS foreground update failed: ${failure}\n`);
    process.exitCode = 1;
  }
}
