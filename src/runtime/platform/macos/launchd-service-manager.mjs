import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

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

export async function waitForLaunchAgentState(label, expectedLoaded, {
  timeoutMs = 5_000,
  intervalMs = 100,
  probe = launchAgentIsLoaded,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (Boolean(await probe(label)) === Boolean(expectedLoaded)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() <= deadline);
  return false;
}

export async function bootstrapLaunchAgent(label, plistPath) {
  if (await launchAgentIsLoaded(label)) return;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await launchctl(["bootstrap", launchDomain(), plistPath], { allowFailure: true });
    if (await waitForLaunchAgentState(label, true, { timeoutMs: 2_000 })) return;
  }
  throw new Error(`LaunchAgent ${label} did not remain loaded after registration.`);
}

export async function bootoutLaunchAgent(label) {
  if (await launchAgentIsLoaded(label)) {
    await launchctl(["bootout", `${launchDomain()}/${label}`], { allowFailure: true });
    if (!(await waitForLaunchAgentState(label, false))) {
      throw new Error(`LaunchAgent ${label} did not unload before re-registration.`);
    }
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
    '<key>ProcessType</key><string>Background</string>',
    `<key>StandardOutPath</key><string>${xmlEscape(stdoutPath)}</string>`,
    `<key>StandardErrorPath</key><string>${xmlEscape(stderrPath)}</string>`,
    '</dict></plist>',
    "",
  ].join("\n");
}
