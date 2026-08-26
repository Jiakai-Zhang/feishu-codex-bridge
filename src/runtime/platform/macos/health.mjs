import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appServerReadyProbe,
  parseLoopbackAppServerUrl,
} from "../../shared/network-probes.mjs";
import { nodeVersionSupported } from "../../shared/node-version.mjs";
import { safeError } from "../../shared/safe-error.mjs";
import { assertMacOS, RELAY_ENVIRONMENT_VARIABLE } from "./constants.mjs";
import { desktopRelayAttachment } from "./desktop-runtime.mjs";
import { optionMap } from "./cli-options.mjs";
import { getLaunchEnvironment } from "./launchd-service-manager.mjs";
import {
  discoverCodex,
  executableWorks,
  larkJson,
} from "./installer.mjs";
import {
  KEYCHAIN_FULL_ACCESS_HINT,
  keychainHasSecret,
  keychainIdentity,
} from "./keychain-credential-store.mjs";
import { isExpectedProcess, readPid } from "./process-inspector.mjs";
import { readBridgeConfig, runtimeLayout } from "./runtime-layout.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export async function bridgeReady(layout, config) {
  const pid = await readPid(layout.bridgePidPath);
  const nodeExecutable = path.resolve(repositoryRoot, String(config.nodeExecutable));
  const bridgeScript = config.mode === "session-relay" ? "session-relay.mjs" : "channel-bridge.mjs";
  if (!pid || !(await isExpectedProcess(pid, [nodeExecutable, bridgeScript]))) return false;
  try {
    const marker = JSON.parse(await fs.readFile(layout.bridgeReadyPath, "utf8"));
    return Number(marker?.pid) === pid && marker?.mode === bridgeScript.replace(/\.mjs$/, "");
  } catch {
    return false;
  }
}

export async function appServerReady(layout, config, endpoint) {
  const pid = await readPid(layout.appServerPidPath);
  const codexExecutable = path.resolve(repositoryRoot, String(config.codexExecutable));
  return Boolean(pid
    && await isExpectedProcess(pid, [codexExecutable, "app-server", `:${endpoint.port}`])
    && await appServerReadyProbe(endpoint));
}

export async function statusSnapshot() {
  const { raw: config } = await readBridgeConfig(repositoryRoot);
  const layout = runtimeLayout(repositoryRoot, config);
  const endpoint = parseLoopbackAppServerUrl(config.sessionRelay?.appServerUrl);
  const [bridgePid, supervisorPid, appServerPid] = await Promise.all([
    readPid(layout.bridgePidPath),
    readPid(layout.supervisorPidPath),
    readPid(layout.appServerPidPath),
  ]);
  const [bridgeProcess, supervisorProcess, appServerProcess, listener, pointer] = await Promise.all([
    bridgePid
      ? isExpectedProcess(bridgePid, [
          String(config.nodeExecutable),
          config.mode === "session-relay" ? "session-relay.mjs" : "channel-bridge.mjs",
        ])
      : false,
    supervisorPid
      ? isExpectedProcess(supervisorPid, [String(config.nodeExecutable), "bridge-supervisor-entry.mjs"])
      : false,
    appServerPid
      ? isExpectedProcess(appServerPid, [String(config.codexExecutable), "app-server", `:${endpoint.port}`])
      : false,
    appServerReadyProbe(endpoint),
    getLaunchEnvironment(RELAY_ENVIRONMENT_VARIABLE),
  ]);
  const connected = bridgeProcess && await bridgeReady(layout, config);
  let relay = "disabled";
  try {
    const state = JSON.parse(await fs.readFile(layout.relayStatusPath, "utf8"));
    relay = state.state || relay;
  } catch {}
  const desktop = await desktopRelayAttachment(endpoint.href);
  return {
    config,
    layout,
    endpoint,
    bridgePid,
    supervisorPid,
    appServerPid,
    bridgeProcess,
    supervisorProcess,
    appServerProcess,
    listener,
    connected,
    pointer,
    relay,
    desktop,
  };
}

export async function runStatusCommand() {
  const status = await statusSnapshot();
  process.stdout.write([
    `Bridge: ${status.bridgeProcess ? `running:${status.bridgePid}` : "stopped"}`,
    `Channel: ${status.connected ? "connected" : "not-connected"}`,
    `Supervisor: ${status.supervisorProcess ? `running:${status.supervisorPid}` : "stopped"}`,
    `Shared App Server: ${status.appServerProcess && status.listener ? `ready:${status.appServerPid}` : "not-ready"}`,
    `Desktop relay: ${status.relay}`,
    `Desktop client: ${status.desktop}`,
  ].join("\n") + "\n");
}

