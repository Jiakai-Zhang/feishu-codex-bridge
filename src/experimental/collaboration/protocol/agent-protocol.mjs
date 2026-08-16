import { randomUUID } from "node:crypto";
import { canonicalGitHubRepository } from "./collaboration-request-inbox.mjs";

const AGENT_EVENT_KINDS = Object.freeze([
  "task.request",
  "task.accepted",
  "task.progress",
  "task.result",
  "task.blocked",
  "task.rejected",
  "task.approved",
]);

const EVENT_KINDS = new Set(AGENT_EVENT_KINDS);
const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const TASK_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const BRANCH = /^(?![./])(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))[A-Za-z0-9._/-]{1,200}$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const RECEIVE_MODES = new Set(["manual", "recommend", "auto"]);
const RESULT_MODES = new Set(["notify", "resume"]);
const LANDINGS = new Set(["existing-thread", "new-thread", "new-worktree"]);
const MAX_WIRE_BYTES = 24_000;

function requiredString(value, field, max) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} is too long`);
  return normalized;
}

function boundedGit(value, field = "payload.git") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} is required`);
  const remote = requiredString(value.remote, `${field}.remote`, 100);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new TypeError(`${field}.remote is invalid`);
  const branch = requiredString(value.branch, `${field}.branch`, 200);
  if (!BRANCH.test(branch)) throw new TypeError(`${field}.branch is invalid`);
  const commit = requiredString(value.commit, `${field}.commit`, 40).toLowerCase();
  if (!COMMIT.test(commit)) throw new TypeError(`${field}.commit must be a full Git SHA`);
  const prUrl = value.prUrl ? requiredString(value.prUrl, `${field}.prUrl`, 2_000) : undefined;
  return { remote, branch, commit, ...(prUrl ? { prUrl } : {}) };
}

function boundedPayload(kind, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("payload must be an object");
  }
  if (kind === "task.request") {
    const receiveMode = String(payload.receiveMode || "recommend").trim();
    const resultMode = String(payload.resultMode || "notify").trim();
    if (!RECEIVE_MODES.has(receiveMode)) throw new TypeError("payload.receiveMode is invalid");
    if (!RESULT_MODES.has(resultMode)) throw new TypeError("payload.resultMode is invalid");
    return {
      title: requiredString(payload.title, "payload.title", 160),
      prompt: requiredString(payload.prompt, "payload.prompt", 12_000),
      receiveMode,
      resultMode,
      git: boundedGit(payload.git),
    };
  }
  if (kind === "task.accepted") {
    const landing = payload.landing ? requiredString(payload.landing, "payload.landing", 40) : undefined;
    if (landing && !LANDINGS.has(landing)) throw new TypeError("payload.landing is invalid");
    return {
      message: payload.message ? requiredString(payload.message, "payload.message", 2_000) : undefined,
      landing,
    };
  }
  if (kind === "task.progress") {
    return { message: requiredString(payload.message, "payload.message", 2_000) };
  }
  if (kind === "task.result") {
    return {
      summary: requiredString(payload.summary, "payload.summary", 12_000),
      git: boundedGit(payload.git),
    };
  }
  if (kind === "task.blocked" || kind === "task.rejected") {
    return { reason: requiredString(payload.reason, "payload.reason", 2_000) };
  }
  if (kind === "task.approved") {
    return { note: payload.note ? requiredString(payload.note, "payload.note", 2_000) : undefined };
  }
  return { message: payload.message ? requiredString(payload.message, "payload.message", 2_000) : undefined };
}

function validateRoleFlow(event) {
  if (event.kind === "task.request" || event.kind === "task.approved") {
    if (event.fromAgentId !== event.requesterAgentId || event.toAgentId !== event.executorAgentId) {
      throw new TypeError(`${event.kind} must flow from requester to executor`);
    }
    return;
  }
  if (event.fromAgentId !== event.executorAgentId || event.toAgentId !== event.requesterAgentId) {
    throw new TypeError(`${event.kind} must flow from executor to requester`);
  }
}

