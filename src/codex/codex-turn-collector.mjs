import path from "node:path";
import {
  parseCodexDesktopFilePrompt,
  parseFeishuAttachmentContexts,
  stripFeishuAttachmentContexts,
} from "../feishu/feishu-inbound-attachment.mjs";

function normalizeTimestampMs(value, fallback = Date.now()) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function secondsToMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number * 1000 : fallback;
}

const TOKEN_USAGE_FIELDS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "cacheWriteInputTokens",
  "totalTokens",
]);

function normalizeTokenUsageBreakdown(value) {
  if (!value || typeof value !== "object") return undefined;
  const totalTokens = Number(value.totalTokens);
  if (!Number.isFinite(totalTokens) || totalTokens < 0) return undefined;
  return Object.freeze(Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => {
    const number = Number(value[field] ?? 0);
    return [field, Number.isFinite(number) && number >= 0 ? number : 0];
  })));
}

function subtractTokenUsage(total, baseline) {
  if (!total || !baseline) return undefined;
  return Object.freeze(Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => [
    field,
    Math.max(0, Number(total[field] || 0) - Number(baseline[field] || 0)),
  ])));
}

function boundedText(value, maxChars, suffix) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n${suffix}`;
}

export function parseHeartbeatEnvelope(value) {
  const text = String(value || "").trim();
  const envelope = text.match(/^<heartbeat>\s*([\s\S]*?)\s*<\/heartbeat>$/i);
  if (!envelope) return undefined;
  const message = envelope[1].match(/<message>\s*([\s\S]*?)\s*<\/message>/i);
  if (!message) return undefined;
  const field = (name) => envelope[1].match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*<\\/${name}>`, "i"))?.[1]?.trim();
  return Object.freeze({
    message: message[1].trim(),
    automationId: field("automation_id"),
    decision: field("decision"),
  });
}

export function unwrapHeartbeatEnvelope(value) {
  const text = String(value || "").trim();
  return parseHeartbeatEnvelope(text)?.message ?? text;
}

function heartbeatEnvelopeFromAnswer({ answer, answerSegments }) {
  const source = Array.isArray(answerSegments)
    ? answerSegments
    : [{ type: "text", text: answer }];
  for (const segment of source) {
    if (segment?.type !== "text") continue;
    const heartbeat = parseHeartbeatEnvelope(segment.text);
    if (heartbeat) return heartbeat;
  }
  return undefined;
}

export function heartbeatMetadataText({ answer, answerSegments, heartbeatSchedule }) {
  const heartbeat = heartbeatEnvelopeFromAnswer({ answer, answerSegments });
  if (!heartbeat) return undefined;
  const decisionLabels = {
    DONT_NOTIFY: "无需额外提醒",
    NOTIFY: "需要提醒",
  };
  const details = ["定时任务", "类型：Heartbeat"];
  if (heartbeat.automationId) details.push(`ID：${heartbeat.automationId.slice(0, 100)}`);
  if (heartbeatSchedule) details.push(`间隔：${String(heartbeatSchedule).slice(0, 100)}`);
  if (heartbeat.decision) {
    details.push(`本轮：${decisionLabels[heartbeat.decision] || heartbeat.decision.slice(0, 100)}`);
  }
  return details.join(" · ");
}

function heartbeatMetadataRows(options) {
  const text = heartbeatMetadataText(options);
  if (!text) return [];
  return [
    [{ tag: "hr" }],
    [{ tag: "text", text, style: ["italic"] }],
  ];
}

function answerContentRows({
  answer,
  answerSegments,
  maxReplyChars,
  suffix,
  emptyText,
  quote = false,
}) {
  const source = Array.isArray(answerSegments)
    ? answerSegments
    : [{ type: "text", text: answer }];
  const rows = [];
  let remaining = Math.max(0, Number(maxReplyChars) || 0);
  let truncated = false;

  for (const segment of source) {
    if (truncated) break;
    if (segment?.type === "image" && segment.imageKey) {
      rows.push([{ tag: "img", image_key: String(segment.imageKey) }]);
      continue;
    }
    if (segment?.type !== "text") continue;
    const original = unwrapHeartbeatEnvelope(segment.text);
    if (!original) continue;
    let text = original;
    if (text.length > remaining) {
      text = `${text.slice(0, remaining)}\n\n${suffix}`;
      truncated = true;
    } else {
      remaining -= text.length;
    }
    rows.push([{ tag: "md", text: quote ? quoteMarkdown(text) : text }]);
  }

  if (rows.length === 0) {
    rows.push([{ tag: "md", text: quote ? quoteMarkdown(emptyText) : emptyText }]);
  }
  return rows;
}

