import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MACOS_LABELS } from "./constants.mjs";

export async function readBridgeConfig(repositoryRoot) {
  const configPath = path.join(repositoryRoot, "bridge.config.json");
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  return { raw, configPath };
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
