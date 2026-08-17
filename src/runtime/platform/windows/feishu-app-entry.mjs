import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildFeishuBridgeAppTemplateUrl,
  summarizeFeishuBridgeAppVerification,
} from "../../../feishu/feishu-app-template.mjs";
import { directNetworkEnvironment } from "../../shared/network-environment.mjs";
import { openPrivateFeishuUrl } from "../../shared/private-browser-redirect.mjs";
import { safeError } from "../../shared/safe-error.mjs";
import { assertPlatform } from "../detect.mjs";

const execFile = promisify(nodeExecFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function extractJson(text) {
  const source = String(text || "");
  for (let index = source.indexOf("{"); index >= 0; index = source.indexOf("{", index + 1)) {
    try { return JSON.parse(source.slice(index)); } catch {}
  }
  return undefined;
}

async function larkJson(args) {
  const entryPath = path.join(repositoryRoot, "node_modules", "@larksuite", "cli", "scripts", "run.js");
  try {
    await fs.access(entryPath);
  } catch {
    throw new Error("The repository-local Lark CLI is missing. Run npm ci first.");
  }
  try {
    const { stdout, stderr } = await execFile(process.execPath, [entryPath, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: directNetworkEnvironment(),
      timeout: 30_000,
      maxBuffer: 2_000_000,
    });
    return extractJson(`${stdout}\n${stderr}`);
  } catch (error) {
    return extractJson(`${error?.stdout || ""}\n${error?.stderr || ""}`);
  }
}

async function openWindowsUrl(url) {
  const windowsDirectory = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const rundll32 = path.join(windowsDirectory, "System32", "rundll32.exe");
  await execFile(rundll32, ["url.dll,FileProtocolHandler", url], {
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 64_000,
  });
}

async function configureCommand(args) {
  if (args.length > 0) throw new Error("configure does not accept arguments.");
  const status = await larkJson(["auth", "status", "--json", "--verify"]);
  const appId = status?.appId;
  if (!/^cli_[A-Za-z0-9_-]+$/.test(String(appId || ""))) {
    throw new Error("Lark CLI is not bound to a verified Feishu app. Complete config init first.");
  }
  const targetUrl = buildFeishuBridgeAppTemplateUrl(appId);
  await openPrivateFeishuUrl(targetUrl, {
    open: openWindowsUrl,
    timeoutMs: 120_000,
    onReady: (localUrl) => {
      process.stdout.write([
        "Temporary local browser fallback (valid for up to two minutes):",
        localUrl,
        "If no browser opens automatically, open that URL on this Windows PC.",
      ].join("\n") + "\n");
    },
  });
  process.stdout.write(
    "Feishu app template opened in the browser. Review and confirm the requested scopes and message event; no change is applied until you confirm there.\n",
  );
}

async function verifyCommand(args) {
  if (args.length > 0) throw new Error("verify does not accept arguments.");
  const [authStatus, eventDryRun] = await Promise.all([
    larkJson(["auth", "status", "--json", "--verify"]),
    larkJson(["event", "consume", "im.message.receive_v1", "--as", "bot", "--dry-run"]),
  ]);
  const summary = summarizeFeishuBridgeAppVerification(authStatus, eventDryRun);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.ok) process.exitCode = 1;
}

async function main() {
  assertPlatform("windows");
  const [command, ...args] = process.argv.slice(2);
  if (command === "configure") return configureCommand(args);
  if (command === "verify") return verifyCommand(args);
  throw new Error("Usage: feishu-app-entry.mjs configure|verify");
}

const invokedPath = await fs.realpath(path.resolve(process.argv[1] || "")).catch(() => path.resolve(process.argv[1] || ""));
const modulePath = await fs.realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`Windows Feishu app command failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  }
}
