import { createSerializedFileWriter, readJsonArrayFile } from "../persistence/serialized-json-file.mjs";
import { heartbeatMetadataText, unwrapHeartbeatEnvelope } from "../codex/codex-turn-collector.mjs";
import { buildNativeAttachmentDeliveries } from "./feishu-native-attachment.mjs";

const MAX_STORED_PROGRESS = 12;
const EXECUTION_STATUS_TYPES = new Set(["running", "reconnecting", "retrying", "failed", "interrupted", "completed"]);
const FAILURE_REASONS = new Set(["network", "authentication", "capacity", "context", "unknown"]);

function normalizeExecutionStatus(status) {
  if (!EXECUTION_STATUS_TYPES.has(status?.type)) return undefined;
  return {
    type: status.type,
    ...(FAILURE_REASONS.has(status.reason) ? { reason: status.reason } : {}),
    updatedAtMs: Number(status.updatedAtMs) || Date.now(),
    ...(status.uneditable === true ? { uneditable: true } : {}),
  };
}

function executionStatusNotice(status) {
  if (status?.type === "reconnecting") return "与本机 Codex 的连接暂时中断，Bridge 正在自动重连。原任务可能仍在运行，不会重复提交旧指令。";
  if (status?.type === "retrying") return "模型请求暂时失败，Codex 正在按原生策略自动重试。重试耗尽后会在本卡片明确显示失败。";
  if (status?.type === "interrupted") return "本轮已停止，未生成完整结果。已完成的操作和上下文保留；如需继续，请发送“继续”。";
  if (status?.type === "completed") return "Codex 本轮已结束，但未返回正文。已完成的操作和上下文保留；可在原任务查看结果，或发送“继续”。";
  if (status?.type !== "failed") return undefined;
  const reasons = {
    network: "模型连接中断，原生重试后本轮仍未完成。",
    authentication: "Codex 登录或授权异常，本轮未完成。请先在 Codex 处理登录或授权。",
    capacity: "Codex 额度或限流异常，本轮未完成。请用 `/capacity` 查看额度并等待恢复。",
    context: "当前上下文超出模型限制，本轮未完成。请先在 Codex 处理上下文容量。",
    unknown: "Codex 本轮执行失败，未生成完整结果。请在 Codex 查看错误详情。",
  };
  const action = status.reason === "network"
    ? "连接恢复后发送“继续”，会在原上下文开启新一轮，不重放旧输入。"
    : "处理后可发送“继续”；Bridge 不会自动绕过此错误。";
  return `${reasons[status.reason] || reasons.unknown}\n\n已完成的操作和上下文保留。${action}`;
}

export function buildSessionStreamCardFollowups(baseRecord, attachments) {
  return buildNativeAttachmentDeliveries(baseRecord, attachments);
}

function recordKey(threadId, turnId) {
  return `${String(threadId || "")}:${String(turnId || "")}`;
}

