import { execFile as nodeExecFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RELAY_ENVIRONMENT_VARIABLE } from "./constants.mjs";

const execFile = promisify(nodeExecFile);

export const DESKTOP_BUNDLE_IDENTIFIERS = Object.freeze([
  "com.openai.codex",
  "com.openai.chatgpt",
]);
export const DESKTOP_TEAM_IDENTIFIERS = Object.freeze(["2DC432GLL2"]);

export const DESKTOP_APPLICATIONS = Object.freeze([
  Object.freeze({ bundlePath: "/Applications/ChatGPT.app", executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }),
  Object.freeze({ bundlePath: "/Applications/Codex.app", executable: "/Applications/Codex.app/Contents/MacOS/Codex" }),
  Object.freeze({ bundlePath: path.join(os.homedir(), "Applications", "ChatGPT.app"), executable: path.join(os.homedir(), "Applications", "ChatGPT.app", "Contents", "MacOS", "ChatGPT") }),
  Object.freeze({ bundlePath: path.join(os.homedir(), "Applications", "Codex.app"), executable: path.join(os.homedir(), "Applications", "Codex.app", "Contents", "MacOS", "Codex") }),
]);

async function plistMetadata(bundlePath) {
  const infoPath = path.join(bundlePath, "Contents", "Info.plist");
  const read = async (key) => {
    const { stdout } = await execFile("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPath], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 128_000,
    });
    return String(stdout || "").trim();
  };
  const [bundleIdentifier, executableName] = await Promise.all([
    read("CFBundleIdentifier"),
    read("CFBundleExecutable"),
  ]);
  return { bundleIdentifier, executableName };
}

async function verifyDesktopSignature(bundlePath) {
  await execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundlePath], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 512_000,
  });
  const { stderr } = await execFile("/usr/bin/codesign", ["-dv", "--verbose=4", bundlePath], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 512_000,
  });
  const teamIdentifier = String(stderr || "").match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!DESKTOP_TEAM_IDENTIFIERS.includes(teamIdentifier)) {
    throw new Error("Desktop application signing identity is not approved.");
  }
}

export async function resolveDesktopApplication(bundlePath, {
  realpath = fs.realpath,
  access = fs.access,
  readMetadata = plistMetadata,
  verifySignature = verifyDesktopSignature,
  allowedBundleIdentifiers = DESKTOP_BUNDLE_IDENTIFIERS,
} = {}) {
  const candidate = path.resolve(String(bundlePath || ""));
  if (!candidate.endsWith(".app")) throw new Error("Desktop candidate is not an application bundle.");
  const canonicalBundlePath = await realpath(candidate);
  const { bundleIdentifier, executableName } = await readMetadata(canonicalBundlePath);
  if (!allowedBundleIdentifiers.includes(bundleIdentifier)) {
    throw new Error("Desktop application bundle identity is not approved.");
  }
  await verifySignature(canonicalBundlePath);
  if (!executableName || path.basename(executableName) !== executableName || [".", ".."].includes(executableName)) {
    throw new Error("Desktop application executable identity is invalid.");
  }
  const executableDirectory = path.join(canonicalBundlePath, "Contents", "MacOS");
  const executable = await realpath(path.join(executableDirectory, executableName));
  const relative = path.relative(executableDirectory, executable);
  if (relative !== executableName || path.isAbsolute(relative)) {
    throw new Error("Desktop application executable resolves outside its signed bundle layout.");
  }
  await access(executable, fsConstants.X_OK);
  return Object.freeze({
    bundlePath: canonicalBundlePath,
    bundleIdentifier,
    executable,
  });
}

export async function spotlightDesktopBundlePaths() {
  try {
    const query = DESKTOP_BUNDLE_IDENTIFIERS
      .map((identifier) => `kMDItemCFBundleIdentifier == '${identifier}'`)
      .join(" || ");
    const { stdout } = await execFile("/usr/bin/mdfind", [query], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 1_000_000,
    });
    return String(stdout || "").split(/\r?\n/).map((value) => value.trim()).filter((value) => value.endsWith(".app"));
  } catch {
    return [];
  }
}

