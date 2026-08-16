import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

function sanitizedMessage(value) {
  return String(value || "Binding request failed")
    .replace(/\b(?:cli|ou|oc)_[A-Za-z0-9_-]+\b/g, "[private identifier]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[task]")
    .replace(/(?:\/[\w .@%+~\-\u0080-\uFFFF]+){2,}/g, "[local path]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);
}

function write(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = exitCode;
}

try {
  const pointerPath = path.join(os.homedir(), "Library", "Application Support", "FeishuCodexBridge", "bootstrap", "installation.json");
  let pointer = {};
  try { pointer = JSON.parse(await fs.readFile(pointerPath, "utf8")); } catch {}
  const bridgeHome = process.env.FEISHU_CODEX_BRIDGE_HOME || pointer.repositoryRoot;
  if (!bridgeHome || !path.isAbsolute(bridgeHome)) throw new Error("Bridge installation is not registered for the current user.");
  const configPath = path.join(bridgeHome, "bridge.config.json");
  const requestScript = path.join(bridgeHome, "request-session-binding.mjs");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.access(requestScript);
  const threadId = String(process.env.CODEX_THREAD_ID || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error("The current Codex task ID is unavailable; run this Skill inside a Codex task.");
  }
  const nodeExecutable = String(config.nodeExecutable || pointer.nodeExecutable || "");
  await fs.access(nodeExecutable);
  let output;
  let exitCode = 0;
  try {
    ({ stdout: output } = await execFile(nodeExecutable, [requestScript, "--thread-id", threadId], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1_000_000,
    }));
  } catch (error) {
    output = error?.stdout;
    exitCode = Number.isInteger(error?.code) ? error.code : 1;
  }
  let response;
  try { response = JSON.parse(String(output || "").trim()); }
  catch { throw new Error("The Bridge returned an invalid binding response."); }
  if (response?.ok) {
    write({
      ok: true,
      result: {
        alreadyBound: Boolean(response.result?.alreadyBound),
        groupName: String(response.result?.groupName || ""),
        feedGroupName: String(response.result?.feedGroupName || ""),
        restart: Boolean(response.result?.restart),
      },
    });
  } else {
    write({
      ok: false,
      error: {
        code: String(response?.error?.code || "binding_request_failed").slice(0, 100),
        message: sanitizedMessage(response?.error?.message),
        missingScopes: Array.isArray(response?.error?.missingScopes)
          ? response.error.missingScopes.filter((item) => typeof item === "string").slice(0, 10)
          : [],
      },
    }, exitCode || 1);
  }
} catch (error) {
  write({
    ok: false,
    error: {
      code: "binding_request_unavailable",
      message: sanitizedMessage(error?.message),
      missingScopes: [],
    },
  }, 1);
}
