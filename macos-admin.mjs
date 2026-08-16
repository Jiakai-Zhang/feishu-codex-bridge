import { execFile as nodeExecFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  appServerReadyProbe,
  assertMacOS,
  bootstrapLaunchAgent,
  bootoutLaunchAgent,
  buildLaunchAgentPlist,
  ensurePrivateDirectory,
  getLaunchEnvironment,
  isExpectedProcess,
  keychainIdentity,
  launchAgentIsLoaded,
  launchDomain,
  launchctl,
  loopbackPortOpen,
  MACOS_LABELS,
  nodeVersionSupported,
  parseLoopbackAppServerUrl,
  pidIsRunning,
  readBridgeConfig,
  readPid,
  RELAY_ENVIRONMENT_VARIABLE,
  runtimeLayout,
  safeError,
  setLaunchAgentEnabled,
  unsetLaunchEnvironmentIfOwned,
  writeFileAtomic,
  writeJsonAtomic,
} from "./macos-runtime.mjs";

const execFile = promisify(nodeExecFile);
const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_RUNTIME_ENTRYPOINTS = Object.freeze([
  "macos-environment.mjs",
  "macos-app-server.mjs",
  "macos-bridge-supervisor.mjs",
  "macos-relay-watchdog.mjs",
  "session-relay.mjs",
  "request-session-binding.mjs",
]);

function optionMap(args) {
  const options = new Map();
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    if (separator > 2) {
      options.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const name = token.slice(2);
    if (args[index + 1] != null && !args[index + 1].startsWith("--")) options.set(name, args[++index]);
    else options.set(name, true);
  }
  return { options, positional };
}

