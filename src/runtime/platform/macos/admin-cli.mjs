import { execFile as nodeExecFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  appServerReadyProbe,
  loopbackPortOpen,
  parseLoopbackAppServerUrl,
} from "../../shared/network-probes.mjs";
import { nodeVersionSupported } from "../../shared/node-version.mjs";
import {
  ensurePrivateDirectory,
  writeFileAtomic,
  writeJsonAtomic,
} from "../../shared/private-state.mjs";
import { safeError } from "../../shared/safe-error.mjs";
import { waitUntil } from "../../shared/wait-until.mjs";
import {
  assertMacOS,
  MACOS_LABELS,
  RELAY_ENVIRONMENT_VARIABLE,
} from "./constants.mjs";
import {
  DESKTOP_APPLICATIONS,
  desktopRelayAttachment,
  embeddedDesktopAppServerRunning,
  persistedDesktopProxyUrl,
  processHasEnvironment,
  proxyEnvironment,
  relayHeartbeatReady,
  runningDesktopApplications,
  safeDesktopLaunchArguments,
  safeLoopbackProxyArgument,
} from "./desktop-runtime.mjs";
import {
  bootstrapLaunchAgent,
  bootoutLaunchAgent,
  buildLaunchAgentPlist,
  getLaunchEnvironment,
  launchAgentIsLoaded,
  launchDomain,
  launchctl,
  setLaunchAgentEnabled,
  unsetLaunchEnvironmentIfOwned,
} from "./launchd-service-manager.mjs";
import {
  keychainHasSecret,
  keychainIdentity,
  promptAndStoreKeychainSecret,
} from "./keychain-credential-store.mjs";
import {
  isExpectedProcess,
  pidIsRunning,
  readPid,
} from "./process-inspector.mjs";
import { readBridgeConfig, runtimeLayout } from "./runtime-layout.mjs";
import { optionMap } from "./cli-options.mjs";
import {
  appServerReady,
  bridgeReady,
  runDoctorCommand,
  runStatusCommand,
  statusSnapshot,
} from "./health.mjs";
import {
  discoverNode,
  runDependenciesCommand,
  runInstallCommand,
  writeMacOSLaunchAgents,
} from "./installer.mjs";

const execFile = promisify(nodeExecFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
async function setupSecretCommand() {
  assertMacOS();
  await readBridgeConfig(repositoryRoot);
  const identity = keychainIdentity(repositoryRoot);
  await promptAndStoreKeychainSecret(identity);
}

async function resumeRelayIfEnabled(layout) {
  try {
    const state = JSON.parse(await fs.readFile(layout.relayStatePath, "utf8"));
    if (state?.enabled) {
      await setLaunchAgentEnabled(MACOS_LABELS.relay, true);
      await bootstrapLaunchAgent(MACOS_LABELS.relay, layout.relayPlistPath);
    }
  } catch {}
}

async function startCommand(args) {
  assertMacOS();
  const { options } = optionMap(args);
  const { raw: config } = await readBridgeConfig(repositoryRoot);
  const identity = keychainIdentity(repositoryRoot);
  if (!(await keychainHasSecret(identity))) throw new Error("Channel secret is missing from macOS Keychain. Run setup-channel-secret.sh first.");
  const layout = await writeMacOSLaunchAgents(config);
  const endpoint = parseLoopbackAppServerUrl(config.sessionRelay?.appServerUrl);
  await Promise.all([
    setLaunchAgentEnabled(MACOS_LABELS.appServer, true),
    setLaunchAgentEnabled(MACOS_LABELS.bridge, true),
  ]);
  await bootstrapLaunchAgent(MACOS_LABELS.environment, layout.environmentPlistPath);
  await launchctl(["kickstart", "-k", `${launchDomain()}/${MACOS_LABELS.environment}`]);
  await bootstrapLaunchAgent(MACOS_LABELS.appServer, layout.appServerPlistPath);
  if (!(await waitUntil(() => appServerReady(layout, config, endpoint), 15_000))) {
    throw new Error(`Shared App Server did not become ready. Check ${layout.appServerStderrPath}`);
  }
  if (!(await bridgeReady(layout, config))) {
    await fs.rm(layout.bridgeReadyPath, { force: true });
    await fs.rm(layout.stopRequestPath, { force: true });
    await fs.rm(layout.supervisorStopPath, { force: true });
    if (await launchAgentIsLoaded(MACOS_LABELS.bridge)) {
      await launchctl(["kickstart", "-k", `${launchDomain()}/${MACOS_LABELS.bridge}`]);
    } else {
      await bootstrapLaunchAgent(MACOS_LABELS.bridge, layout.bridgePlistPath);
    }
  }
  const timeoutSeconds = Number(options.get("ready-timeout") || 90);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 15 || timeoutSeconds > 300) {
    throw new Error("--ready-timeout must be between 15 and 300 seconds.");
  }
  if (!(await waitUntil(() => bridgeReady(layout, config), timeoutSeconds * 1000, 250))) {
    throw new Error(`Bridge did not connect within ${timeoutSeconds} seconds. Check ${layout.bridgeStderrPath}`);
  }
  await resumeRelayIfEnabled(layout);
  process.stdout.write("Bridge is connected on macOS.\n");
}

