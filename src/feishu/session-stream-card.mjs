import { createSerializedFileWriter, readJsonArrayFile } from "../persistence/serialized-json-file.mjs";
import { buildNativeAttachmentDeliveries } from "./feishu-native-attachment.mjs";

const MAX_STORED_PROGRESS = 12;

function buildCompletionNotice(baseRecord, mentionOpenId) {
  const userId = String(mentionOpenId || "").trim();
  if (!userId) return undefined;
  return Object.freeze({
    ...baseRecord,
    post: {
      zh_cn: {
        content: [[
          { tag: "at", user_id: userId },
          { tag: "text", text: " 已完成" },
        ]],
      },
    },
  });
}

export function buildSessionStreamCardFollowups(baseRecord, attachments, { mentionOpenId } = {}) {
  const completionNotice = buildCompletionNotice(baseRecord, mentionOpenId);
  return Object.freeze([
    ...(completionNotice ? [completionNotice] : []),
    ...buildNativeAttachmentDeliveries(baseRecord, attachments),
  ]);
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
    const text = String(segment.text || "").trim();
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
  startedAtMs,
  nowMs = Date.now(),
  answer,
  answerSegments,
  completedAtMs,
  durationMs,
  tokenUsage,
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
    summarySource = answer || answerSegments?.find((segment) => segment?.type === "text")?.text || "Codex 回复完成";
  } else if (queued) {
    const position = Math.max(1, Number(queued.position) || 1);
    const cancelled = queued.status === "cancelled";
    elements = [{
      tag: "markdown",
      content: cancelled
        ? `**已从下一轮队列移除**\n\n${String(queued.reason || "这条 Prompt 不会再自动开始。")}`
        : [
            `**${queued.alreadyQueued ? "已在下一轮队列中" : "已按默认设置加入下一轮队列"}**`,
            "",
            `- 当前排位：**${position}**`,
            "- 执行方式：任务空闲后作为独立的新 Turn 开始",
            "",
            "*如需改为调整方向，请先使用 `/settings input steer`。*",
          ].join("\n"),
    }];
    summarySource = cancelled ? "已从下一轮队列移除" : `排队中 · 当前排位 ${position}`;
  } else {
    const elapsedMs = Number.isFinite(Number(startedAtMs))
      ? Math.max(0, Number(nowMs) - Number(startedAtMs))
      : undefined;
    const elapsedText = elapsedMs === undefined
      ? ""
      : ` · 已处理：${formatDuration(elapsedMs)}`;
    const items = [...progress]
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
      content: `**Codex 正在处理${elapsedText}**\n\n${progressMarkdown}\n\n*这里只展示公开进度，不包含隐藏思考过程。*`,
    }];
    summarySource = items.at(-1)?.text || "Codex 正在处理";
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
    sequence: Math.max(0, Number(item?.sequence) || 0),
    text: String(item?.text || "").slice(0, 4_000),
    createdAtMs: Number(item?.createdAtMs) || Date.now(),
  };
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
    progress: (Array.isArray(record.progress) ? record.progress : [])
      .map(normalizeProgress)
      .slice(-MAX_STORED_PROGRESS),
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
    current.progress = [...current.progress, progress]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_STORED_PROGRESS);
    await this.persist();
    return structuredClone(current);
  }

  async reassign(threadId, fromTurnId, toTurnId, { createdAt = Date.now() } = {}) {
    const sourceKey = recordKey(threadId, fromTurnId);
    const targetKey = recordKey(threadId, toTurnId);
    const target = this.records.get(targetKey);
    if (target) return structuredClone(target);
    const source = this.records.get(sourceKey);
    if (!source) return undefined;
    const reassigned = normalizeRecord({
      ...source,
      turnId: toTurnId,
      progress: [],
      createdAt,
    });
    this.records.delete(sourceKey);
    this.records.set(targetKey, reassigned);
    try {
      await this.persist();
    } catch (error) {
      this.records.delete(targetKey);
      this.records.set(sourceKey, source);
      throw error;
    }
    return structuredClone(reassigned);
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
