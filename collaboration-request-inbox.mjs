import { promises as fs } from "node:fs";
import path from "node:path";

const REQUEST_ID = /^req:[0-9a-f-]{36}$/i;
const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
const RECEIVE_MODES = new Set(["manual", "recommend", "auto"]);
const GIT_SYNC_MODES = new Set(["push", "reference"]);
const RESULT_MODES = new Set(["notify", "resume"]);

function requiredString(value, field, max = 12_000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} is too long`);
  return normalized;
}

function validateId(value, field) {
  const normalized = requiredString(value, field, 64);
  if (!AGENT_ID.test(normalized)) throw new TypeError(`${field} is invalid`);
  return normalized;
}

export function canonicalGitHubRepository(value) {
  let candidate = requiredString(value, "githubRepository", 500);
  const scpMatch = candidate.match(/^git@github\.com:(.+)$/i);
  if (scpMatch) candidate = scpMatch[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    let parsed;
    try { parsed = new URL(candidate); }
    catch { throw new TypeError("Git remote URL is invalid"); }
    if (parsed.hostname.toLowerCase() !== "github.com") throw new TypeError("Only github.com repositories are supported");
    candidate = parsed.pathname;
  }
  candidate = candidate.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) {
    throw new TypeError("GitHub repository must be owner/name");
  }
  if (candidate.split("/").some((component) => component === "." || component === "..")) {
    throw new TypeError("GitHub repository must not contain dot path components");
  }
  return candidate.toLowerCase();
}

export function validateCollaborationRequest(raw, {
  now = Date.now(),
  maxTtlMs = 24 * 60 * 60_000,
} = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Collaboration request must be an object");
  }
  if (raw.schemaVersion !== 1) throw new TypeError("Unsupported collaboration request schemaVersion");
  if (!REQUEST_ID.test(String(raw.requestId || ""))) throw new TypeError("Invalid collaboration requestId");
  if (!Number.isInteger(raw.createdAt) || !Number.isInteger(raw.expiresAt)) {
    throw new TypeError("createdAt and expiresAt must be integer milliseconds");
  }
  if (raw.createdAt > now + 60_000) throw new TypeError("Collaboration request was created in the future");
  if (raw.expiresAt <= now) throw new TypeError("Collaboration request has expired");
  if (raw.expiresAt <= raw.createdAt || raw.expiresAt - raw.createdAt > maxTtlMs) {
    throw new TypeError("Collaboration request TTL exceeds the configured limit");
  }
  if (!raw.source || typeof raw.source !== "object" || Array.isArray(raw.source)) {
    throw new TypeError("source is required");
  }
  if (!raw.action || typeof raw.action !== "object" || Array.isArray(raw.action)) {
    throw new TypeError("action is required");
  }
  if (raw.action.type !== "delegate") throw new TypeError("Unsupported collaboration action type");
  const groupChatId = requiredString(raw.source.groupChatId, "source.groupChatId", 160);
  if (!CHAT_ID.test(groupChatId)) throw new TypeError("source.groupChatId is invalid");
  const source = {
    agentId: validateId(raw.source.agentId, "source.agentId"),
    projectId: validateId(raw.source.projectId, "source.projectId"),
    groupChatId,
    githubRepository: canonicalGitHubRepository(raw.source.githubRepository),
    cwd: path.resolve(requiredString(raw.source.cwd, "source.cwd", 2_000)),
    threadId: raw.source.threadId ? requiredString(raw.source.threadId, "source.threadId", 160) : undefined,
    remote: requiredString(raw.source.remote, "source.remote", 100),
    branch: requiredString(raw.source.branch, "source.branch", 200),
    head: requiredString(raw.source.head, "source.head", 40).toLowerCase(),
  };
  if (!SHA.test(source.head)) throw new TypeError("source.head must be a full Git commit SHA");
  const receiveMode = String(raw.action.receiveMode || "recommend").trim();
  const gitSyncMode = String(raw.action.gitSyncMode || "push").trim();
  const resultMode = String(raw.action.resultMode || "notify").trim();
  if (!RECEIVE_MODES.has(receiveMode)) throw new TypeError("action.receiveMode is invalid");
  if (!GIT_SYNC_MODES.has(gitSyncMode)) throw new TypeError("action.gitSyncMode is invalid");
  if (!RESULT_MODES.has(resultMode)) throw new TypeError("action.resultMode is invalid");
  return Object.freeze({
    schemaVersion: 1,
    requestId: raw.requestId,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    source: Object.freeze(source),
    action: Object.freeze({
      type: "delegate",
      peerAgentId: validateId(raw.action.peerAgentId, "action.peerAgentId"),
      title: requiredString(raw.action.title, "action.title", 160),
      prompt: requiredString(raw.action.prompt, "action.prompt", 12_000),
      receiveMode,
      gitSyncMode,
      resultMode,
    }),
  });
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
  await fs.rename(tempPath, filePath);
}

export class CollaborationRequestInbox {
  static async open(rootPath) {
    const inbox = new CollaborationRequestInbox(rootPath);
    await Promise.all([
      fs.mkdir(inbox.incomingPath, { recursive: true }),
      fs.mkdir(inbox.resultsPath, { recursive: true }),
    ]);
    return inbox;
  }

  constructor(rootPath) {
    this.rootPath = path.resolve(rootPath);
    this.incomingPath = path.join(this.rootPath, "incoming");
    this.resultsPath = path.join(this.rootPath, "results");
  }

  async list({ now = Date.now() } = {}) {
    let names = [];
    try { names = await fs.readdir(this.incomingPath); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const pending = [];
    for (const name of names.filter((candidate) => /^req_[0-9a-f-]{36}\.json$/i.test(candidate)).sort()) {
      const filePath = path.join(this.incomingPath, name);
      try {
        const request = validateCollaborationRequest(JSON.parse(await fs.readFile(filePath, "utf8")), { now });
        const expectedRequestId = `req:${name.slice("req_".length, -".json".length)}`;
        if (request.requestId.toLowerCase() !== expectedRequestId.toLowerCase()) {
          throw new TypeError("Collaboration requestId does not match its inbox filename");
        }
        pending.push({ filePath, request });
      } catch (error) {
        pending.push({ filePath, error });
      }
    }
    return pending;
  }

  async finish(filePath, requestId, result) {
    if (!REQUEST_ID.test(String(requestId || ""))) throw new TypeError("Invalid collaboration requestId");
    const resultPath = path.join(this.resultsPath, `${requestId.replace(":", "_")}.json`);
    try {
      const existing = JSON.parse(await fs.readFile(resultPath, "utf8"));
      if (existing?.schemaVersion !== 1 || existing?.requestId !== requestId) {
        throw new Error("Collaboration result path contains a different request");
      }
      await fs.rm(filePath, { force: true });
      return resultPath;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await writeJsonAtomic(resultPath, {
      ...result,
      schemaVersion: 1,
      requestId,
      completedAt: Date.now(),
    });
    await fs.rm(filePath, { force: true });
    return resultPath;
  }
}
