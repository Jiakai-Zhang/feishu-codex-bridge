import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { RELAY_ENVIRONMENT_VARIABLE } from "./constants.mjs";

const execFile = promisify(nodeExecFile);

export const DESKTOP_APPLICATIONS = Object.freeze([
  Object.freeze({ bundlePath: "/Applications/ChatGPT.app", executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }),
  Object.freeze({ bundlePath: "/Applications/Codex.app", executable: "/Applications/Codex.app/Contents/MacOS/Codex" }),
]);

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

export async function runningDesktopApplications() {
  const processes = await desktopProcessTable();
  const results = [];
  for (const application of DESKTOP_APPLICATIONS) {
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
  applications = DESKTOP_APPLICATIONS,
  access = fs.access,
} = {}) {
  for (const application of applications) {
    try {
      await access(application.bundlePath);
      return application.bundlePath;
    } catch {}
  }
  return undefined;
}

export async function embeddedDesktopAppServerRunning() {
  const processes = await desktopProcessTable();
  const executables = DESKTOP_APPLICATIONS.map(({ bundlePath }) => path.join(bundlePath, "Contents", "Resources", "codex"));
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