async function pauseRelay(layout, endpoint, { disable = false } = {}) {
  await bootoutLaunchAgent(MACOS_LABELS.relay);
  if (disable) await setLaunchAgentEnabled(MACOS_LABELS.relay, false);
  await unsetLaunchEnvironmentIfOwned(RELAY_ENVIRONMENT_VARIABLE, endpoint.href);
}

async function stopCommand(args) {
  assertMacOS();
  const { options } = optionMap(args);
  const { raw: config } = await readBridgeConfig(repositoryRoot);
  const layout = runtimeLayout(repositoryRoot, config);
  const endpoint = parseLoopbackAppServerUrl(config.sessionRelay?.appServerUrl);
  await fs.mkdir(layout.runtimeDir, { recursive: true });
  await fs.writeFile(layout.stopRequestPath, `${Date.now()}\n`, { mode: 0o600 });
  await fs.writeFile(layout.supervisorStopPath, `${Date.now()}\n`, { mode: 0o600 });
  await waitUntil(async () => {
    const [bridgePid, supervisorPid] = await Promise.all([readPid(layout.bridgePidPath), readPid(layout.supervisorPidPath)]);
    return !pidIsRunning(bridgePid) && !pidIsRunning(supervisorPid);
  }, 20_000, 250);
  await bootoutLaunchAgent(MACOS_LABELS.bridge);
  await setLaunchAgentEnabled(MACOS_LABELS.bridge, false);
  await pauseRelay(layout, endpoint, { disable: true });
  if (options.has("all")) {
    await bootoutLaunchAgent(MACOS_LABELS.appServer);
    await setLaunchAgentEnabled(MACOS_LABELS.appServer, false);
    process.stdout.write("Bridge, Desktop relay, and shared App Server stopped.\n");
  } else {
    process.stdout.write("Bridge stopped; the shared App Server remains available. Use --all to stop it too.\n");
  }
}

async function ensureSharedAppServerProxy(status, proxyUrl) {
  if (!proxyUrl) return;
  const activation = JSON.parse(await fs.readFile(status.layout.relayStatePath, "utf8"));
  if (activation.enabled !== true || activation.url !== status.endpoint.href) {
    throw new Error("Desktop relay activation changed before the proxy could be applied.");
  }
  if (activation.desktopProxyUrl !== proxyUrl) {
    await writeJsonAtomic(status.layout.relayStatePath, {
      ...activation,
      desktopProxyUrl: proxyUrl,
      updatedAt: new Date().toISOString(),
    });
  }
  await writeMacOSLaunchAgents(status.config);
  const currentPid = await readPid(status.layout.appServerPidPath);
  const alreadyConfigured = currentPid
    && await processHasEnvironment(currentPid, "HTTP_PROXY", proxyUrl)
    && await processHasEnvironment(currentPid, "HTTPS_PROXY", proxyUrl)
    && await processHasEnvironment(currentPid, "ALL_PROXY", proxyUrl);
  if (alreadyConfigured) return;

  await bootoutLaunchAgent(MACOS_LABELS.relay);
  await unsetLaunchEnvironmentIfOwned(RELAY_ENVIRONMENT_VARIABLE, status.endpoint.href);
  await bootoutLaunchAgent(MACOS_LABELS.appServer);
  const stopped = await waitUntil(async () =>
    !(await loopbackPortOpen(status.endpoint)) && !pidIsRunning(currentPid), 15_000, 200);
  if (!stopped) throw new Error("The previous shared App Server did not stop for proxy reconfiguration.");

  await setLaunchAgentEnabled(MACOS_LABELS.appServer, true);
  await bootstrapLaunchAgent(MACOS_LABELS.appServer, status.layout.appServerPlistPath);
  if (!(await waitUntil(() => appServerReady(status.layout, status.config, status.endpoint), 20_000, 200))) {
    throw new Error("The shared App Server did not recover after proxy reconfiguration.");
  }
  const restartedPid = await readPid(status.layout.appServerPidPath);
  const proxyApplied = restartedPid
    && await processHasEnvironment(restartedPid, "HTTP_PROXY", proxyUrl)
    && await processHasEnvironment(restartedPid, "HTTPS_PROXY", proxyUrl)
    && await processHasEnvironment(restartedPid, "ALL_PROXY", proxyUrl);
  if (!proxyApplied) throw new Error("The shared App Server did not inherit the configured local proxy.");

  await setLaunchAgentEnabled(MACOS_LABELS.relay, true);
  await bootstrapLaunchAgent(MACOS_LABELS.relay, status.layout.relayPlistPath);
  const relayRecovered = await waitUntil(async () =>
    await relayHeartbeatReady(status.layout, status.endpoint.href)
      && await getLaunchEnvironment(RELAY_ENVIRONMENT_VARIABLE) === status.endpoint.href, 20_000, 250);
  if (!relayRecovered) throw new Error("Desktop relay did not recover after proxy reconfiguration.");
}

