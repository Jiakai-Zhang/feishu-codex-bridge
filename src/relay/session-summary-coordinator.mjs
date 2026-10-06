const DEFAULT_DEBOUNCE_MS = 60_000;
const DEFAULT_RETRY_MS = 5 * 60_000;
const PASSIVE_CONTEXT_EXCLUDED_RESOURCE_TYPES = new Set(["image", "video", "media"]);

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function summaryError(code, message, options = {}) {
  const error = new Error(message, options);
  error.name = "SessionSummaryCoordinatorError";
  error.code = code;
  return error;
}

function compact(value, maxChars) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 16))}\n[内容已截断]`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPassiveMediaMarkers(value, resources) {
  let text = String(value || "");
  for (const resource of resources) {
    const fileKey = String(resource?.fileKey || "").trim();
    if (!fileKey) continue;
    const key = escapeRegExp(fileKey);
    text = text
      .replace(new RegExp(`!\\[[^\\]]*\\]\\(${key}\\)`, "g"), "")
      .replace(new RegExp(`<(?:image|video|media)\\b[^>]*\\bkey=(?:"${key}"|'${key}')[^>]*/?>`, "gi"), "");
  }
  if (resources.length > 0) {
    text = text
      .replace(/!\[[^\]]*\]\([^\r\n)]*\)/g, "")
      .replace(/<(?:image|video|media)\b[^>]*\/?>/gi, "");
  }
  return text
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizePassiveGroupMessage(record) {
  const resources = Array.isArray(record?.resources) ? record.resources : [];
  const excludedResources = resources.filter((resource) => (
    PASSIVE_CONTEXT_EXCLUDED_RESOURCE_TYPES.has(String(resource?.type || "").trim().toLowerCase())
  ));
  const retainedResources = resources.filter((resource) => !excludedResources.includes(resource));
  const contentType = String(record?.contentType || "").trim().toLowerCase();
  const content = PASSIVE_CONTEXT_EXCLUDED_RESOURCE_TYPES.has(contentType)
    ? ""
    : stripPassiveMediaMarkers(record?.content, excludedResources);
  if (!content && retainedResources.length === 0) return undefined;
  return Object.freeze({
    ...record,
    content,
    resources: Object.freeze([...retainedResources]),
  });
}

export function buildCompletedTurnSummaryDelta(record, { maxChars = 12_000 } = {}) {
  const limit = Math.max(1_000, Number(maxChars) || 12_000);
  const promptBudget = Math.max(400, Math.floor(limit * 0.4));
  const answerBudget = Math.max(500, limit - promptBudget - 20);
  const entries = Array.isArray(record?.promptEntries) ? record.promptEntries : [];
  const lines = [];
  for (const [index, entry] of entries.entries()) {
    const label = index === 0 ? "用户" : "用户补充";
    const text = String(entry?.text || "").trim();
    const resourceCount = Array.isArray(entry?.resources) ? entry.resources.length : 0;
    lines.push(`${label}：${text || (resourceCount > 0 ? `发送了 ${resourceCount} 个图片或附件` : "（空）")}`);
  }
  const prompts = compact(lines.join("\n\n"), promptBudget);
  const answer = compact(requiredText(record?.answer, "answer"), answerBudget);
  return compact(`${prompts}\n\n助手：${answer}`, limit);
}

export function buildPassiveGroupMessageSummaryDelta(record, { maxChars = 12_000 } = {}) {
  const passiveRecord = sanitizePassiveGroupMessage(record);
  if (!passiveRecord) return "";
  const limit = Math.max(1_000, Number(maxChars) || 12_000);
  const content = String(passiveRecord.content || "").trim();
  const resources = passiveRecord.resources;
  const resourceTypes = resources
    .map((resource) => String(resource?.type || "附件").trim() || "附件")
    .slice(0, 10);
  const parts = [];
  if (content) parts.push(content);
  if (resourceTypes.length > 0) parts.push(`（包含 ${resourceTypes.length} 个资源：${resourceTypes.join("、")}）`);
  const body = parts.join("\n") || `（${String(record?.contentType || "消息").trim() || "消息"}，无可提取文字）`;
  return compact(`群聊记录（未请求 Bot 回答）：\n群成员：${body}`, limit);
}

export class SessionSummaryCoordinator {
  constructor({
    store,
    documentManager,
    tabManager,
    summarizer,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    retryMs = DEFAULT_RETRY_MS,
    maxBatchChars = 24_000,
    log = () => {},
  } = {}) {
    if (!store || !documentManager || !summarizer) {
      throw new TypeError("Summary coordinator requires store, documentManager, and summarizer");
    }
    this.store = store;
    this.documentManager = documentManager;
    this.tabManager = tabManager;
    this.summarizer = summarizer;
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.retryMs = Math.max(1_000, Number(retryMs) || DEFAULT_RETRY_MS);
    this.maxBatchChars = Math.max(1_000, Number(maxBatchChars) || 24_000);
    this.log = log;
    this.timers = new Map();
    this.tabTimers = new Map();
    this.tabInFlight = new Map();
    this.inFlight = new Map();
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    for (const record of this.store.list()) {
      if (record.pending.length > 0) this.schedule(record.groupChatId, 0);
      if (this.tabManager) this.scheduleTab(record.groupChatId, 0);
    }
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.tabTimers.values()) clearTimeout(timer);
    this.tabTimers.clear();
  }

  status(groupChatId) {
    return this.store.get(groupChatId);
  }

  async create({ groupChatId, threadId, title }) {
    if (this.store.get(groupChatId)) {
      throw summaryError("summary_document_already_linked", "The group already has a summary document");
    }
    const document = await this.documentManager.create({
      title: `${requiredText(title, "title")} · 项目档案`,
    });
    await this.store.link({
      groupChatId,
      threadId,
      documentUrl: document.url,
    });
    await this.#ensureTabAfterLink(groupChatId);
    return this.store.get(groupChatId);
  }

  async bind({ groupChatId, threadId, url }) {
    if (this.store.get(groupChatId)) {
      throw summaryError("summary_document_already_linked", "The group already has a summary document");
    }
    const document = await this.documentManager.bind({ url });
    await this.store.link({
      groupChatId,
      threadId,
      documentUrl: document.url,
    });
    await this.#ensureTabAfterLink(groupChatId);
    return this.store.get(groupChatId);
  }

  async unbind(groupChatId) {
    const key = String(groupChatId || "");
    await this.#settleActiveWork(key);
    const existing = this.store.get(key);
    if (existing && this.tabManager) {
      await this.tabManager.remove({
        chatId: existing.groupChatId,
        documentUrl: existing.documentUrl,
        tabId: existing.tabId,
      });
    }
    const removed = await this.store.unlink(key);
    if (!removed) throw summaryError("summary_document_not_linked", "The group has no summary document");
    this.#clearScheduledWork(key);
    return removed;
  }

  async discard(groupChatId) {
    const key = String(groupChatId || "");
    await this.#settleActiveWork(key);
    const existing = this.store.get(key);
    if (!existing) return undefined;
    if (this.tabManager) {
      try {
        await this.tabManager.remove({
          chatId: existing.groupChatId,
          documentUrl: existing.documentUrl,
          tabId: existing.tabId,
        });
      } catch (error) {
        this.log(`summary document tab cleanup skipped during Session deletion: ${String(error?.code || error?.name || "unknown")}`);
      }
    }
    const removed = await this.store.unlink(key);
    this.#clearScheduledWork(key);
    return removed;
  }

  #clearScheduledWork(key) {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    const tabTimer = this.tabTimers.get(key);
    if (tabTimer) clearTimeout(tabTimer);
    this.tabTimers.delete(key);
  }

  async #settleActiveWork(key) {
    this.#clearScheduledWork(key);
    try { await this.inFlight.get(key); } catch {}
    try { await this.tabInFlight.get(key); } catch {}
    this.#clearScheduledWork(key);
  }

  async #ensureTabAfterLink(groupChatId) {
    if (!this.tabManager) return;
    try {
      await this.ensureTabNow(groupChatId);
    } catch (error) {
      this.log(`summary document tab pin deferred: ${String(error?.code || error?.name || "unknown")}`);
    }
  }

  scheduleTab(groupChatId, delayMs = this.retryMs) {
    const key = String(groupChatId || "");
    if (this.stopped || !this.tabManager || !key || this.tabTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.tabTimers.delete(key);
      void this.ensureTabNow(key).catch((error) => {
        this.log(`summary document tab pin deferred: ${String(error?.code || error?.name || "unknown")}`);
      });
    }, Math.max(0, Number(delayMs) || 0));
    timer.unref?.();
    this.tabTimers.set(key, timer);
  }

  ensureTabNow(groupChatId) {
    const key = String(groupChatId || "");
    const existing = this.tabInFlight.get(key);
    if (existing) return existing;
    const running = this.#ensureTab(key).finally(() => {
      if (this.tabInFlight.get(key) === running) this.tabInFlight.delete(key);
    });
    this.tabInFlight.set(key, running);
    return running;
  }

  async #ensureTab(groupChatId) {
    const record = this.store.get(groupChatId);
    if (!record || !this.tabManager) return record;
    const timer = this.tabTimers.get(record.groupChatId);
    if (timer) clearTimeout(timer);
    this.tabTimers.delete(record.groupChatId);
    try {
      const result = await this.tabManager.ensure({
        chatId: record.groupChatId,
        documentUrl: record.documentUrl,
        tabName: "项目档案",
      });
      return this.store.setTab(record.groupChatId, result.tabId);
    } catch (error) {
      await this.store.markTabFailure(record.groupChatId, error?.code);
      this.scheduleTab(record.groupChatId, this.retryMs);
      throw error;
    }
  }

  async recordTurn(record) {
    if (!this.store.get(record?.chatId)) return false;
    const appended = await this.store.appendTurn({
      groupChatId: record.chatId,
      threadId: record.threadId,
      turnId: record.turnId,
      content: buildCompletedTurnSummaryDelta(record),
      completedAtMs: record.completedAtMs,
    });
    if (appended) this.schedule(record.chatId, this.debounceMs);
    return appended;
  }

  async recordGroupMessage(record) {
    if (!this.store.get(record?.groupChatId)) return false;
    const passiveRecord = sanitizePassiveGroupMessage(record);
    if (!passiveRecord) return false;
    const appended = await this.store.appendTurn({
      groupChatId: passiveRecord.groupChatId,
      threadId: passiveRecord.threadId,
      turnId: `message:${requiredText(passiveRecord.messageId, "messageId")}`,
      content: buildPassiveGroupMessageSummaryDelta(passiveRecord),
      completedAtMs: passiveRecord.receivedAtMs,
    });
    if (appended) this.schedule(passiveRecord.groupChatId, this.debounceMs);
    return appended;
  }

  schedule(groupChatId, delayMs = this.debounceMs) {
    const key = String(groupChatId || "");
    if (this.stopped || !key || this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.syncNow(key).catch((error) => {
        this.log(`rolling summary update deferred: ${String(error?.code || error?.name || "unknown")}`);
      });
    }, Math.max(0, Number(delayMs) || 0));
    timer.unref?.();
    this.timers.set(key, timer);
  }

  syncNow(groupChatId) {
    const key = String(groupChatId || "");
    if (!this.store.get(key)) {
      throw summaryError("summary_document_not_linked", "The group has no summary document");
    }
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const running = this.#drain(key).finally(() => {
      if (this.inFlight.get(key) === running) this.inFlight.delete(key);
    });
    this.inFlight.set(key, running);
    return running;
  }

  async #drain(groupChatId) {
    try {
      for (;;) {
        const batch = this.store.selectBatch(groupChatId, { maxChars: this.maxBatchChars });
        if (!batch) return this.store.get(groupChatId);
        const newContent = batch.entries
          .map((entry, index) => `【新增回合 ${index + 1}】\n${entry.content}`)
          .join("\n\n");
        const summary = await this.summarizer.summarize({
          previousSummary: batch.previousSummary,
          newContent,
        });
        await this.documentManager.update({
          url: batch.documentUrl,
          summary,
        });
        await this.store.commitBatch(
          groupChatId,
          batch.entries.map((entry) => entry.turnKey),
          summary,
        );
      }
    } catch (error) {
      await this.store.markFailure(groupChatId, error?.code);
      this.schedule(groupChatId, this.retryMs);
      throw error;
    }
  }
}
