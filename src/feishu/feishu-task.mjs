import { execFile as nodeExecFile } from "node:child_process";
import { parseJsonEnvelope, requiredString } from "./lark-cli-json.mjs";

function taskError(code, message, options = {}) {
  const error = new Error(message, options);
  error.name = "FeishuTaskError";
  error.code = code;
  if (options.missingScopes) error.missingScopes = Object.freeze([...options.missingScopes]);
  return error;
}

function safeTaskUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { return undefined; }
  const host = url.hostname.toLowerCase();
  const trusted = host === "feishu.cn" || host.endsWith(".feishu.cn")
    || host === "larksuite.com" || host.endsWith(".larksuite.com")
    || host === "larkoffice.com" || host.endsWith(".larkoffice.com");
  return url.protocol === "https:" && trusted && !url.username && !url.password ? url.href : undefined;
}

function commandFailure(error, stdout, stderr) {
  const envelope = parseJsonEnvelope(stderr) || parseJsonEnvelope(stdout);
  const missingScopes = Array.isArray(envelope?.error?.missing_scopes)
    ? envelope.error.missing_scopes.filter((scope) => typeof scope === "string")
    : [];
  if (
    envelope?.error?.type === "authorization"
    || envelope?.error?.subtype === "missing_scope"
    || missingScopes.length > 0
  ) {
    return taskError(
      "task_auth_required",
      "The Feishu user authorization cannot create tasks",
      { cause: error, missingScopes },
    );
  }
  if (error?.code === "ENOENT") {
    return taskError("task_cli_unavailable", "The configured Feishu CLI runtime is unavailable", { cause: error });
  }
  return taskError("task_api_error", "The Feishu task request failed", { cause: error });
}

export function runLarkCliTaskJson(nodeExecutable, larkCliEntry, args, {
  cwd = process.cwd(),
  execFile = nodeExecFile,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      requiredString(nodeExecutable, "nodeExecutable"),
      [requiredString(larkCliEntry, "larkCliEntry"), ...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 2_000_000,
        timeout: 120_000,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      },
      (error, stdout, stderr) => {
        const envelope = parseJsonEnvelope(stdout) || parseJsonEnvelope(stderr);
        if (error || envelope?.ok !== true) {
          reject(commandFailure(error || new Error("Invalid Feishu CLI response"), stdout, stderr));
          return;
        }
        resolve(envelope);
      },
    );
  });
}

export class FeishuTaskManager {
  constructor({
    nodeExecutable,
    larkCliEntry,
    assigneeOpenId,
    cwd = process.cwd(),
    runCommand = runLarkCliTaskJson,
  } = {}) {
    this.nodeExecutable = requiredString(nodeExecutable, "nodeExecutable");
    this.larkCliEntry = requiredString(larkCliEntry, "larkCliEntry");
    this.assigneeOpenId = requiredString(assigneeOpenId, "assigneeOpenId");
    this.cwd = cwd;
    this.runCommand = runCommand;
  }

  async create({ summary, due, idempotencyKey }) {
    const args = [
      "task", "+create",
      "--as", "user",
      "--summary", requiredString(summary, "summary"),
      "--assignee", this.assigneeOpenId,
      "--idempotency-key", requiredString(idempotencyKey, "idempotencyKey"),
      "--format", "json",
    ];
    if (due) args.push("--due", String(due));
    const response = await this.runCommand(this.nodeExecutable, this.larkCliEntry, args, { cwd: this.cwd });
    const data = response?.data;
    return Object.freeze({
      summary: requiredString(summary, "summary"),
      due: due ? String(due) : undefined,
      url: safeTaskUrl(
        data?.task?.url
        || data?.task?.task_url
        || data?.url
        || data?.task_url
        || response?.url,
      ),
    });
  }
}
