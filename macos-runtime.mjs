import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export const MACOS_LABELS = Object.freeze({
  environment: "com.feishu-codex-bridge.environment",
  appServer: "com.feishu-codex-bridge.app-server",
  bridge: "com.feishu-codex-bridge.bridge",
  relay: "com.feishu-codex-bridge.desktop-relay",
});

export const RELAY_ENVIRONMENT_VARIABLE = "CODEX_APP_SERVER_WS_URL";

export function nodeVersionSupported(value) {
  const match = String(value || "").match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const [, majorText, minorText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  return major > 22 || (major === 22 && minor >= 13);
}

export function assertMacOS() {
  if (process.platform !== "darwin") throw new Error("This command supports macOS only.");
}

export async function readBridgeConfig(repositoryRoot) {
  const configPath = path.join(repositoryRoot, "bridge.config.json");
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  return { raw, configPath };
}

export function parseLoopbackAppServerUrl(value) {
  const url = new URL(String(value || ""));
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "::1"].includes(host)
    || !url.port || url.pathname !== "/rpc" || url.username || url.password || url.search || url.hash) {
    throw new Error("sessionRelay.appServerUrl must be a ws:// loopback URL ending in /rpc.");
  }
  return Object.freeze({
    href: url.href,
    host,
    port: Number(url.port),
    listenUrl: `ws://${host === "::1" ? "[::1]" : host}:${url.port}`,
  });
}

export function runtimeLayout(repositoryRoot, rawConfig) {
  const workspace = path.resolve(repositoryRoot, String(rawConfig?.workspace || ""));
  const runtimeDir = path.join(workspace, "work", "feishu-codex-bridge");
  const applicationSupportDir = path.join(os.homedir(), "Library", "Application Support", "FeishuCodexBridge");
  const installationDir = path.join(applicationSupportDir, "installation");
  const bootstrapDir = path.join(applicationSupportDir, "bootstrap");
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const logsDir = path.join(os.homedir(), "Library", "Logs", "FeishuCodexBridge");
  return Object.freeze({
    repositoryRoot: path.resolve(repositoryRoot),
    workspace,
    runtimeDir,
    installationDir,
    bootstrapDir,
    launchAgentsDir,
    logsDir,
    bridgePidPath: path.join(runtimeDir, "bridge.pid"),
    bridgeReadyPath: path.join(runtimeDir, "bridge-ready.json"),
    supervisorPidPath: path.join(runtimeDir, "bridge-supervisor.pid"),
    appServerPidPath: path.join(runtimeDir, "codex-app-server.pid"),
    restartRequestPath: path.join(runtimeDir, "restart.request"),
    stopRequestPath: path.join(runtimeDir, "stop.request"),
    supervisorStopPath: path.join(runtimeDir, "supervisor-stop.request"),
    bridgeStdoutPath: path.join(runtimeDir, "bridge.stdout.log"),
    bridgeStderrPath: path.join(runtimeDir, "bridge.stderr.log"),
    supervisorLogPath: path.join(runtimeDir, "bridge-supervisor.log"),
    appServerStdoutPath: path.join(runtimeDir, "codex-app-server.stdout.log"),
    appServerStderrPath: path.join(runtimeDir, "codex-app-server.stderr.log"),
    relayStatePath: path.join(bootstrapDir, "desktop-relay-state.json"),
    relayStatusPath: path.join(bootstrapDir, "desktop-relay-watchdog-status.json"),
    installPointerPath: path.join(bootstrapDir, "installation.json"),
    environmentPlistPath: path.join(launchAgentsDir, `${MACOS_LABELS.environment}.plist`),
    appServerPlistPath: path.join(launchAgentsDir, `${MACOS_LABELS.appServer}.plist`),
    bridgePlistPath: path.join(launchAgentsDir, `${MACOS_LABELS.bridge}.plist`),
    relayPlistPath: path.join(launchAgentsDir, `${MACOS_LABELS.relay}.plist`),
  });
}

export function keychainIdentity(repositoryRoot) {
  const suffix = createHash("sha256").update(path.resolve(repositoryRoot), "utf8").digest("hex").slice(0, 16);
  return Object.freeze({
    service: `com.feishu-codex-bridge.channel-secret.${suffix}`,
    account: os.userInfo().username,
    label: "Feishu Codex Bridge Channel Secret",
  });
}

