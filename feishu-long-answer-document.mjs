import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function parseJsonEnvelope(text) {
  const value = String(text || "").trim();
  if (!value) return undefined;
  try { return JSON.parse(value); }
  catch {}
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try { return JSON.parse(value.slice(start, end + 1)); }
  catch { return undefined; }
}

function safeDocumentUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { return undefined; }
  const hostname = url.hostname.toLowerCase();
  const trustedHost = hostname === "feishu.cn"
    || hostname.endsWith(".feishu.cn")
    || hostname === "larksuite.com"
    || hostname.endsWith(".larksuite.com");
  if (!trustedHost || url.protocol !== "https:" || url.username || url.password || !/^\/docx\//.test(url.pathname)) {
    return undefined;
  }
  return url.href;
}

export function runLarkCliDocumentJson(nodeExecutable, larkCliEntry, args, {
  cwd = process.cwd(),
  input = "",
  execFile = nodeExecFile,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      requiredString(nodeExecutable, "nodeExecutable"),
      [requiredString(larkCliEntry, "larkCliEntry"), ...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 10_000_000,
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
          const failure = new Error("Feishu document creation failed", { cause: error });
          failure.name = "FeishuLongAnswerDocumentError";
          failure.code = envelope?.error?.subtype === "missing_scope"
            ? "document_auth_required"
            : "document_create_failed";
          reject(failure);
          return;
        }
        resolve(envelope);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(String(input), "utf8");
  });
}

export function shouldCreateLongAnswerDocument(answer, maxReplyChars) {
  const text = String(answer || "").trim();
  const threshold = Math.max(1, Number(maxReplyChars) || 10_000);
  return text.length > threshold;
}

export function buildLongAnswerDocumentMarkdown(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      if (segment?.type === "text") return String(segment.text || "").trim();
      if (segment?.type === "image") {
        const alt = String(segment.alt || "").trim();
        return `> 图片将在飞书消息中单独投递${alt ? `：${alt}` : ""}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function buildLongAnswerDocumentTitle(completedAtMs, timeZone = "Asia/Shanghai") {
  const date = Number.isFinite(Number(completedAtMs)) ? new Date(Number(completedAtMs)) : new Date();
  const timestamp = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `Codex 完整回答（${timestamp}）`;
}

export class FeishuLongAnswerDocumentManager {
  constructor({
    nodeExecutable,
    larkCliEntry,
    cwd = process.cwd(),
    runCommand = runLarkCliDocumentJson,
  }) {
    this.nodeExecutable = requiredString(nodeExecutable, "nodeExecutable");
    this.larkCliEntry = requiredString(larkCliEntry, "larkCliEntry");
    this.cwd = cwd;
    this.runCommand = runCommand;
  }

  async create({ title, markdown }) {
    const response = await this.runCommand(this.nodeExecutable, this.larkCliEntry, [
      "docs", "+create",
      "--as", "user",
      "--doc-format", "markdown",
      "--title", requiredString(title, "title"),
      "--content", "-",
      "--format", "json",
    ], {
      cwd: this.cwd,
      input: requiredString(markdown, "markdown"),
    });
    const url = safeDocumentUrl(response?.data?.document?.url);
    if (!url) {
      const error = new Error("Feishu document creation returned no safe document URL");
      error.name = "FeishuLongAnswerDocumentError";
      error.code = "document_invalid_response";
      throw error;
    }
    return Object.freeze({ url });
  }
}

function documentKey(threadId, turnId) {
  return `${String(threadId || "")}:${String(turnId || "")}`;
}

function normalizeRecord(record) {
  const threadId = requiredString(record?.threadId, "threadId");
  const turnId = requiredString(record?.turnId, "turnId");
  const url = safeDocumentUrl(record?.url);
  if (!url) throw new TypeError("A safe Feishu document URL is required");
  return {
    threadId,
    turnId,
    url,
    createdAt: Number(record?.createdAt) || Date.now(),
  };
}

export class LongAnswerDocumentStore {
  constructor(filePath, records = []) {
    this.filePath = requiredString(filePath, "filePath");
    this.records = new Map(records.map((record) => {
      const normalized = normalizeRecord(record);
      return [documentKey(normalized.threadId, normalized.turnId), normalized];
    }));
    this.writeTail = Promise.resolve();
  }

  static async open(filePath) {
    let records = [];
    try {
      const value = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!Array.isArray(value)) throw new TypeError("Long-answer document store must contain an array");
      records = value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return new LongAnswerDocumentStore(filePath, records);
  }

  get(threadId, turnId) {
    const record = this.records.get(documentKey(threadId, turnId));
    return record ? structuredClone(record) : undefined;
  }

  list() {
    return [...this.records.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => structuredClone(record));
  }

  async put(record) {
    const normalized = normalizeRecord(record);
    this.records.set(documentKey(normalized.threadId, normalized.turnId), normalized);
    await this.persist();
    return structuredClone(normalized);
  }

  async remove(threadId, turnId) {
    if (!this.records.delete(documentKey(threadId, turnId))) return false;
    await this.persist();
    return true;
  }

  async persist() {
    const snapshot = JSON.stringify(this.list(), null, 2);
    this.writeTail = this.writeTail.then(
      () => fs.writeFile(this.filePath, snapshot, "utf8"),
      () => fs.writeFile(this.filePath, snapshot, "utf8"),
    );
    await this.writeTail;
  }
}