function compactSummary(value, max = 50) {
  const compact = String(value || "")
    .replace(/```[\s\S]*?```/g, "代码")
    .replace(/[*_#>`~\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "Codex 正在处理";
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function boundedMarkdown(value, maxChars, suffix) {
  const text = String(value || "").trim();
  const limit = Math.max(1, Number(maxChars) || 10_000);
  if (text.length <= limit) return text;
  const tail = `\n\n${suffix}`;
  if (tail.length >= limit) return text.slice(0, limit);
  return `${text.slice(0, Math.max(1, limit - tail.length))}${tail}`;
}

function formatTimestamp(timestampMs, timeZone) {
  const value = Number(timestampMs);
  if (!Number.isFinite(value) || value <= 0) return "暂不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatDuration(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value < 0) return "暂不可用";
  if (value > 0 && value < 1_000) return "<1秒";
  const seconds = Math.round(value / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}小时${String(minutes).padStart(2, "0")}分${String(remainder).padStart(2, "0")}秒`;
  if (minutes > 0) return `${minutes}分${remainder}秒`;
  return `${remainder}秒`;
}

function finalElements({ answer, answerSegments, maxAnswerChars }) {
  const source = Array.isArray(answerSegments) && answerSegments.length > 0
    ? answerSegments
    : [{ type: "text", text: answer }];
  const elements = [];
  let remaining = Math.max(1, Number(maxAnswerChars) || 10_000);
  let truncated = false;

  for (const segment of source) {
    if (segment?.type === "image" && segment.imageKey) {
      elements.push({
        tag: "img",
        img_key: String(segment.imageKey),
        alt: { tag: "plain_text", content: "Codex 回复中的图片" },
      });
      continue;
    }
    if (segment?.type !== "text" || remaining <= 0) continue;
    const text = unwrapHeartbeatEnvelope(segment.text);
    if (!text) continue;
    const clipped = boundedMarkdown(
      text,
      remaining,
      "（回复过长，已截断；完整内容保留在绑定的 Codex 任务中。）",
    );
    if (clipped.length < text.length) truncated = true;
    remaining -= clipped.length;
    elements.push({ tag: "markdown", content: clipped });
  }

  if (elements.length === 0) {
    elements.push({ tag: "markdown", content: "Codex 已完成处理，但没有返回文本结果。" });
  } else if (remaining <= 0 && !truncated) {
    elements.push({ tag: "markdown", content: "（回复过长，后续内容保留在绑定的 Codex 任务中。）" });
  }
  return elements;
}

export function buildSessionStreamCard({
  progress = [],
  queued,
  executionStatus,
  startedAtMs,
  nowMs = Date.now(),
  answer,
  answerSegments,
  completedAtMs,
  durationMs,
  tokenUsage,
  heartbeatSchedule,
  timeZone = "Asia/Shanghai",
  maxAnswerChars = 10_000,
} = {}) {
  const isComplete = answer !== undefined || (Array.isArray(answerSegments) && answerSegments.length > 0);
  let elements;
  let summarySource;

  if (isComplete) {
    elements = finalElements({ answer, answerSegments, maxAnswerChars });
    const totalTokens = Number(tokenUsage?.totalTokens);
    const tokenText = Number.isFinite(totalTokens) && totalTokens >= 0
      ? totalTokens.toLocaleString("zh-CN")
      : "暂不可用";
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: `*回答时间：${formatTimestamp(completedAtMs, timeZone)} · 用时：${formatDuration(durationMs)} · 本轮 Token：${tokenText}*`,
    });
    const heartbeatText = heartbeatMetadataText({ answer, answerSegments, heartbeatSchedule });
    if (heartbeatText) {
      elements.push({ tag: "hr" });
      elements.push({ tag: "markdown", content: `*${heartbeatText}*` });
    }
    summarySource = unwrapHeartbeatEnvelope(
      answer || answerSegments?.find((segment) => segment?.type === "text")?.text || "Codex 回复完成",
    );
  } else if (["failed", "interrupted", "completed"].includes(executionStatus?.type)) {
    const title = { failed: "本轮未完成", interrupted: "本轮已停止", completed: "本轮已结束（无正文）" }[executionStatus.type];
    elements = [{ tag: "markdown", content: `**${title}**\n\n${executionStatusNotice(executionStatus)}` }];
    const lastProgress = progress.filter((item) => item.kind !== "subagent").at(-1);
    if (lastProgress?.text) elements.push({ tag: "markdown", content: `**中断前的公开进度**\n\n${String(lastProgress.text).slice(0, 4_000)}` });
    elements.push({ tag: "markdown", text_size: "notation", content: `停止时间：${formatTimestamp(executionStatus.updatedAtMs, timeZone)}` });
    summarySource = title;
  } else if (queued && progress.length === 0) {
    const title = queued.cancelled ? "已取消排队" : "已加入下一轮队列";
    const details = queued.cancelled
      ? "这条消息不会进入 Codex。"
      : `当前排位：${Math.max(1, Number(queued.position) || 1)}\n\n任务空闲后作为独立的新 Turn 开始。`;
    elements = [{
      tag: "column_set",
      flex_mode: "none",
      columns: [{
        tag: "column", width: "weighted", weight: 1,
        background_style: "blue-50", padding: "12px", vertical_spacing: "4px",
        elements: [{ tag: "markdown", content: `**${title}**\n\n${details}` }],
      }],
    }, {
      tag: "markdown", text_size: "notation",
      content: queued.notice || (queued.cancelled
        ? "可发送新消息重新排队。"
        : "如需调整当前方向：使用 `/settings input steer` 后再发送。任务开始后，本卡片会直接显示执行进度。"),
    }];
    summarySource = title;
  } else {
    const elapsedMs = Number.isFinite(Number(startedAtMs))
      ? Math.max(0, Number(nowMs) - Number(startedAtMs))
      : undefined;
    const elapsedText = elapsedMs === undefined
      ? ""
      : ` · 已处理：${formatDuration(elapsedMs)}`;
    const subagentProgress = progress.filter((item) => item.kind === "subagent").at(-1);
    const items = [...progress].filter((item) => item.kind !== "subagent")
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
      .slice(-6);
    const progressMarkdown = items.length > 0
      ? items.map((item) => {
        const label = Number.isSafeInteger(Number(item.sequence)) && Number(item.sequence) > 0
          ? `**进度 ${Number(item.sequence)}**`
          : "**公开进度**";
        return `${label}\n\n${String(item.text || "").trim()}`;
      }).join("\n\n---\n\n")
      : "正在等待 Codex 返回公开进度…";
    elements = [{
      tag: "markdown",
      content: `**Codex 正在处理${elapsedText}**\n\n${progressMarkdown}${subagentProgress ? `\n\n---\n\n**子 agent 协作**\n\n${subagentProgress.text}` : ""}\n\n*这里只展示公开进度，不包含隐藏思考过程。*`,
    }];
    const statusNotice = executionStatusNotice(executionStatus);
    if (statusNotice) elements.unshift({ tag: "markdown", content: `**${executionStatus.type === "reconnecting" ? "正在重新连接" : "正在重试"}**\n\n${statusNotice}` });
    summarySource = items.at(-1)?.text || subagentProgress?.text || "Codex 正在处理";
    if (statusNotice) summarySource = executionStatus.type === "reconnecting" ? "正在重新连接 Codex" : "Codex 正在重试";
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: compactSummary(summarySource) },
    },
    body: { elements },
  };
}

function normalizeProgress(item) {
  return {
    ...(item?.kind === "subagent" ? { kind: "subagent", activityKey: "subagents" } : {}),
    sequence: Math.max(0, Number(item?.sequence) || 0),
    text: String(item?.text || "").slice(0, 4_000),
    createdAtMs: Number(item?.createdAtMs) || Date.now(),
  };
}

function retainedProgress(progress) {
  const activity = progress.filter((item) => item.kind === "subagent").at(-1);
  const commentary = progress.filter((item) => item.kind !== "subagent").slice(-MAX_STORED_PROGRESS);
  return [...commentary, ...(activity ? [activity] : [])].sort((left, right) => left.sequence - right.sequence);
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") throw new TypeError("Stream card record must be an object");
  const threadId = String(record.threadId || "");
  const turnId = String(record.turnId || "");
  const chatId = String(record.chatId || "");
  const messageId = String(record.messageId || "");
  if (!threadId || !turnId || !chatId || !messageId) {
    throw new TypeError("Stream card record requires thread, turn, chat, and message ids");
  }
  return {
    threadId,
    turnId,
    chatId,
    messageId,
    ...(record.sourceMessageId ? { sourceMessageId: String(record.sourceMessageId) } : {}),
    ...(record.queued ? { queued: { ...record.queued } } : {}),
    ...(normalizeExecutionStatus(record.executionStatus) ? { executionStatus: normalizeExecutionStatus(record.executionStatus) } : {}),
    progress: retainedProgress((Array.isArray(record.progress) ? record.progress : []).map(normalizeProgress)),
    createdAt: Number(record.createdAt) || Date.now(),
  };
}

export class SessionStreamCardStore {
  constructor(filePath, records = []) {
    this.records = new Map(records.map((record) => {
      const normalized = normalizeRecord(record);
      return [recordKey(normalized.threadId, normalized.turnId), normalized];
    }));
    this.writeSnapshot = createSerializedFileWriter(filePath);
  }

  static async open(filePath) {
    const records = await readJsonArrayFile(filePath, "Stream card store");
    return new SessionStreamCardStore(filePath, records);
  }

  get(threadId, turnId) {
    const record = this.records.get(recordKey(threadId, turnId));
    return record ? structuredClone(record) : undefined;
  }

  list() {
    return [...this.records.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => structuredClone(record));
  }

  async start(record) {
    const normalized = normalizeRecord(record);
    const key = recordKey(normalized.threadId, normalized.turnId);
    const existing = this.records.get(key);
    if (existing) return structuredClone(existing);
    this.records.set(key, normalized);
    await this.persist();
    return structuredClone(normalized);
  }

  async appendProgress(threadId, turnId, item) {
    const key = recordKey(threadId, turnId);
    const current = this.records.get(key);
    if (!current) return undefined;
    const progress = normalizeProgress(item);
    if (current.progress.some((entry) => entry.sequence === progress.sequence && entry.text === progress.text)) {
      return structuredClone(current);
    }
    current.progress = retainedProgress([...current.progress, progress]);
    await this.persist();
    return structuredClone(current);
  }

  async handoffQueued(threadId, sourceMessageId, turnId, { startedAtMs = Date.now() } = {}) {
    if (!sourceMessageId || !turnId || String(turnId).startsWith("queued:")) return undefined;
    const existing = this.get(threadId, turnId);
    if (existing) return existing;
    const queuedKey = recordKey(threadId, `queued:${sourceMessageId}`);
    const queued = this.records.get(queuedKey);
    if (!queued) return undefined;
    const active = { ...queued, turnId: String(turnId), createdAt: startedAtMs };
    delete active.queued;
    this.records.delete(queuedKey);
    this.records.set(recordKey(threadId, turnId), active);
    await this.persist();
    return structuredClone(active);
  }

  async updateQueued(threadId, turnId, queued) {
    const current = this.records.get(recordKey(threadId, turnId));
    if (!current || !current.turnId.startsWith("queued:")) return undefined;
    current.queued = { ...queued };
    await this.persist();
    return structuredClone(current);
  }

  async updateExecutionStatus(threadId, turnId, status) {
    const current = this.records.get(recordKey(threadId, turnId));
    if (!current) return undefined;
    const normalized = normalizeExecutionStatus(status);
    if (!normalized) throw new TypeError("Unsupported stream card execution status");
    if (["failed", "interrupted", "completed"].includes(current.executionStatus?.type)) return structuredClone(current);
    if (normalized.type === "running") delete current.executionStatus;
    else current.executionStatus = normalized;
    await this.persist();
    return structuredClone(current);
  }

  async markExecutionStatusUneditable(threadId, turnId) {
    const current = this.records.get(recordKey(threadId, turnId));
    if (!current?.executionStatus) return undefined;
    current.executionStatus.uneditable = true;
    await this.persist();
    return structuredClone(current);
  }

  async remove(threadId, turnId) {
    if (!this.records.delete(recordKey(threadId, turnId))) return false;
    await this.persist();
    return true;
  }

  async persist() {
    const snapshot = JSON.stringify(this.list(), null, 2);
    await this.writeSnapshot(snapshot);
  }
}