export async function runDoctorCommand(args) {
  assertMacOS();
  const { options } = optionMap(args);
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  let config;
  let layout;
  let status;
  try {
    ({ raw: config } = await readBridgeConfig(repositoryRoot));
    layout = runtimeLayout(repositoryRoot, config);
    add("Configuration", config.mode === "session-relay", "session-relay config is readable");
  } catch (error) {
    add("Configuration", false, safeError(error));
  }
  if (config) {
    const nodeExecutable = path.resolve(repositoryRoot, String(config.nodeExecutable));
    const codexExecutable = path.resolve(repositoryRoot, String(config.codexExecutable));
    add("Node.js", await executableWorks(nodeExecutable, ["--version"], nodeVersionSupported), "version is supported");
    add("Codex App Server", await executableWorks(codexExecutable, ["app-server", "--help"], /--listen\s+<URL>/m), "listener capability is available");
    add("Codex state", await fs.access(path.join(os.homedir(), ".codex", "state_5.sqlite")).then(() => true, () => false), "state database is present");
    const keychainReady = await keychainHasSecret(keychainIdentity(repositoryRoot));
    add(
      "Keychain secret",
      keychainReady,
      keychainReady
        ? "item is present and readable for the current user"
        : `item is missing or unreadable. ${KEYCHAIN_FULL_ACCESS_HINT}`,
    );
    for (const [name, filePath] of [
      ["Environment LaunchAgent", layout.environmentPlistPath],
      ["App Server LaunchAgent", layout.appServerPlistPath],
      ["Bridge LaunchAgent", layout.bridgePlistPath],
    ]) {
      add(name, await fs.access(filePath).then(() => true, () => false), "plist is installed");
    }
    const skillRoot = path.join(os.homedir(), ".agents", "skills", "feishu-session-bind");
    const skillReady = await Promise.all([
      fs.access(path.join(skillRoot, "SKILL.md")),
      fs.access(path.join(skillRoot, "scripts", "request-binding.sh")),
      fs.access(path.join(skillRoot, "scripts", "request-binding.mjs")),
    ].map((promise) => promise.then(() => true, () => false))).then((values) => values.every(Boolean));
    add("Codex binding skill", skillReady, "macOS entrypoint is installed for the current user");

    const auth = await larkJson(nodeExecutable, String(config.larkCliEntry), ["auth", "status", "--json", "--verify"]);
    add("Feishu application binding", auth?.appId === config.appId, "CLI profile matches the configured application");
    add("Feishu bot identity", auth?.identities?.bot?.available && auth?.identities?.bot?.verified, "Bot identity is available and verified");
    add("Feishu user identity", auth?.identities?.user?.available && auth?.identities?.user?.verified, "user identity is available and verified");
    const scopeSet = new Set(String(auth?.identities?.user?.scope || "").split(/[,\s]+/).filter(Boolean));
    const requiredScopes = [
      "im:feed_group_v1:read",
      "im:feed_group_v1:write",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "im:chat.tabs:read",
      "im:chat.tabs:write_only",
    ];
    const missingScopes = requiredScopes.filter((scope) => !scopeSet.has(scope));
    add(
      "Feishu user OAuth scopes",
      missingScopes.length === 0,
      missingScopes.length === 0 ? "required scopes are granted" : `missing: ${missingScopes.join(", ")}`,
    );
    try { status = await statusSnapshot(); } catch {}
  }
  if (options.has("require-running")) {
    add("Shared App Server live", status?.appServerProcess && status?.listener, "owned listener is ready");
    add("Bridge live", status?.bridgeProcess && status?.supervisorProcess && status?.connected, "Bridge and Channel are connected");
  }
  if (options.has("require-desktop-relay")) {
    const fresh = layout && await fs.readFile(layout.relayStatusPath, "utf8").then((text) => {
      const value = JSON.parse(text);
      const age = Date.now() - Date.parse(value.heartbeatAt);
      return value.state === "ready" && age >= -5_000 && age <= 20_000;
    }, () => false);
    add("Desktop relay live", fresh && status?.pointer === status?.endpoint.href, "watchdog heartbeat and owned pointer are ready");
  }
  if (options.has("require-desktop-attached")) {
    add("Desktop client attached", status?.desktop === "attached", "Desktop inherited the shared App Server relay environment");
  }
  for (const check of checks) {
    process.stdout.write(`${check.passed ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  }
  if (checks.some(({ passed }) => !passed)) process.exitCode = 1;
}