async function launchDesktopRelayCommand(args) {
  assertMacOS();
  const { options } = optionMap(args);
  const status = await statusSnapshot();
  if (!status.listener || !status.appServerProcess || status.pointer !== status.endpoint.href
    || !(await relayHeartbeatReady(status.layout, status.endpoint.href))) {
    throw new Error("Desktop relay is not ready. Start the Bridge and configure the Desktop relay first.");
  }
  const waitSeconds = Number(options.get("wait-for-exit") || 0);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) {
    throw new Error("--wait-for-exit must be between 0 and 600 seconds.");
  }
  const requestedProxyValue = process.env.FEISHU_CODEX_DESKTOP_PROXY_URL;
  const requestedProxyArgument = safeLoopbackProxyArgument(requestedProxyValue);
  if (requestedProxyValue && !requestedProxyArgument) {
    throw new Error("The Desktop proxy must be an unauthenticated loopback URL with an explicit port.");
  }
  const proxyUrl = requestedProxyArgument?.slice("--proxy-server=".length)
    || await persistedDesktopProxyUrl(status.layout);
  if (proxyUrl) {
    const proxy = new URL(proxyUrl);
    if (!(await loopbackPortOpen({ host: proxy.hostname.replace(/^\[|\]$/g, ""), port: Number(proxy.port) }))) {
      throw new Error("The configured local Desktop proxy is not accepting connections.");
    }
  }
  let running = await runningDesktopApplications();
  const preferredBundle = running[0]?.bundlePath;
  const preservedArguments = safeDesktopLaunchArguments(running[0], proxyUrl);
  if (running.length > 0 && waitSeconds === 0) {
    throw new Error("ChatGPT/Codex Desktop is still running. Fully quit it, then run this launcher again.");
  }
  if (running.length > 0) {
    const exited = await waitUntil(async () => {
      running = await runningDesktopApplications();
      return running.length === 0 && !(await embeddedDesktopAppServerRunning());
    }, waitSeconds * 1000, 250);
    if (!exited) throw new Error("Timed out waiting for ChatGPT/Codex Desktop to fully quit.");
  }
  let bundlePath = preferredBundle;
  if (!bundlePath) {
    for (const application of DESKTOP_APPLICATIONS) {
      if (await pathExists(application.bundlePath)) {
        bundlePath = application.bundlePath;
        break;
      }
    }
  }
  if (!bundlePath) throw new Error("ChatGPT/Codex Desktop was not found in /Applications.");
  await ensureSharedAppServerProxy(status, proxyUrl);
  const openArguments = [
    "--env", `${RELAY_ENVIRONMENT_VARIABLE}=${status.endpoint.href}`,
  ];
  for (const [name, value] of Object.entries(proxyEnvironment(proxyUrl))) {
    openArguments.push("--env", `${name}=${value}`);
  }
  openArguments.push(bundlePath);
  if (preservedArguments.length > 0) openArguments.push("--args", ...preservedArguments);
  await execFile("/usr/bin/open", openArguments, { encoding: "utf8", timeout: 20_000, maxBuffer: 256_000 });
  const attached = await waitUntil(
    async () => await desktopRelayAttachment(status.endpoint.href) === "attached",
    30_000,
    250,
  );
  if (!attached) throw new Error("Desktop started without inheriting the shared App Server relay environment.");
  process.stdout.write("ChatGPT/Codex Desktop launched with the verified shared App Server relay.\n");
}

