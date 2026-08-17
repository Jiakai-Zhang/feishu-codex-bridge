import { execFile as nodeExecFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nodeVersionSupported } from "../../shared/node-version.mjs";
import {
  ensurePrivateDirectory,
  writeFileAtomic,
  writeJsonAtomic,
} from "../../shared/private-state.mjs";
import { assertMacOS, MACOS_LABELS } from "./constants.mjs";
import { persistedDesktopProxyUrl, proxyEnvironment } from "./desktop-runtime.mjs";
import { optionMap } from "./cli-options.mjs";
import {
  buildLaunchAgentPlist,
  setLaunchAgentEnabled,
} from "./launchd-service-manager.mjs";
import { launchEnvironment } from "./launch-environment.mjs";
import { readBridgeConfig, runtimeLayout } from "./runtime-layout.mjs";

const execFile = promisify(nodeExecFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REQUIRED_RUNTIME_PATHS = Object.freeze([
  "src/runtime/platform/macos/launch-environment.mjs",
  "src/runtime/platform/macos/environment-entry.mjs",
  "src/runtime/platform/macos/app-server-entry.mjs",
  "src/runtime/platform/macos/bridge-supervisor-entry.mjs",
  "src/runtime/platform/macos/relay-watchdog-entry.mjs",
  "channel-bridge.mjs",
  "session-relay.mjs",
  "request-session-binding.mjs",
]);

function candidateList(...values) {
  return [...new Set(values.flat().filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

export async function executableWorks(candidate, args, validator) {
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

export async function larkJson(nodeExecutable, entryPath, args) {
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
    await Promise.all(REQUIRED_RUNTIME_PATHS.map((name) => fs.access(path.join(repositoryRoot, name))));
    await fs.cp(path.join(repositoryRoot, "src"), path.join(stagingDir, "src"), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    for (const name of REQUIRED_RUNTIME_PATHS.filter((entry) => !entry.startsWith("src/"))) {
      await fs.copyFile(path.join(repositoryRoot, name), path.join(stagingDir, name));
    }
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
  await Promise.all(REQUIRED_RUNTIME_PATHS.map((name) => fs.access(path.join(installedRoot, name))));
  const definitions = [
    [layout.environmentPlistPath, buildLaunchAgentPlist({
      label: MACOS_LABELS.environment,
      programArguments: [nodeExecutable, path.join(installedRoot, "src", "runtime", "platform", "macos", "environment-entry.mjs")],
      workingDirectory: installedRoot,
      environment,
      keepAlive: false,
      stdoutPath: path.join(layout.logsDir, "environment.stdout.log"),
      stderrPath: path.join(layout.logsDir, "environment.stderr.log"),
    })],
    [layout.appServerPlistPath, buildLaunchAgentPlist({
      label: MACOS_LABELS.appServer,
      programArguments: [nodeExecutable, path.join(installedRoot, "src", "runtime", "platform", "macos", "app-server-entry.mjs")],
      workingDirectory: layout.workspace,
      environment: appServerEnvironment,
      keepAlive: true,
      stdoutPath: layout.appServerStdoutPath,
      stderrPath: layout.appServerStderrPath,
    })],
    [layout.bridgePlistPath, buildLaunchAgentPlist({
      label: MACOS_LABELS.bridge,
      programArguments: [nodeExecutable, path.join(installedRoot, "src", "runtime", "platform", "macos", "bridge-supervisor-entry.mjs")],
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

export async function runInstallCommand(args) {
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
  process.stdout.write("macOS installation prepared. Next: confirm the Channel secret is stored, start the Bridge, and run doctor.\n");
}


export async function runDependenciesCommand() {
  assertMacOS();
  let existing;
  try { existing = (await readBridgeConfig(repositoryRoot)).raw; } catch {}
  const nodeExecutable = await discoverNode(existing?.nodeExecutable);
  const npmExecutable = await discoverNpm(nodeExecutable);
  await runNpmCi(nodeExecutable, npmExecutable);
  process.stdout.write("Pinned repository dependencies are installed.\n");
}