export function validateAgentEvent(event, {
  now = Date.now(),
  maxTtlMs = 15 * 60_000,
  maxHops = 2,
} = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("Agent event must be an object");
  if (event.schemaVersion !== 2) throw new TypeError("Unsupported agent event schemaVersion");
  if (!EVENT_KINDS.has(event.kind)) throw new TypeError(`Unsupported agent event kind: ${event.kind}`);
  if (!EVENT_ID.test(String(event.eventId || ""))) throw new TypeError("Invalid eventId");
  if (!TASK_ID.test(String(event.taskId || ""))) throw new TypeError("Invalid taskId");
  if (!CHAT_ID.test(String(event.groupChatId || ""))) throw new TypeError("Invalid groupChatId");
  for (const field of ["fromAgentId", "toAgentId", "requesterAgentId", "executorAgentId"]) {
    if (!AGENT_ID.test(String(event[field] || ""))) throw new TypeError(`Invalid ${field}`);
  }
  if (!Number.isInteger(event.createdAt) || !Number.isInteger(event.expiresAt)) {
    throw new TypeError("createdAt and expiresAt must be integer milliseconds");
  }
  if (event.createdAt > now + 60_000) throw new TypeError("Agent event was created in the future");
  if (event.expiresAt <= now) throw new TypeError("Agent event has expired");
  if (event.expiresAt <= event.createdAt || event.expiresAt - event.createdAt > maxTtlMs) {
    throw new TypeError("Agent event TTL exceeds the configured limit");
  }
  if (!Number.isInteger(event.hop) || event.hop < 0 || event.hop > maxHops) {
    throw new TypeError("Agent event hop exceeds the configured limit");
  }
  validateRoleFlow(event);
  const payload = boundedPayload(event.kind, event.payload);
  return Object.freeze({
    ...event,
    githubRepository: canonicalGitHubRepository(event.githubRepository),
    payload: Object.freeze(payload),
  });
}

export function validateIncomingAgentEvent(event, {
  config,
  peer,
  chatId,
  now = Date.now(),
}) {
  const validated = validateAgentEvent(event, {
    now,
    maxTtlMs: config.collaboration.eventTtlMs,
    maxHops: config.collaboration.maxHops,
  });
  if (validated.groupChatId !== config.collaboration.groupChatId || (chatId && validated.groupChatId !== chatId)) {
    throw new TypeError("Agent event group does not match the bound Feishu group");
  }
  if (validated.githubRepository !== config.collaboration.githubRepository) {
    throw new TypeError("Agent event repository does not match the bound GitHub repository");
  }
  if (validated.fromAgentId !== peer.agentId) throw new TypeError("Agent event sender does not match the authenticated peer Bot");
  if (validated.toAgentId !== config.agent.id) throw new TypeError("Agent event is addressed to another Agent");
  return validated;
}

export function createAgentEvent({
  kind,
  taskId = `task:${randomUUID()}`,
  groupChatId,
  githubRepository,
  fromAgentId,
  toAgentId,
  requesterAgentId,
  executorAgentId,
  payload = {},
  hop = 0,
}, { now = Date.now(), ttlMs = 15 * 60_000 } = {}) {
  return validateAgentEvent({
    schemaVersion: 2,
    eventId: `evt:${randomUUID()}`,
    taskId,
    kind,
    groupChatId,
    githubRepository,
    fromAgentId,
    toAgentId,
    requesterAgentId,
    executorAgentId,
    createdAt: now,
    expiresAt: now + ttlMs,
    hop,
    payload,
  }, { now, maxTtlMs: ttlMs, maxHops: Math.max(2, hop) });
}

export function encodeAgentEvent(event) {
  const json = JSON.stringify(event);
  if (Buffer.byteLength(json, "utf8") > MAX_WIRE_BYTES) throw new TypeError("Agent event exceeds the wire size limit");
  return `/agent-event ${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function decodeAgentEvent(content) {
  const match = String(content || "").trim().match(/^\/agent-event\s+([A-Za-z0-9_-]+)$/);
  if (!match) throw new TypeError("Unsupported Agent event wire format");
  if (match[1].length > Math.ceil(MAX_WIRE_BYTES * 4 / 3) + 4) throw new TypeError("Agent event exceeds the wire size limit");
  const bytes = Buffer.from(match[1], "base64url");
  if (bytes.length === 0 || bytes.length > MAX_WIRE_BYTES) throw new TypeError("Agent event exceeds the wire size limit");
  let event;
  try { event = JSON.parse(bytes.toString("utf8")); }
  catch { throw new TypeError("Agent event payload is not valid JSON"); }
  return event;
}