function candidateList(...values) {
  return [...new Set(values.flat().filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

async function executableWorks(candidate, args, validator) {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    const { stdout, stderr } = await execFile(candidate, args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
    });
    const output = `${stdout}\n${stderr}`;
    return typeof validator === "function" ? validator(output) : validator.test(output);
  } catch {
    return false;
  }
}

async function commandPath(name) {
  try {
    const { stdout } = await execFile("/usr/bin/which", [name], { encoding: "utf8", timeout: 2_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function discoverNode(configured) {
  const candidates = candidateList(
    configured,
    process.env.FEISHU_CODEX_BRIDGE_NODE,
    process.execPath,
    await commandPath("node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
  );
  for (const candidate of candidates) {
    if (await executableWorks(candidate, ["--version"], nodeVersionSupported)) return path.resolve(candidate);
  }
  throw new Error("Node.js 22.13 or newer was not found. Install Node.js and retry.");
}

export async function discoverNpm(nodeExecutable) {
  const sibling = path.join(path.dirname(nodeExecutable), "npm");
  const candidates = candidateList(sibling, await commandPath("npm"), "/opt/homebrew/bin/npm", "/usr/local/bin/npm");
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("npm was not found next to the selected Node.js runtime.");
}

export async function discoverCodex(configured) {
  const candidates = candidateList(
    configured,
    process.env.CODEX_EXECUTABLE,
    await commandPath("codex"),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  );
  for (const candidate of candidates) {
    if (await executableWorks(candidate, ["app-server", "--help"], /--listen\s+<URL>/m)) return path.resolve(candidate);
  }
  throw new Error("A Codex executable with App Server listener support was not found.");
}

function extractJson(text) {
  const source = String(text || "");
  for (let index = source.indexOf("{"); index >= 0; index = source.indexOf("{", index + 1)) {
    try { return JSON.parse(source.slice(index)); } catch {}
  }
  return undefined;
}

async function larkJson(nodeExecutable, entryPath, args) {
  try {
    const { stdout, stderr } = await execFile(nodeExecutable, [entryPath, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2_000_000,
    });
    return extractJson(`${stdout}\n${stderr}`);
  } catch (error) {
    return extractJson(`${error?.stdout || ""}\n${error?.stderr || ""}`);
  }
}

async function larkIdentity(nodeExecutable, entryPath) {
  const status = await larkJson(nodeExecutable, entryPath, ["auth", "status", "--json", "--verify"]);
  let appId = status?.appId;
  let ownerOpenId = status?.identities?.user?.verified ? status.identities.user.openId : undefined;
  if (!validAppId(appId) || !validOpenId(ownerOpenId)) {
    const whoami = await larkJson(nodeExecutable, entryPath, ["whoami", "--as", "user", "--json"]);
    if (whoami?.available) ownerOpenId = whoami?.onBehalfOf?.openId;
    if (!validAppId(appId)) appId = whoami?.appId;
  }
  return { status, appId, ownerOpenId };
}

function validAppId(value) {
  return /^cli_[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function validOpenId(value) {
  return /^ou_[A-Za-z0-9_-]+$/.test(String(value || ""));
}

async function runNpmCi(nodeExecutable, npmExecutable) {
  const environment = {
    ...process.env,
    PATH: `${path.dirname(nodeExecutable)}:${process.env.PATH || "/usr/bin:/bin"}`,
  };
  const code = await new Promise((resolve, reject) => {
    const child = spawn(npmExecutable, ["ci", "--ignore-scripts=false"], {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  if (code !== 0) throw new Error(`npm ci failed with exit code ${code}.`);
}

async function installSkill(layout) {
  const source = path.join(repositoryRoot, "skills", "feishu-session-bind");
  const target = path.join(os.homedir(), ".agents", "skills", "feishu-session-bind");
  await fs.mkdir(target, { recursive: true });
  await fs.cp(source, target, { recursive: true, force: true });
  await writeJsonAtomic(layout.installPointerPath, {
    schemaVersion: 1,
    repositoryRoot: layout.installationDir,
    sourceRepositoryRoot: repositoryRoot,
    nodeExecutable: String((await readBridgeConfig(repositoryRoot)).raw.nodeExecutable),
  });
}

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

function validRuntimeBinding(binding) {
  return /^oc_[A-Za-z0-9_-]+$/.test(String(binding?.groupChatId || ""))
    && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(binding?.threadId || ""))
    && /^ou_[A-Za-z0-9_-]+$/.test(String(binding?.ownerOpenId || ""));
}

async function bindingsForRuntimeInstall(config, layout) {
  const configured = config.sessionRelay?.bindings;
  if (Array.isArray(configured) && configured.length > 0) return structuredClone(configured);
  try {
    const existing = JSON.parse(await fs.readFile(path.join(layout.installationDir, "bridge.config.json"), "utf8"));
    const sameInstallation = existing?.mode === config.mode
      && existing?.appId === config.appId
      && path.resolve(String(existing?.workspace || "")) === path.resolve(String(config.workspace || ""));
    const bindings = existing?.sessionRelay?.bindings;
    if (sameInstallation && Array.isArray(bindings) && bindings.length > 0 && bindings.every(validRuntimeBinding)) {
      return structuredClone(bindings);
    }
  } catch {}
  return Array.isArray(configured) ? structuredClone(configured) : [];
}

export async function installMacOSRuntime(config) {
  const layout = runtimeLayout(repositoryRoot, config);
  const parent = path.dirname(layout.installationDir);
  const stagingDir = path.join(parent, `installation.staging-${randomUUID()}`);
  const backupDir = path.join(parent, `installation.backup-${randomUUID()}`);
  let existingMoved = false;
  await ensurePrivateDirectory(parent);
  await ensurePrivateDirectory(stagingDir);
  try {
    const entries = await fs.readdir(repositoryRoot, { withFileTypes: true });
    const runtimeFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs"))
      .map((entry) => entry.name);
    for (const name of REQUIRED_RUNTIME_ENTRYPOINTS) {
      if (!runtimeFiles.includes(name)) throw new Error(`Required macOS runtime entrypoint is missing: ${name}`);
    }
    await Promise.all(runtimeFiles.map((name) => fs.copyFile(
      path.join(repositoryRoot, name),
      path.join(stagingDir, name),
    )));
    for (const name of ["package.json", "package-lock.json"]) {
      if (await pathExists(path.join(repositoryRoot, name))) {
        await fs.copyFile(path.join(repositoryRoot, name), path.join(stagingDir, name));
      }
    }
    await fs.cp(path.join(repositoryRoot, "node_modules"), path.join(stagingDir, "node_modules"), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    const bindings = await bindingsForRuntimeInstall(config, layout);
    const stagedConfig = {
      ...config,
      sessionRelay: {
        ...config.sessionRelay,
        bindings,
      },
      macosKeychainRepositoryRoot: repositoryRoot,
      larkCliEntry: config.larkCliEntry
        ? path.join(layout.installationDir, "node_modules", "@larksuite", "cli", "scripts", "run.js")
        : config.larkCliEntry,
    };
    await writeJsonAtomic(path.join(stagingDir, "bridge.config.json"), stagedConfig);
    if (await pathExists(layout.installationDir)) {
      await fs.rename(layout.installationDir, backupDir);
      existingMoved = true;
    }
    await fs.rename(stagingDir, layout.installationDir);
    if (existingMoved) await fs.rm(backupDir, { recursive: true, force: true });
    return layout;
  } catch (error) {
    if (existingMoved && !(await pathExists(layout.installationDir)) && await pathExists(backupDir)) {
      await fs.rename(backupDir, layout.installationDir);
    }
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function launchEnvironment(nodeExecutable) {
  return {
    HOME: os.homedir(),
    USERPROFILE: os.homedir(),
    PATH: `${path.dirname(nodeExecutable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
}

function proxyEnvironment(proxyUrl) {
  if (!safeLoopbackProxyArgument(proxyUrl)) return {};
  const noProxy = "127.0.0.1,localhost,::1";
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

async function persistedDesktopProxyUrl(layout) {
  try {
    const activation = JSON.parse(await fs.readFile(layout.relayStatePath, "utf8"));
    const argument = safeLoopbackProxyArgument(activation.desktopProxyUrl);
    return argument?.slice("--proxy-server=".length);
  } catch {
    return undefined;
  }
}

export async function writeMacOSLaunchAgents(config) {
  const layout = runtimeLayout(repositoryRoot, config);
  const nodeExecutable = path.resolve(repositoryRoot, String(config.nodeExecutable));
  const installedRoot = layout.installationDir;
  const environment = launchEnvironment(nodeExecutable);
  const appServerEnvironment = {
    ...environment,
    ...proxyEnvironment(await persistedDesktopProxyUrl(layout)),
  };
  await Promise.all([
    ensurePrivateDirectory(layout.runtimeDir),
    ensurePrivateDirectory(layout.bootstrapDir),
    fs.mkdir(layout.launchAgentsDir, { recursive: true }),
    ensurePrivateDirectory(layout.logsDir),
  ]);
  await Promise.all(REQUIRED_RUNTIME_ENTRYPOINTS.map((name) => fs.access(path.join(installedRoot, name))));
  const definitions = [
    [layout.environmentPlistPath, buildLaunchAgentPlist({
      label: MACOS_LABELS.environment,
      programArguments: [nodeExecutable, path.join(installedRoot, "macos-environment.mjs")],
      workingDirectory: installedRoot,
      environment,
      keepAlive: false,
      stdoutPath: path.join(layout.logsDir, "environment.stdout.log"),
      stderrPath: path.join(layout.logsDir, "environment.stderr.log"),
    })],
    [layout.appServerPlistPath, buildLaunchAgentPlist({
      label: MACOS_LABELS.appServer,
      programArguments: [nodeExecutable, path.join(installedRoot, "macos-app-server.mjs")],
      workingDirectory: layout.workspace,
      environment: appServerEnvironment,
      keepAlive: true,
      stdoutPath: layout.appServerStdoutPath,
      stderrPath: layout.appServerStderrPath,
    })],
    [layout.bridgePlistPath, buildLaunchAgentPlist({
      label: MACOS_LABELS.bridge,
      programArguments: [nodeExecutable, path.join(installedRoot, "macos-bridge-supervisor.mjs")],
      workingDirectory: layout.workspace,
      environment,
      keepAlive: { SuccessfulExit: false },
      stdoutPath: path.join(layout.logsDir, "bridge-launchd.stdout.log"),
      stderrPath: path.join(layout.logsDir, "bridge-launchd.stderr.log"),
    })],
  ];
  for (const [filePath, content] of definitions) await writeFileAtomic(filePath, content, { mode: 0o600 });
  return layout;
}

async function installCommand(args) {
  assertMacOS();
  const { options } = optionMap(args);
  let existing;
  try { existing = (await readBridgeConfig(repositoryRoot)).raw; } catch {}
  const nodeExecutable = await discoverNode(existing?.nodeExecutable);
  if (!options.has("skip-dependency-install")) {
    const npmExecutable = await discoverNpm(nodeExecutable);
    await runNpmCi(nodeExecutable, npmExecutable);
  }
  const larkCliEntry = path.join(repositoryRoot, "node_modules", "@larksuite", "cli", "scripts", "run.js");
  await fs.access(larkCliEntry);
  const codexExecutable = await discoverCodex(existing?.codexExecutable);

  let config = existing;
  if (!config || options.has("force-config")) {
    const identity = await larkIdentity(nodeExecutable, larkCliEntry);
    const appId = identity.appId;
    const ownerOpenId = identity.ownerOpenId;
    const botOpenId = identity.status?.identities?.bot?.verified ? identity.status.identities.bot.openId : undefined;
    if (!validAppId(appId) || !validOpenId(ownerOpenId)) {
      throw new Error("A verified Feishu App ID and owner identity are required. Complete Feishu CLI app setup and user OAuth, then retry.");
    }
    const port = Number(options.get("app-server-port") || 47321);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--app-server-port must be between 1024 and 65535.");
    const workspace = path.join(os.homedir(), "Library", "Application Support", "FeishuCodexBridge");
    config = {
      schemaVersion: 4,
      mode: "session-relay",
      appId,
      workspace,
      agent: { ownerOpenId, ...(validOpenId(botOpenId) ? { botOpenId } : {}) },
      sessionRelay: {
        nameSync: "none",
        appServerUrl: `ws://127.0.0.1:${port}/rpc`,
        displayTimeZone: "Asia/Shanghai",
        promptPreviewChars: 4000,
        feedGroup: { enabled: true, agentName: String(options.get("agent-name") || "Codex") },
        inboundAttachments: {
          enabled: true,
          maxItems: 10,
          maxFileBytes: 31457280,
          maxTotalBytes: 62914560,
          retentionHours: 168,
          maxCacheBytes: 1073741824,
        },
        bindings: [],
      },
      nodeExecutable,
      larkCliEntry,
      codexExecutable,
      sandboxMode: "workspace-write",
      completionPollMs: 30000,
      completionStableMs: 15000,
      httpTimeoutMs: 20000,
      handshakeTimeoutMs: 20000,
      deliveryRetryMs: 60000,
      maxInputChars: 12000,
      maxReplyChars: 10000,
    };
    await ensurePrivateDirectory(workspace);
    await writeJsonAtomic(path.join(repositoryRoot, "bridge.config.json"), config);
  }
  if (config.mode !== "session-relay") throw new Error("The existing config is not in session-relay mode.");
  await installMacOSRuntime(config);
  const layout = await writeMacOSLaunchAgents(config);
  if (!options.has("no-user-changes")) {
    await installSkill(layout);
    if (!existing || options.has("force-config")) {
      await Promise.all([
        setLaunchAgentEnabled(MACOS_LABELS.appServer, false),
        setLaunchAgentEnabled(MACOS_LABELS.bridge, false),
        setLaunchAgentEnabled(MACOS_LABELS.relay, false),
      ]);
    }
  }
  process.stdout.write("macOS installation prepared. Next: save the Channel secret, start the Bridge, and run doctor.\n");
}

async function keychainHasSecret(identity) {
  try {
    await execFile("/usr/bin/security", [
      "find-generic-password", "-a", identity.account, "-s", identity.service,
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64_000 });
    return true;
  } catch {
    return false;
  }
}

async function setupSecretCommand() {
  assertMacOS();
  await readBridgeConfig(repositoryRoot);
  const identity = keychainIdentity(repositoryRoot);
  process.stdout.write("Paste the Feishu App Secret at the macOS Keychain prompt. Input stays hidden.\n");
  const code = await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", [
      "add-generic-password", "-U", "-a", identity.account, "-s", identity.service,
      "-l", identity.label, "-w",
    ], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  if (code !== 0 || !(await keychainHasSecret(identity))) throw new Error("The Channel secret was not saved to macOS Keychain.");
  process.stdout.write("Channel secret saved in macOS Keychain; no plaintext file was created.\n");
}

async function waitUntil(check, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function bridgeReady(layout, config) {
  const pid = await readPid(layout.bridgePidPath);
  const nodeExecutable = path.resolve(repositoryRoot, String(config.nodeExecutable));
  const bridgeScript = config.mode === "session-relay" ? "session-relay.mjs" : "channel-bridge.mjs";
  if (!pid || !(await isExpectedProcess(pid, [nodeExecutable, bridgeScript]))) return false;
  try {
    const marker = JSON.parse(await fs.readFile(layout.bridgeReadyPath, "utf8"));
    return Number(marker?.pid) === pid && marker?.mode === bridgeScript.replace(/\.mjs$/, "");
  }
  catch { return false; }
}

async function appServerReady(layout, config, endpoint) {
  const pid = await readPid(layout.appServerPidPath);
  const codexExecutable = path.resolve(repositoryRoot, String(config.codexExecutable));
  return Boolean(pid
    && await isExpectedProcess(pid, [codexExecutable, "app-server", `:${endpoint.port}`])
    && await appServerReadyProbe(endpoint));
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

async function statusSnapshot() {
  const { raw: config } = await readBridgeConfig(repositoryRoot);
  const layout = runtimeLayout(repositoryRoot, config);
  const endpoint = parseLoopbackAppServerUrl(config.sessionRelay?.appServerUrl);
  const [bridgePid, supervisorPid, appServerPid] = await Promise.all([
    readPid(layout.bridgePidPath), readPid(layout.supervisorPidPath), readPid(layout.appServerPidPath),
  ]);
  const [bridgeProcess, supervisorProcess, appServerProcess, listener, pointer] = await Promise.all([
    bridgePid ? isExpectedProcess(bridgePid, [String(config.nodeExecutable), config.mode === "session-relay" ? "session-relay.mjs" : "channel-bridge.mjs"]) : false,
    supervisorPid ? isExpectedProcess(supervisorPid, [String(config.nodeExecutable), "macos-bridge-supervisor.mjs"]) : false,
    appServerPid ? isExpectedProcess(appServerPid, [String(config.codexExecutable), "app-server", `:${endpoint.port}`]) : false,
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
  return { config, layout, endpoint, bridgePid, supervisorPid, appServerPid, bridgeProcess, supervisorProcess, appServerProcess, listener, connected, pointer, relay, desktop };
}

async function statusCommand() {
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

const DESKTOP_APPLICATIONS = Object.freeze([
  Object.freeze({ bundlePath: "/Applications/ChatGPT.app", executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }),
  Object.freeze({ bundlePath: "/Applications/Codex.app", executable: "/Applications/Codex.app/Contents/MacOS/Codex" }),
]);

async function desktopProcessTable() {
  try {
    const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 2_000_000,
    });
    return String(stdout || "").split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) return [];
      const pid = Number(match[1]);
      return Number.isSafeInteger(pid) && pid > 0 ? [{ pid, command: match[2] }] : [];
    });
  } catch {
    return [];
  }
}

async function runningDesktopApplications() {
  const processes = await desktopProcessTable();
  const results = [];
  for (const application of DESKTOP_APPLICATIONS) {
    const matches = processes
      .filter(({ command }) => command === application.executable || command.startsWith(`${application.executable} `));
    if (matches.length > 0) results.push({ ...application, pids: matches.map(({ pid }) => pid), commands: matches.map(({ command }) => command) });
  }
  return results;
}

async function embeddedDesktopAppServerRunning() {
  const processes = await desktopProcessTable();
  const executables = DESKTOP_APPLICATIONS.map(({ bundlePath }) => path.join(bundlePath, "Contents", "Resources", "codex"));
  return processes.some(({ command }) => executables.some((executable) =>
    command.startsWith(`${executable} `)
      && /(?:^|\s)app-server(?:\s|$)/.test(command)
      && !/(?:^|\s)--listen(?:\s|$)/.test(command)));
}

export function safeLoopbackProxyArgument(value) {
  const candidate = String(value || "").replace(/^--proxy-server=/, "");
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (["http:", "https:", "socks4:", "socks5:"].includes(url.protocol)
      && ["127.0.0.1", "localhost", "::1"].includes(host)
      && url.port && !url.username && !url.password && !url.pathname.replaceAll("/", "")
      && !url.search && !url.hash) {
      return `--proxy-server=${url.href.replace(/\/$/, "")}`;
    }
  } catch {}
  return undefined;
}

function safeDesktopLaunchArguments(application, configuredProxyUrl) {
  const requested = safeLoopbackProxyArgument(configuredProxyUrl || process.env.FEISHU_CODEX_DESKTOP_PROXY_URL);
  if (requested) return [requested];
  for (const command of application?.commands || []) {
    const match = command.match(/(?:^|\s)--proxy-server=([^\s]+)/);
    const argument = safeLoopbackProxyArgument(match?.[1]);
    if (argument) return [argument];
  }
  return [];
}

async function processHasEnvironment(pid, name, expectedValue) {
  try {
    const { stdout } = await execFile("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 2_000_000,
    });
    return String(stdout || "").includes(`${name}=${expectedValue}`);
  } catch {
    return false;
  }
}

async function processHasRelayEnvironment(pid, expectedUrl) {
  return processHasEnvironment(pid, RELAY_ENVIRONMENT_VARIABLE, expectedUrl);
}

async function desktopRelayAttachment(expectedUrl) {
  const running = await runningDesktopApplications();
  if (running.length === 0) return "not-running";
  for (const application of running) {
    for (const pid of application.pids) {
      if (await processHasRelayEnvironment(pid, expectedUrl)) return "attached";
    }
  }
  return "detached";
}

async function relayHeartbeatReady(layout, expectedUrl) {
  try {
    const [value, activation] = await Promise.all([
      fs.readFile(layout.relayStatusPath, "utf8").then(JSON.parse),
      fs.readFile(layout.relayStatePath, "utf8").then(JSON.parse),
    ]);
    const age = Date.now() - Date.parse(value.heartbeatAt);
    return value.state === "ready" && activation.enabled === true && activation.url === expectedUrl
      && value.activationId === activation.activationId && age >= -5_000 && age <= 20_000;
  } catch {
    return false;
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
    programArguments: [nodeExecutable, path.join(status.layout.installationDir, "macos-relay-watchdog.mjs")],
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

async function doctorCommand(args) {
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
    add("Keychain secret", await keychainHasSecret(keychainIdentity(repositoryRoot)), "item is present and readable for the current user");
    for (const [name, filePath] of [["Environment LaunchAgent", layout.environmentPlistPath], ["App Server LaunchAgent", layout.appServerPlistPath], ["Bridge LaunchAgent", layout.bridgePlistPath]]) {
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
      "docx:document:write_only",
    ];
    const missingScopes = requiredScopes.filter((scope) => !scopeSet.has(scope));
    add("Feishu user OAuth scopes", missingScopes.length === 0, missingScopes.length === 0 ? "required scopes are granted" : `missing: ${missingScopes.join(", ")}`);
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
  for (const check of checks) process.stdout.write(`${check.passed ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  if (checks.some(({ passed }) => !passed)) process.exitCode = 1;
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

async function dependenciesCommand() {
  assertMacOS();
  let existing;
  try { existing = (await readBridgeConfig(repositoryRoot)).raw; } catch {}
  const nodeExecutable = await discoverNode(existing?.nodeExecutable);
  const npmExecutable = await discoverNpm(nodeExecutable);
  await runNpmCi(nodeExecutable, npmExecutable);
  process.stdout.write("Pinned repository dependencies are installed.\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "install": return installCommand(args);
    case "setup-secret": return setupSecretCommand(args);
    case "start": return startCommand(args);
    case "stop": return stopCommand(args);
    case "status": return statusCommand(args);
    case "doctor": return doctorCommand(args);
    case "configure-desktop-relay": return configureRelayCommand(args);
    case "launch-desktop-relay": return launchDesktopRelayCommand(args);
    case "lark-cli": return larkCliCommand(args);
    case "dependencies": return dependenciesCommand();
    case "update": return (await import("./macos-update.mjs")).runMacOSUpdate(args);
    default: throw new Error("Usage: macos-admin.mjs dependencies|install|setup-secret|start|stop|status|doctor|configure-desktop-relay|launch-desktop-relay|lark-cli|update");
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