function safeResourceName(value, fallback) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (text || fallback).slice(0, 200);
}

function localResourceName(filePath, fallback) {
  return safeResourceName(path.basename(String(filePath || "")), fallback);
}

function remoteResourceName(url, fallback) {
  try { return localResourceName(new URL(String(url)).pathname, fallback); }
  catch { return fallback; }
}

export function stripCodexDesktopFileContext(value) {
  const original = String(value || "").trim();
  return parseCodexDesktopFilePrompt(original)?.text ?? original;
}

export function userPromptDetailsFromItem(item) {
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) {
    return Object.freeze({ text: "", resources: Object.freeze([]) });
  }
  const textParts = [];
  const resourceLabels = [];
  const resources = [];
  const desktopFileEntries = [];
  const contextAttachmentPaths = new Set();
  for (const part of item.content) {
    switch (part?.type) {
      case "text": {
        const partText = String(part.text || "");
        for (const attachment of parseFeishuAttachmentContexts(partText)) {
          if (contextAttachmentPaths.has(attachment.localPath)) continue;
          contextAttachmentPaths.add(attachment.localPath);
          const name = safeResourceName(attachment.name, "未命名附件");
          resources.push(Object.freeze({
            type: "attachment",
            source: "local",
            path: attachment.localPath,
            name,
          }));
          resourceLabels.push(`📎 附件：${name}`);
        }
        const withoutLegacyContext = stripFeishuAttachmentContexts(partText);
        const desktopFilePrompt = parseCodexDesktopFilePrompt(withoutLegacyContext);
        if (desktopFilePrompt) {
          desktopFileEntries.push(...desktopFilePrompt.files);
          textParts.push(desktopFilePrompt.text);
        } else {
          textParts.push(withoutLegacyContext);
        }
        break;
      }
      case "localImage": {
        const name = localResourceName(part.path, "图片");
        resources.push(Object.freeze({ type: "image", source: "local", path: String(part.path || ""), name }));
        break;
      }
      case "image": {
        const name = remoteResourceName(part.url, "图片");
        resources.push(Object.freeze({ type: "image", source: "remote", url: String(part.url || ""), name }));
        break;
      }
      case "localAudio": {
        const name = localResourceName(part.path, "音频");
        resources.push(Object.freeze({ type: "audio", source: "local", path: String(part.path || ""), name }));
        resourceLabels.push(`🔊 音频：${name}`);
        break;
      }
      case "audio": {
        const name = remoteResourceName(part.url, "音频");
        resources.push(Object.freeze({ type: "audio", source: "remote", url: String(part.url || ""), name }));
        resourceLabels.push(`🔊 音频：${name}`);
        break;
      }
      case "skill":
        resourceLabels.push(part.name ? `[Skill：${safeResourceName(part.name, "未命名")}]` : "[Skill]");
        break;
      case "mention": {
        const name = safeResourceName(part.name || path.basename(String(part.path || "")), "未命名附件");
        resources.push(Object.freeze({ type: "attachment", source: "local", path: String(part.path || ""), name }));
        resourceLabels.push(`📎 附件：${name}`);
        break;
      }
      default:
        if (part?.type) resourceLabels.push(`[${part.type}]`);
    }
  }
  for (const file of desktopFileEntries) {
    const location = String(file.path || "");
    const existing = resources.some((resource) =>
      String(resource.path || resource.url || "").toLowerCase() === location.toLowerCase());
    if (existing) continue;
    const name = safeResourceName(file.name, "未命名附件");
    if (/^https?:\/\//i.test(location)) {
      resources.push(Object.freeze({ type: "attachment", source: "remote", url: location, name }));
    } else {
      resources.push(Object.freeze({ type: "attachment", source: "local", path: location, name }));
    }
    resourceLabels.push(`📎 附件：${name}`);
  }
  const promptText = textParts.filter(Boolean).join("\n").trim();
  return Object.freeze({
    text: [promptText, ...resourceLabels].filter(Boolean).join("\n").trim(),
    resources: Object.freeze(resources),
  });
}