export async function readPid(filePath) {
  try {
    const value = Number((await fs.readFile(filePath, "utf8")).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function pidIsRunning(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function processCommand(pid) {
  if (!pidIsRunning(pid)) return undefined;
  try {
    const { stdout } = await execFile("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 256_000,
    });
    return String(stdout || "").trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function isExpectedProcess(pid, requiredFragments) {
  const command = await processCommand(pid);
  if (!command) return false;
  return requiredFragments.every((fragment) => command.includes(String(fragment)));
}

export function loopbackPortOpen({ host, port }, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function appServerReadyProbe({ host, port }, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request({
      host,
      port,
      path: "/readyz",
      method: "GET",
      agent: false,
    }, (response) => {
      response.resume();
      finish(response.statusCode === 200);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

export async function writeFileAtomic(filePath, content, { mode = 0o600 } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, mode);
}

export async function ensurePrivateDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
}

export async function writeJsonAtomic(filePath, value, options) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function launchDomain() {
  return `gui/${process.getuid()}`;
}

export async function launchctl(args, { allowFailure = false } = {}) {
  try {
    const result = await execFile("/bin/launchctl", args, {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1_000_000,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!allowFailure) throw error;
    return { ok: false, stdout: error?.stdout || "", stderr: error?.stderr || "", code: error?.code };
  }
}

export async function launchAgentIsLoaded(label) {
  return (await launchctl(["print", `${launchDomain()}/${label}`], { allowFailure: true })).ok;
}

export async function bootstrapLaunchAgent(label, plistPath) {
  if (!(await launchAgentIsLoaded(label))) {
    await launchctl(["bootstrap", launchDomain(), plistPath]);
  }
}

export async function bootoutLaunchAgent(label) {
  if (await launchAgentIsLoaded(label)) {
    await launchctl(["bootout", `${launchDomain()}/${label}`], { allowFailure: true });
  }
}

export async function setLaunchAgentEnabled(label, enabled) {
  await launchctl([enabled ? "enable" : "disable", `${launchDomain()}/${label}`]);
}

export async function setLaunchEnvironment(name, value) {
  await launchctl(["setenv", name, value]);
}

export async function getLaunchEnvironment(name) {
  const result = await launchctl(["getenv", name], { allowFailure: true });
  return result.ok ? String(result.stdout || "").trim() : "";
}

export async function unsetLaunchEnvironmentIfOwned(name, expectedValue) {
  if (await getLaunchEnvironment(name) === expectedValue) {
    await launchctl(["unsetenv", name], { allowFailure: true });
    return true;
  }
  return false;
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistArray(values) {
  return `<array>${values.map((value) => `<string>${xmlEscape(value)}</string>`).join("")}</array>`;
}

function plistDictionary(value) {
  return `<dict>${Object.entries(value).map(([key, item]) => {
    const encoded = typeof item === "boolean"
      ? `<${item ? "true" : "false"}/>`
      : Number.isFinite(item)
        ? `<integer>${item}</integer>`
        : `<string>${xmlEscape(item)}</string>`;
    return `<key>${xmlEscape(key)}</key>${encoded}`;
  }).join("")}</dict>`;
}

export function buildLaunchAgentPlist({
  label,
  programArguments,
  workingDirectory,
  environment = {},
  runAtLoad = true,
  keepAlive = false,
  throttleInterval = 5,
  stdoutPath,
  stderrPath,
}) {
  const keepAliveValue = typeof keepAlive === "object"
    ? plistDictionary(keepAlive)
    : `<${keepAlive ? "true" : "false"}/>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${xmlEscape(label)}</string>`,
    `<key>ProgramArguments</key>${plistArray(programArguments)}`,
    `<key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>`,
    `<key>EnvironmentVariables</key>${plistDictionary(environment)}`,
    `<key>RunAtLoad</key><${runAtLoad ? "true" : "false"}/>`,
    `<key>KeepAlive</key>${keepAliveValue}`,
    `<key>ThrottleInterval</key><integer>${throttleInterval}</integer>`,
    `<key>ProcessType</key><string>Background</string>`,
    `<key>StandardOutPath</key><string>${xmlEscape(stdoutPath)}</string>`,
    `<key>StandardErrorPath</key><string>${xmlEscape(stderrPath)}</string>`,
    '</dict></plist>',
    "",
  ].join("\n");
}

export function safeError(error) {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500) : String(error).slice(0, 500);
}
