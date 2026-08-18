import { spawn } from "node:child_process";
import { promises as fs, openSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectory } from "../../shared/private-state.mjs";
import { safeError } from "../../shared/safe-error.mjs";
import { assertMacOS } from "./constants.mjs";
import {
  keychainIdentity,
  readKeychainSecret,
} from "./keychain-credential-store.mjs";
import {
  pidIsRunning,
  readPid,
} from "./process-inspector.mjs";
import { readBridgeConfig, runtimeLayout } from "./runtime-layout.mjs";

assertMacOS();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const { raw: config } = await readBridgeConfig(repositoryRoot);
const layout = runtimeLayout(repositoryRoot, config);
const keychainRepositoryRoot = typeof config.macosKeychainRepositoryRoot === "string"
  ? config.macosKeychainRepositoryRoot
  : repositoryRoot;
const identity = keychainIdentity(keychainRepositoryRoot);
const bridgeScript = path.join(repositoryRoot, config.mode === "session-relay" ? "session-relay.mjs" : "channel-bridge.mjs");
const nodeExecutable = path.resolve(repositoryRoot, String(config.nodeExecutable || process.execPath));
let child;
let stopping = false;

await ensurePrivateDirectory(layout.runtimeDir);
await fs.writeFile(layout.supervisorPidPath, String(process.pid), { encoding: "utf8", mode: 0o600 });

async function log(message) {
  await fs.appendFile(layout.supervisorLogPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

async function stopChild(signal = "SIGTERM") {
  if (!child || child.exitCode != null) return;
  try { child.kill(signal); } catch {}
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    void stopChild(signal);
  });
}

try {
  await log(`supervisor started; pid=${process.pid}; mode=${config.mode || "project-agent"}`);
  while (!stopping) {
    try {
      await fs.access(layout.supervisorStopPath);
      break;
    } catch {}

    const existingPid = await readPid(layout.bridgePidPath);
    if (existingPid && pidIsRunning(existingPid)) {
      throw new Error(`Another Bridge process is already running (PID ${existingPid}).`);
    }
    await fs.rm(layout.bridgePidPath, { force: true });

    let secret = await readKeychainSecret(identity);
    const stdoutFd = openSync(layout.bridgeStdoutPath, "a", 0o600);
    const stderrFd = openSync(layout.bridgeStderrPath, "a", 0o600);
    try {
      child = spawn(nodeExecutable, [bridgeScript], {
        cwd: layout.workspace,
        env: { ...process.env, HOME: os.homedir(), USERPROFILE: os.homedir(), LARK_APP_SECRET: secret },
        detached: false,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
    } finally {
      secret = "";
      closeSync(stdoutFd);
      closeSync(stderrFd);
      await Promise.all([
        fs.chmod(layout.bridgeStdoutPath, 0o600),
        fs.chmod(layout.bridgeStderrPath, 0o600),
      ]);
    }
    await log(`Bridge started; pid=${child.pid}`);
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: 1, error }));
      child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
    });
    await log(`Bridge exited; pid=${child.pid}; code=${result.code}; signal=${result.signal || "none"}`);
    child = undefined;

    if (stopping) break;
    try {
      await fs.access(layout.supervisorStopPath);
      break;
    } catch {}
    try {
      await fs.access(layout.restartRequestPath);
      await fs.rm(layout.restartRequestPath, { force: true });
      await log("explicit reload requested; starting replacement Bridge");
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    } catch {}
    if (result.code !== 0) process.exitCode = result.code;
    break;
  }
} catch (error) {
  await log(`supervisor failed: ${safeError(error)}`);
  process.exitCode = 1;
} finally {
  await stopChild();
  await fs.rm(layout.supervisorStopPath, { force: true });
  await fs.rm(layout.restartRequestPath, { force: true });
  await fs.rm(layout.supervisorPidPath, { force: true });
  await log("supervisor stopped");
}