async function configureRelayCommand(args) {
  assertMacOS();
  const { options } = optionMap(args);
  const status = await statusSnapshot();
  if (options.has("disable")) {
    await pauseRelay(status.layout, status.endpoint, { disable: true });
    await writeJsonAtomic(status.layout.relayStatePath, { schemaVersion: 1, enabled: false, url: status.endpoint.href });
    process.stdout.write("Desktop relay disabled. Fully restart ChatGPT/Codex Desktop to apply the change.\n");
    return;
  }
  if (!status.connected || !status.listener || !status.appServerProcess) {
    throw new Error("Start the Bridge and verify the shared App Server before enabling Desktop relay.");
  }
  const desktopProxyUrl = await persistedDesktopProxyUrl(status.layout);
  const activation = {
    schemaVersion: 1,
    enabled: true,
    activationId: randomUUID(),
    url: status.endpoint.href,
    repositoryRoot: status.layout.installationDir,
    createdAt: new Date().toISOString(),
    ...(desktopProxyUrl ? { desktopProxyUrl } : {}),
  };
  await writeJsonAtomic(status.layout.relayStatePath, activation);
  const nodeExecutable = path.resolve(repositoryRoot, String(status.config.nodeExecutable));
  const plist = buildLaunchAgentPlist({
    label: MACOS_LABELS.relay,
    programArguments: [nodeExecutable, path.join(status.layout.installationDir, "src", "runtime", "platform", "macos", "relay-watchdog-entry.mjs")],
    workingDirectory: status.layout.workspace,
    environment: launchEnvironment(nodeExecutable),
    keepAlive: true,
    stdoutPath: path.join(status.layout.logsDir, "desktop-relay.stdout.log"),
    stderrPath: path.join(status.layout.logsDir, "desktop-relay.stderr.log"),
  });
  await writeFileAtomic(status.layout.relayPlistPath, plist, { mode: 0o600 });
  await setLaunchAgentEnabled(MACOS_LABELS.relay, true);
  await bootstrapLaunchAgent(MACOS_LABELS.relay, status.layout.relayPlistPath);
  const ready = await waitUntil(async () => {
    try {
      const snapshot = JSON.parse(await fs.readFile(status.layout.relayStatusPath, "utf8"));
      return snapshot.activationId === activation.activationId && snapshot.state === "ready"
        && await getLaunchEnvironment(RELAY_ENVIRONMENT_VARIABLE) === status.endpoint.href;
    } catch { return false; }
  }, 20_000, 250);
  if (!ready) throw new Error("Desktop relay watchdog did not become ready.");
  process.stdout.write("Desktop relay enabled. Fully quit and reopen ChatGPT/Codex Desktop before testing.\n");
}

async function larkCliCommand(args) {
  assertMacOS();
  let existing;
  try { existing = (await readBridgeConfig(repositoryRoot)).raw; } catch {}
  const nodeExecutable = await discoverNode(existing?.nodeExecutable);
  const entryPath = path.join(repositoryRoot, "node_modules", "@larksuite", "cli", "scripts", "run.js");
  await fs.access(entryPath);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [entryPath, ...args], { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  if (code !== 0) process.exitCode = code;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "install": return runInstallCommand(args);
    case "setup-secret": return setupSecretCommand(args);
    case "start": return startCommand(args);
    case "stop": return stopCommand(args);
    case "status": return runStatusCommand(args);
    case "doctor": return runDoctorCommand(args);
    case "configure-desktop-relay": return configureRelayCommand(args);
    case "launch-desktop-relay": return launchDesktopRelayCommand(args);
    case "lark-cli": return larkCliCommand(args);
    case "dependencies": return runDependenciesCommand();
    case "update": return (await import("./update.mjs")).runMacOSUpdate(args);
    default: throw new Error("Usage: admin-cli.mjs dependencies|install|setup-secret|start|stop|status|doctor|configure-desktop-relay|launch-desktop-relay|lark-cli|update");
  }
}

const invokedPath = await fs.realpath(path.resolve(process.argv[1] || "")).catch(() => path.resolve(process.argv[1] || ""));
const modulePath = await fs.realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`macOS Bridge command failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  }
}
