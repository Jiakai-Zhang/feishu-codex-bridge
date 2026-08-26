import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_INBOUND_ATTACHMENT_LIMITS } from "../feishu/feishu-inbound-attachment.mjs";

const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const NAME_SYNC_MODES = new Set(["none", "group-to-session", "require-match"]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function positiveNumber(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function optionalBoolean(value, fallback, field) {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function normalizeLoopbackAppServerUrl(value) {
  if (value == null || String(value).trim() === "") return undefined;
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new TypeError("sessionRelay.appServerUrl must be a valid WebSocket URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    throw new TypeError("sessionRelay.appServerUrl must use ws:// on a loopback host");
  }
  if (!url.port || url.username || url.password || url.search || url.hash) {
    throw new TypeError("sessionRelay.appServerUrl must contain only a loopback host, port, and /rpc path");
  }
  if (url.pathname === "/") url.pathname = "/rpc";
  if (url.pathname !== "/rpc") throw new TypeError("sessionRelay.appServerUrl path must be /rpc");
  return url.href;
}

function normalizeTimeZone(value) {
  const timeZone = String(value || "Asia/Shanghai").trim();
  try { new Intl.DateTimeFormat("zh-CN", { timeZone }).format(new Date(0)); }
  catch { throw new TypeError("sessionRelay.displayTimeZone must be a valid IANA time zone"); }
  return timeZone;
}

function normalizeBinding(binding, index, defaultOwnerOpenId) {
  const field = `sessionRelay.bindings[${index}]`;
  const groupChatId = requiredString(binding?.groupChatId, `${field}.groupChatId`);
  const threadId = requiredString(binding?.threadId, `${field}.threadId`);
  const ownerOpenId = requiredString(binding?.ownerOpenId || defaultOwnerOpenId, `${field}.ownerOpenId`);
  if (!CHAT_ID.test(groupChatId)) throw new TypeError(`Invalid ${field}.groupChatId`);
  if (!THREAD_ID.test(threadId)) throw new TypeError(`Invalid ${field}.threadId`);
  if (!OPEN_ID.test(ownerOpenId)) throw new TypeError(`Invalid ${field}.ownerOpenId`);
  return Object.freeze({ groupChatId, threadId, ownerOpenId });
}

export function normalizeSessionRelayConfig(raw, { configDir = process.cwd() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Bridge config must be a JSON object");
  }
  const mode = String(raw.mode || "project-agent").trim().toLowerCase();
  if (mode !== "session-relay") {
    throw new TypeError("Session Relay requires mode=session-relay");
  }

  const ownerOpenId = requiredString(raw.agent?.ownerOpenId || raw.allowedSenderOpenId, "agent.ownerOpenId");
  const botOpenId = raw.agent?.botOpenId == null || String(raw.agent.botOpenId).trim() === ""
    ? undefined
    : String(raw.agent.botOpenId).trim();
  if (!OPEN_ID.test(ownerOpenId)) throw new TypeError("Invalid agent.ownerOpenId");
  if (botOpenId && !OPEN_ID.test(botOpenId)) throw new TypeError("Invalid agent.botOpenId");

  let rawBindings = raw.sessionRelay?.bindings;
  if (!Array.isArray(rawBindings) || rawBindings.length === 0) {
    const legacyGroupChatId = raw.collaboration?.groupChatId;
    if (legacyGroupChatId && raw.threadId) {
      rawBindings = [{ groupChatId: legacyGroupChatId, threadId: raw.threadId }];
    }
  }
  if (!Array.isArray(rawBindings)) rawBindings = [];
  const bindings = rawBindings.map((binding, index) => normalizeBinding(binding, index, ownerOpenId));
  if (new Set(bindings.map(({ groupChatId }) => groupChatId)).size !== bindings.length) {
    throw new TypeError("sessionRelay groupChatIds must be unique");
  }
  if (new Set(bindings.map(({ threadId }) => threadId)).size !== bindings.length) {
    throw new TypeError("sessionRelay threadIds must be unique");
  }

  const nameSync = String(raw.sessionRelay?.nameSync || "none").trim().toLowerCase();
  if (!NAME_SYNC_MODES.has(nameSync)) {
    throw new TypeError("sessionRelay.nameSync must be none, group-to-session, or require-match");
  }
  const sandboxMode = String(raw.sandboxMode || "workspace-write").trim();
  if (!SANDBOX_MODES.has(sandboxMode)) throw new TypeError("Invalid sandboxMode");
  const appServerUrl = normalizeLoopbackAppServerUrl(raw.sessionRelay?.appServerUrl);
  if (!appServerUrl) {
    throw new TypeError("sessionRelay.appServerUrl is required for persistent turn steering and control");
  }
  const displayTimeZone = normalizeTimeZone(raw.sessionRelay?.displayTimeZone);
  const promptPreviewChars = positiveNumber(raw.sessionRelay?.promptPreviewChars, 4_000, {
    min: 200,
    max: 10_000,
  });
  const rawInboundAttachments = raw.sessionRelay?.inboundAttachments;
  const inboundAttachmentsEnabled = optionalBoolean(
    rawInboundAttachments?.enabled,
    true,
    "sessionRelay.inboundAttachments.enabled",
  );
  const inboundAttachmentMaxItems = Math.trunc(positiveNumber(
    rawInboundAttachments?.maxItems,
    DEFAULT_INBOUND_ATTACHMENT_LIMITS.maxItems,
    { min: 1, max: 50 },
  ));
  const inboundAttachmentMaxFileBytes = Math.trunc(positiveNumber(
    rawInboundAttachments?.maxFileBytes,
    DEFAULT_INBOUND_ATTACHMENT_LIMITS.maxFileBytes,
    { min: 1024, max: 100 * 1024 * 1024 },
  ));
  const inboundAttachmentMaxTotalBytes = Math.trunc(positiveNumber(
    rawInboundAttachments?.maxTotalBytes,
    DEFAULT_INBOUND_ATTACHMENT_LIMITS.maxTotalBytes,
    { min: 1024, max: 500 * 1024 * 1024 },
  ));
  const inboundAttachmentRetentionHours = positiveNumber(
    rawInboundAttachments?.retentionHours,
    DEFAULT_INBOUND_ATTACHMENT_LIMITS.retentionMs / (60 * 60 * 1000),
    { min: 1, max: 24 * 365 },
  );
  const inboundAttachmentMaxCacheBytes = Math.trunc(positiveNumber(
    rawInboundAttachments?.maxCacheBytes,
    DEFAULT_INBOUND_ATTACHMENT_LIMITS.maxCacheBytes,
    { min: inboundAttachmentMaxTotalBytes, max: 20 * 1024 * 1024 * 1024 },
  ));
  const feedGroupEnabled = optionalBoolean(
    raw.sessionRelay?.feedGroup?.enabled,
    false,
    "sessionRelay.feedGroup.enabled",
  );
  const feedGroupAgentName = requiredString(
    raw.sessionRelay?.feedGroup?.agentName || "Codex",
    "sessionRelay.feedGroup.agentName",
  );
  const rollingSummaryDebounceSeconds = positiveNumber(
    raw.sessionRelay?.rollingSummary?.debounceSeconds,
    60,
    { min: 0, max: 3_600 },
  );
  const rollingSummaryMaxSummaryChars = Math.trunc(positiveNumber(
    raw.sessionRelay?.rollingSummary?.maxSummaryChars,
    4_000,
    { min: 500, max: 20_000 },
  ));
  const rollingSummaryMaxBatchChars = Math.trunc(positiveNumber(
    raw.sessionRelay?.rollingSummary?.maxBatchChars,
    24_000,
    { min: 2_000, max: 100_000 },
  ));
  const larkCliEntry = raw.larkCliEntry == null || String(raw.larkCliEntry).trim() === ""
    ? undefined
    : path.resolve(configDir, requiredString(raw.larkCliEntry, "larkCliEntry"));
  if (feedGroupEnabled && !larkCliEntry) {
    throw new TypeError("larkCliEntry is required when sessionRelay.feedGroup.enabled=true");
  }

  return Object.freeze({
    mode,
    appId: requiredString(raw.appId, "appId"),
    workspace: path.resolve(configDir, requiredString(raw.workspace, "workspace")),
    nodeExecutable: requiredString(raw.nodeExecutable || process.execPath, "nodeExecutable"),
    larkCliEntry,
    codexExecutable: requiredString(raw.codexExecutable, "codexExecutable"),
    sandboxMode,
    httpTimeoutMs: positiveNumber(raw.httpTimeoutMs, 20_000, { min: 1_000, max: 120_000 }),
    handshakeTimeoutMs: positiveNumber(raw.handshakeTimeoutMs, 20_000, { min: 1_000, max: 120_000 }),
    deliveryRetryMs: positiveNumber(raw.deliveryRetryMs, 60_000, { min: 15_000, max: 15 * 60_000 }),
    completionPollMs: positiveNumber(raw.completionPollMs, 30_000, { min: 1_000, max: 5 * 60_000 }),
    completionStableMs: positiveNumber(raw.completionStableMs, 15_000, { min: 1_000, max: 5 * 60_000 }),
    maxInputChars: positiveNumber(raw.maxInputChars, 12_000, { min: 1, max: 100_000 }),
    maxReplyChars: positiveNumber(raw.maxReplyChars, 10_000, { min: 1, max: 30_000 }),
    agent: Object.freeze({ ownerOpenId, botOpenId }),
    sessionRelay: Object.freeze({
      nameSync,
      appServerUrl,
      displayTimeZone,
      promptPreviewChars,
      inboundAttachments: Object.freeze({
        enabled: inboundAttachmentsEnabled,
        maxItems: inboundAttachmentMaxItems,
        maxFileBytes: inboundAttachmentMaxFileBytes,
        maxTotalBytes: inboundAttachmentMaxTotalBytes,
        retentionMs: inboundAttachmentRetentionHours * 60 * 60 * 1000,
        maxCacheBytes: inboundAttachmentMaxCacheBytes,
      }),
      feedGroup: Object.freeze({
        enabled: feedGroupEnabled,
        agentName: feedGroupAgentName,
      }),
      rollingSummary: Object.freeze({
        debounceMs: rollingSummaryDebounceSeconds * 1_000,
        maxSummaryChars: rollingSummaryMaxSummaryChars,
        maxBatchChars: rollingSummaryMaxBatchChars,
      }),
      bindings: Object.freeze(bindings),
    }),
  });
}

export async function loadSessionRelayConfig(filePath) {
  const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  return normalizeSessionRelayConfig(raw, { configDir: path.dirname(filePath) });
}