export function userPromptFromItem(item) {
  return userPromptDetailsFromItem(item).text;
}

export function quoteMarkdown(value) {
  const text = String(value || "").trim();
  if (!text) return "> （无内容）";
  return text.split(/\r?\n/).map((line) => `> ${line || " "}`).join("\n");
}

export function formatPromptTime(timestampMs, timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(normalizeTimestampMs(timestampMs)));
}

function formatAnswerDuration(durationMs) {
  const milliseconds = Number(durationMs);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "暂不可用";
  if (milliseconds > 0 && milliseconds < 1_000) return "<1秒";
  const totalSeconds = Math.round(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${String(minutes).padStart(2, "0")}分${String(seconds).padStart(2, "0")}秒`;
  if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
  return `${seconds}秒`;
}

function answerMetadataRows({ completedAtMs, durationMs, tokenUsage, timeZone = "Asia/Shanghai" } = {}) {
  if (completedAtMs == null && durationMs == null && tokenUsage == null) return [];
  const timestamp = Number(completedAtMs);
  const answeredAt = Number.isFinite(timestamp) && timestamp > 0
    ? formatPromptTime(timestamp, timeZone)
    : "暂不可用";
  const totalTokens = Number(tokenUsage?.totalTokens);
  const tokenText = Number.isFinite(totalTokens) && totalTokens >= 0
    ? totalTokens.toLocaleString("zh-CN")
    : "暂不可用";
  return [
    [{ tag: "hr" }],
    [{
      tag: "text",
      text: `回答时间：${answeredAt} · 用时：${formatAnswerDuration(durationMs)} · 本轮 Token：${tokenText}`,
      style: ["italic"],
    }],
  ];
}

function finalMentionRows(mentionOpenId) {
  const userId = String(mentionOpenId || "").trim();
  return userId ? [[{ tag: "at", user_id: userId }]] : [];
}

export function buildExternalTurnPost({
  prompt,
  promptEntries = [],
  answer,
  answerSegments,
  uploadedImages = [],
  promptAtMs,
  completedAtMs,
  durationMs,
  tokenUsage,
  timeZone = "Asia/Shanghai",
  maxPromptChars = 4_000,
  maxReplyChars = 10_000,
  heartbeatSchedule,
  hasPromptResources = false,
  mentionOpenId,
}) {
  const entries = Array.isArray(promptEntries) && promptEntries.length > 0
    ? promptEntries
    : [{ text: prompt, uploadedImages, promptAtMs, hasPromptResources }];
  const content = [];
  if (Number(maxPromptChars) > 0) {
    content.push([{ tag: "md", text: "#### 对应 Prompt" }]);
    const showEntryHeadings = entries.length > 1;
    entries.forEach((entry, index) => {
      const entryText = boundedText(
        entry?.text,
        maxPromptChars,
        "（Prompt 过长，已截断；完整内容保留在绑定的 Codex 任务中。）",
      );
      const entryImages = Array.isArray(entry?.uploadedImages)
        ? entry.uploadedImages.filter((image) => image?.imageKey)
        : [];
      if (showEntryHeadings) {
        const sourceLabel = entry?.source === "feishu" ? "飞书" : "Codex";
        content.push([{
          tag: "md",
          text: `${index === 0 ? "##### 初始 Prompt" : `##### 调整方向 ${index}`} · ${sourceLabel}`,
        }]);
      }
      if (entryText) {
        content.push([{ tag: "md", text: quoteMarkdown(entryText) }]);
      } else if (entryImages.length === 0) {
        content.push([{
          tag: "md",
          text: quoteMarkdown(entry?.hasPromptResources ? "（图片未能嵌入）" : "（无文本 Prompt）"),
        }]);
      }
      for (const image of entryImages) {
        content.push([{ tag: "img", image_key: String(image.imageKey) }]);
      }
      const entryTime = Number(entry?.promptAtMs);
      if (Number.isFinite(entryTime) && entryTime > 0) {
        const label = index === 0 ? "发送时间" : "调整时间";
        content.push([{
          tag: "text",
          text: `${label}：${formatPromptTime(entryTime, timeZone)}`,
          style: ["italic"],
        }]);
      }
    });
    if (!entries.some((entry) => Number.isFinite(Number(entry?.promptAtMs)) && Number(entry.promptAtMs) > 0)) {
      content.push([{
        tag: "text",
        text: `发送时间：${formatPromptTime(promptAtMs, timeZone)}`,
        style: ["italic"],
      }]);
    }
    content.push([{ tag: "hr" }]);
  }
  content.push(
    [{ tag: "md", text: "#### 最终回答" }],
    ...finalMentionRows(mentionOpenId),
    ...answerContentRows({
      answer,
      answerSegments,
      maxReplyChars,
      suffix: "（回复过长，已截断；完整内容保留在绑定的 Codex 任务中。）",
      emptyText: "Codex 已完成处理，但没有返回文本结果。",
    }),
  );
  content.push(...answerMetadataRows({ completedAtMs, durationMs, tokenUsage, timeZone }));
  content.push(...heartbeatMetadataRows({ answer, answerSegments, heartbeatSchedule }));
  return {
    zh_cn: {
      title: "Codex 回复",
      content,
    },
  };
}

export function buildFinalAnswerReplyPost({
  answer,
  answerSegments,
  completedAtMs,
  durationMs,
  tokenUsage,
  timeZone = "Asia/Shanghai",
  maxReplyChars = 10_000,
  heartbeatSchedule,
  mentionOpenId,
}) {
  const content = [
    ...finalMentionRows(mentionOpenId),
    ...answerContentRows({
      answer,
      answerSegments,
      maxReplyChars,
      suffix: "（回复过长，已截断；完整内容保留在绑定的 Codex 任务中。）",
      emptyText: "Codex 已完成处理，但没有返回文本结果。",
    }),
  ];
  content.push(...answerMetadataRows({ completedAtMs, durationMs, tokenUsage, timeZone }));
  content.push(...heartbeatMetadataRows({ answer, answerSegments, heartbeatSchedule }));
  return {
    zh_cn: {
      content,
    },
  };
}

export function buildSessionProgressPost({
  text,
  sequence,
  createdAtMs,
  timeZone = "Asia/Shanghai",
  maxChars = 4_000,
} = {}) {
  const progress = boundedText(
    text,
    maxChars,
    "（公开进度过长，已截断；最终结果仍会在回答完成后发送。）",
  ) || "Codex 正在处理。";
  const progressSequence = Number(sequence);
  const title = Number.isSafeInteger(progressSequence) && progressSequence > 0
    ? `Codex 公开进度 #${progressSequence}`
    : "Codex 公开进度";
  return {
    zh_cn: {
      title,
      content: [
        [{ tag: "md", text: progress }],
        [{
          tag: "text",
          text: formatPromptTime(createdAtMs || Date.now(), timeZone),
          style: ["italic"],
        }],
      ],
    },
  };
}

export function buildGoalTurnPost({
  goal,
  answer,
  answerSegments,
  completedAtMs,
  durationMs,
  tokenUsage,
  timeZone = "Asia/Shanghai",
  maxReplyChars = 10_000,
  heartbeatSchedule,
  mentionOpenId,
}) {
  const statusLabels = {
    active: "运行中",
    paused: "已暂停",
    blocked: "需要处理阻塞",
    usageLimited: "用量受限",
    budgetLimited: "预算已用尽",
    complete: "已完成",
  };
  const objective = String(goal?.objective || "（Goal 自动续跑）");
  const status = statusLabels[goal?.status] || String(goal?.status || "状态待同步");
  const budget = goal?.tokenBudget == null ? "不限" : Number(goal.tokenBudget).toLocaleString("zh-CN");
  const used = Number(goal?.tokensUsed || 0).toLocaleString("zh-CN");
  const content = [
        [{ tag: "md", text: "#### Goal" }],
        [{ tag: "md", text: quoteMarkdown(objective) }],
        [{ tag: "text", text: `状态：${status} · Token：${used} / ${budget}`, style: ["italic"] }],
        [{ tag: "hr" }],
        [{ tag: "md", text: goal?.status === "complete" ? "#### 最终结果" : "#### 本轮结果" }],
        ...finalMentionRows(mentionOpenId),
        ...answerContentRows({
          answer,
          answerSegments,
          maxReplyChars,
          suffix: "（本轮结果过长，已截断；完整内容保留在绑定的 Codex 任务中。）",
          emptyText: "Codex 已完成本轮 Goal 处理，但没有返回文本结果。",
        }),
      ];
  content.push(...answerMetadataRows({ completedAtMs, durationMs, tokenUsage, timeZone }));
  content.push(...heartbeatMetadataRows({ answer, answerSegments, heartbeatSchedule }));
  return {
    zh_cn: {
      title: goal?.status === "complete" ? "Codex Goal 已完成" : "Codex Goal 进展",
      content,
    },
  };
}

export function externalTurnDeliveryId(threadId, turnId) {
  return `codex-turn:${String(threadId)}:${String(turnId)}`;
}

function defaultFeishuClientId(clientId) {
  return typeof clientId === "string" && /^om_[A-Za-z0-9_-]+$/.test(clientId);
}

export function promptInputSource(clientId, isFeishuClientId = defaultFeishuClientId) {
  return isFeishuClientId(clientId) ? "feishu" : "codex";
}

function userMessageItemKey(item) {
  return item?.id != null
    ? `id:${String(item.id)}`
    : `content:${String(item?.clientId || "")}:${JSON.stringify(item?.content || [])}`;
}

function progressItemKey(item) {
  const text = String(item?.text || "").trim();
  return item?.id == null ? `text:${text}` : `id:${String(item.id)}`;
}

function turnKey(threadId, turnId) {
  return `${threadId}:${turnId}`;
}

export class CodexTurnCollector {
  constructor({
    targets,
    onExternalTurn,
    onTurnCompleted,
    onTurnProgress,
    isFeishuClientId = defaultFeishuClientId,
    onError = () => {},
  }) {
    this.targets = new Map((targets || []).map((target) => [target.threadId, Object.freeze({ ...target })]));
    this.onExternalTurn = onExternalTurn;
    this.onTurnCompleted = onTurnCompleted;
    this.onTurnProgress = onTurnProgress;
    this.isFeishuClientId = isFeishuClientId;
    this.onError = onError;
    this.turns = new Map();
    this.threadUsageTotals = new Map();
    this.emitted = new Set();
    this.emittedProgress = new Set();
  }

  addTarget(target) {
    const threadId = String(target?.threadId || "");
    if (!threadId) throw new TypeError("Turn collector target requires threadId");
    if (this.targets.has(threadId)) return false;
    this.targets.set(threadId, Object.freeze({ ...target, threadId }));
    return true;
  }

  removeTarget(threadId) {
    const key = String(threadId || "");
    if (!this.targets.delete(key)) return false;
    for (const [turnId, state] of this.turns) {
      if (state.threadId === key) this.turns.delete(turnId);
    }
    this.threadUsageTotals.delete(key);
    return true;
  }

  #state(threadId, turnId, { create = true } = {}) {
    if (!this.targets.has(threadId) || !turnId) return undefined;
    const key = turnKey(threadId, turnId);
    let state = this.turns.get(key);
    if (!state && create) {
      state = {
        key,
        threadId,
        turnId,
        startedAtMs: undefined,
        completedAtMs: undefined,
        durationMs: undefined,
        observedStart: false,
        usageBaseline: this.threadUsageTotals.get(threadId),
        tokenUsage: undefined,
        promptEntries: [],
        promptEntriesByKey: new Map(),
        clientId: undefined,
        finalAnswer: "",
        planAnswer: "",
        unphasedAnswer: "",
        progressSequence: 0,
        progressItemSequences: new Map(),
      };
      this.turns.set(key, state);
    }
    return state;
  }

  #collectItem(state, item, completedAtMs) {
    if (!state || !item) return;
    if (item.type === "userMessage") {
      const prompt = userPromptDetailsFromItem(item);
      if (!prompt.text && prompt.resources.length === 0) return;
      const itemKey = userMessageItemKey(item);
      const existing = state.promptEntriesByKey.get(itemKey);
      if (existing) {
        if (!existing.promptAtMs && completedAtMs) {
          existing.promptAtMs = normalizeTimestampMs(completedAtMs);
        }
        return;
      }
      const entry = {
        itemKey,
        text: prompt.text,
        resources: [...prompt.resources],
        promptAtMs: completedAtMs ? normalizeTimestampMs(completedAtMs) : undefined,
        clientId: item.clientId == null ? undefined : String(item.clientId),
      };
      state.promptEntries.push(entry);
      state.promptEntriesByKey.set(itemKey, entry);
      if (state.promptEntries.length === 1 && item.clientId != null) {
        state.clientId = String(item.clientId);
      }
      return;
    }
    if (item.type === "plan") {
      const text = String(item.text || "").trim();
      if (text) state.planAnswer = text;
      return;
    }
    if (item.type !== "agentMessage") return;
    const text = String(item.text || "").trim();
    if (!text) return;
    if (item.phase === "commentary") {
      const itemKey = progressItemKey(item);
      if (!state.progressItemSequences.has(itemKey)) {
        state.progressSequence += 1;
        state.progressItemSequences.set(itemKey, state.progressSequence);
      }
    } else if (item.phase === "final_answer") state.finalAnswer = text;
    else if (item.phase == null) state.unphasedAnswer = text;
  }

  #collectTurn(state, turn) {
    if (!state || !turn) return;
    state.startedAtMs = secondsToMs(turn.startedAt, state.startedAtMs);
    state.completedAtMs = secondsToMs(turn.completedAt, state.completedAtMs);
    const explicitDurationMs = Number(turn.durationMs);
    if (Number.isFinite(explicitDurationMs) && explicitDurationMs >= 0) {
      state.durationMs = explicitDurationMs;
    } else if (state.startedAtMs && state.completedAtMs) {
      state.durationMs = Math.max(0, state.completedAtMs - state.startedAtMs);
    }
    const canonicalPromptKeys = [];
    for (const item of turn.items || []) {
      this.#collectItem(state, item);
      if (item?.type !== "userMessage") continue;
      const itemKey = userMessageItemKey(item);
      if (state.promptEntriesByKey.has(itemKey)) canonicalPromptKeys.push(itemKey);
    }
    if (
      canonicalPromptKeys.length === state.promptEntries.length &&
      new Set(canonicalPromptKeys).size === state.promptEntries.length
    ) {
      state.promptEntries = canonicalPromptKeys.map((itemKey) => state.promptEntriesByKey.get(itemKey));
    }
    if (state.promptEntries[0] && !state.promptEntries[0].promptAtMs && state.startedAtMs) {
      state.promptEntries[0].promptAtMs = state.startedAtMs;
    }
  }

  #collectTokenUsage(state, tokenUsage) {
    if (!state) return;
    const total = normalizeTokenUsageBreakdown(tokenUsage?.total);
    const last = normalizeTokenUsageBreakdown(tokenUsage?.last);
    if (!total) return;
    if (!state.observedStart) {
      this.threadUsageTotals.set(state.threadId, total);
      return;
    }
    let baseline = state.usageBaseline;
    if (!baseline || Number(baseline.totalTokens) > Number(total.totalTokens)) {
      baseline = last ? subtractTokenUsage(total, last) : undefined;
      state.usageBaseline = baseline;
    }
    state.tokenUsage = baseline ? subtractTokenUsage(total, baseline) : last;
    this.threadUsageTotals.set(state.threadId, total);
  }

  #emitProgress(state, item, completedAtMs) {
    if (!state || item?.type !== "agentMessage" || item.phase !== "commentary") return;
    const text = String(item.text || "").trim();
    if (!text || typeof this.onTurnProgress !== "function") return;
    const itemKey = progressItemKey(item);
    const key = `${state.key}:${itemKey}`;
    if (this.emittedProgress.has(key)) return;
    this.emittedProgress.add(key);
    if (this.emittedProgress.size > 10_000) {
      this.emittedProgress = new Set([...this.emittedProgress].slice(-8_000));
    }
    const target = this.targets.get(state.threadId);
    const sequence = state.progressItemSequences.get(itemKey);
    const record = Object.freeze({
      threadId: state.threadId,
      turnId: state.turnId,
      chatId: target.chatId,
      itemId: item.id == null ? itemKey : String(item.id),
      sequence,
      text,
      createdAtMs: completedAtMs ? normalizeTimestampMs(completedAtMs) : Date.now(),
    });
    Promise.resolve(this.onTurnProgress(record)).catch((error) => this.onError(error));
  }

  #finalize(state, turn) {
    if (!state) return;
    this.#collectTurn(state, turn);
    this.turns.delete(state.key);
    if (turn?.status !== "completed" || this.emitted.has(state.key)) return;
    this.emitted.add(state.key);
    if (this.emitted.size > 10_000) this.emitted = new Set([...this.emitted].slice(-8_000));
    const answer = state.finalAnswer || state.planAnswer || state.unphasedAnswer;
    if (!answer) return;
    const target = this.targets.get(state.threadId);
    const promptEntries = Object.freeze(state.promptEntries.map((entry, index) => Object.freeze({
      sequence: index + 1,
      kind: index === 0 ? "initial" : "steer",
      source: promptInputSource(entry.clientId, this.isFeishuClientId),
      text: entry.text,
      resources: Object.freeze(entry.resources.map((resource) => Object.freeze({ ...resource }))),
      promptAtMs: entry.promptAtMs,
      clientId: entry.clientId,
    })));
    const initialPrompt = promptEntries[0];
    const record = Object.freeze({
      threadId: state.threadId,
      turnId: state.turnId,
      chatId: target.chatId,
      prompt: initialPrompt?.text || "",
      promptResources: Object.freeze(promptEntries.flatMap((entry) => entry.resources)),
      promptAtMs: initialPrompt?.promptAtMs || state.startedAtMs || Date.now(),
      promptEntries,
      answer,
      clientId: initialPrompt?.clientId,
      completedAtMs: state.completedAtMs || Date.now(),
      durationMs: state.durationMs,
      tokenUsage: state.tokenUsage,
    });
    if (typeof this.onTurnCompleted === "function") {
      Promise.resolve(this.onTurnCompleted(record)).catch((error) => this.onError(error));
    }
    if (
      !promptEntries.some((entry) => entry.source === "feishu") &&
      promptEntries.length > 0 &&
      typeof this.onExternalTurn === "function"
    ) {
      Promise.resolve(this.onExternalTurn(record)).catch((error) => this.onError(error));
    }
  }

  seedThread(thread, { catchUpAfterMs } = {}) {
    if (!thread?.id || !this.targets.has(thread.id)) return;
    for (const turn of thread.turns || []) {
      if (!turn?.id) continue;
      const isActive = turn.status === "inProgress";
      const completedAtMs = secondsToMs(turn.completedAt);
      const isReconnectCatchUp = turn.status === "completed" && catchUpAfterMs != null &&
        completedAtMs >= catchUpAfterMs;
      if (!isActive && !isReconnectCatchUp) continue;
      const state = this.#state(thread.id, turn.id);
      this.#collectTurn(state, turn);
      if (isReconnectCatchUp) this.#finalize(state, turn);
    }
  }

  handleNotification(method, params = {}) {
    const threadId = params.threadId;
    if (!this.targets.has(threadId)) return;
    if (method === "turn/started") {
      const turn = params.turn;
      const state = this.#state(threadId, turn?.id);
      if (state) state.observedStart = true;
      this.#collectTurn(state, turn);
      return;
    }
    if (method === "item/completed") {
      const state = this.#state(threadId, params.turnId);
      this.#collectItem(state, params.item, params.completedAtMs);
      this.#emitProgress(state, params.item, params.completedAtMs);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const state = this.#state(threadId, params.turnId);
      this.#collectTokenUsage(state, params.tokenUsage);
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn;
      const state = this.#state(threadId, turn?.id);
      this.#finalize(state, turn);
    }
  }
}