export async function installedDesktopApplications({
  fallbackApplications = DESKTOP_APPLICATIONS,
  discoverBundlePaths = spotlightDesktopBundlePaths,
  resolveApplication = resolveDesktopApplication,
} = {}) {
  const discovered = await discoverBundlePaths();
  const candidates = [...new Set([
    ...fallbackApplications.map(({ bundlePath }) => bundlePath),
    ...discovered,
  ])];
  const applications = [];
  for (const bundlePath of candidates) {
    try { await fs.access(bundlePath); }
    catch { continue; }
    try {
      const application = await resolveApplication(bundlePath);
      if (!applications.some(({ executable }) => executable === application.executable)) applications.push(application);
    } catch {
      throw new Error("An installed ChatGPT/Codex Desktop candidate could not be verified.");
    }
  }
  return applications;
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

export function desktopProxySelection({ requestedValue, noProxy = false } = {}) {
  const requestedText = String(requestedValue || "").trim();
  if (noProxy && requestedText) {
    throw new Error("--proxy cannot be combined with --no-proxy.");
  }
  if (noProxy || !requestedText) return Object.freeze({ mode: "direct", proxyUrl: undefined });
  const argument = safeLoopbackProxyArgument(requestedText);
  if (!argument) {
    throw new Error("The Desktop proxy must be an unauthenticated loopback URL with an explicit port.");
  }
  return Object.freeze({ mode: "explicit", proxyUrl: argument.slice("--proxy-server=".length) });
}

export function proxyEnvironment(proxyUrl) {
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

export async function persistedDesktopProxyUrl(layout) {
  try {
    const activation = JSON.parse(await fs.readFile(layout.relayStatePath, "utf8"));
    const argument = safeLoopbackProxyArgument(activation.desktopProxyUrl);
    return argument?.slice("--proxy-server=".length);
  } catch {
    return undefined;
  }
}

export async function requiredPersistedDesktopProxyUrl(layout) {
  let activation;
  try {
    activation = JSON.parse(await fs.readFile(layout.relayStatePath, "utf8"));
  } catch {
    throw new Error("The saved Desktop relay network selection is missing or unreadable.");
  }
  if (activation.enabled !== true) throw new Error("The saved Desktop relay is not enabled.");
  const rawProxy = String(activation.desktopProxyUrl || "").trim();
  if (!rawProxy) return undefined;
  const argument = safeLoopbackProxyArgument(rawProxy);
  if (!argument) throw new Error("The saved Desktop proxy is not a safe loopback URL.");
  return argument.slice("--proxy-server=".length);
}

export async function desktopProcessTable() {
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

export async function runningDesktopApplications({
  applications,
  processTable = desktopProcessTable,
} = {}) {
  const [processes, resolvedApplications] = await Promise.all([
    processTable(),
    applications ? Promise.resolve(applications) : installedDesktopApplications(),
  ]);
  const results = [];
  for (const application of resolvedApplications) {
    const matches = processes
      .filter(({ command }) => command === application.executable || command.startsWith(`${application.executable} `));
    if (matches.length > 0) {
      results.push({
        ...application,
        pids: matches.map(({ pid }) => pid),
        commands: matches.map(({ command }) => command),
      });
    }
  }
  return results;
}

export async function installedDesktopBundlePath({
  applications,
  access = fs.access,
} = {}) {
  if (!applications) return (await installedDesktopApplications())[0]?.bundlePath;
  for (const application of applications) {
    try {
      await access(application.bundlePath);
      return application.bundlePath;
    } catch {}
  }
  return undefined;
}

export async function embeddedDesktopAppServerRunning({
  applications,
  processTable = desktopProcessTable,
} = {}) {
  const [processes, resolvedApplications] = await Promise.all([
    processTable(),
    applications ? Promise.resolve(applications) : installedDesktopApplications(),
  ]);
  const executables = resolvedApplications.map(({ bundlePath }) => path.join(bundlePath, "Contents", "Resources", "codex"));
  return processes.some(({ command }) => executables.some((executable) =>
    command.startsWith(`${executable} `)
      && /(?:^|\s)app-server(?:\s|$)/.test(command)
      && !/(?:^|\s)--listen(?:\s|$)/.test(command)));
}

export function safeDesktopLaunchArguments(configuredProxyUrl) {
  const requested = safeLoopbackProxyArgument(configuredProxyUrl);
  return requested ? [requested] : [];
}

export async function processHasEnvironment(pid, name, expectedValue) {
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

export function proxyEnvironmentMatches(commandText, proxyUrl) {
  const command = String(commandText || "");
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  if (proxyUrl) return names.every((name) => command.includes(`${name}=${proxyUrl}`));
  return names.every((name) => !command.includes(`${name}=`));
}

export async function processProxyEnvironmentMatches(pid, proxyUrl) {
  try {
    const { stdout } = await execFile("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 2_000_000,
    });
    return proxyEnvironmentMatches(stdout, proxyUrl);
  } catch {
    return false;
  }
}

export async function desktopRelayAttachment(expectedUrl) {
  const running = await runningDesktopApplications();
  if (running.length === 0) return "not-running";
  for (const application of running) {
    for (const pid of application.pids) {
      if (await processHasEnvironment(pid, RELAY_ENVIRONMENT_VARIABLE, expectedUrl)) return "attached";
    }
  }
  return "detached";
}

export async function relayHeartbeatReady(layout, expectedUrl) {
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
