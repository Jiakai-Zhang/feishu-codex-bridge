import { createSerializedFileWriter, readJsonArrayFile } from "./serialized-json-file.mjs";

const MAX_PROCESSED_TURNS = 2_000;
const MAX_PENDING_CONTENT_CHARS = 12_000;

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function normalizePending(entry) {
  return {
    turnKey: requiredText(entry?.turnKey, "pending.turnKey"),
    content: requiredText(entry?.content, "pending.content").slice(0, MAX_PENDING_CONTENT_CHARS),
    completedAtMs: Number(entry?.completedAtMs) || Date.now(),
  };
}

function normalizeRecord(record) {
  const pending = Array.isArray(record?.pending) ? record.pending.map(normalizePending) : [];
  const processedTurnKeys = Array.isArray(record?.processedTurnKeys)
    ? record.processedTurnKeys.filter((value) => typeof value === "string" && value).slice(-MAX_PROCESSED_TURNS)
    : [];
  return {
    groupChatId: requiredText(record?.groupChatId, "groupChatId"),
    threadId: requiredText(record?.threadId, "threadId"),
    documentUrl: requiredText(record?.documentUrl, "documentUrl"),
    tabId: record?.tabId ? String(record.tabId) : undefined,
    tabLastErrorCode: record?.tabLastErrorCode ? String(record.tabLastErrorCode) : undefined,
    summary: String(record?.summary || "").trim(),
    pending,
    processedTurnKeys,
    createdAt: Number(record?.createdAt) || Date.now(),
    updatedAt: Number(record?.updatedAt) || Date.now(),
    lastSyncedAt: Number(record?.lastSyncedAt) || undefined,
    lastErrorCode: record?.lastErrorCode ? String(record.lastErrorCode) : undefined,
  };
}

export class SessionSummaryDocumentStore {
  constructor(filePath, records = []) {
    this.records = new Map();
    for (const value of records) {
      const record = normalizeRecord(value);
      if (this.records.has(record.groupChatId)) throw new TypeError("Summary document store has duplicate groups");
      this.records.set(record.groupChatId, record);
    }
    this.writeSnapshot = createSerializedFileWriter(requiredText(filePath, "filePath"));
  }

  static async open(filePath) {
    const records = await readJsonArrayFile(filePath, "Session summary document store");
    return new SessionSummaryDocumentStore(filePath, records);
  }

  list() {
    return [...this.records.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => structuredClone(record));
  }

  get(groupChatId) {
    const record = this.records.get(String(groupChatId || ""));
    return record ? structuredClone(record) : undefined;
  }

  async link({ groupChatId, threadId, documentUrl }) {
    const key = requiredText(groupChatId, "groupChatId");
    if (this.records.has(key)) {
      const error = new Error("The group already has a summary document");
      error.code = "summary_document_already_linked";
      throw error;
    }
    const record = normalizeRecord({ groupChatId: key, threadId, documentUrl, createdAt: Date.now() });
    this.records.set(key, record);
    await this.persist();
    return structuredClone(record);
  }

  async setTab(groupChatId, tabId) {
    const record = this.records.get(String(groupChatId || ""));
    if (!record) return undefined;
    record.tabId = requiredText(tabId, "tabId");
    record.tabLastErrorCode = undefined;
    record.updatedAt = Date.now();
    await this.persist();
    return structuredClone(record);
  }

  async markTabFailure(groupChatId, errorCode) {
    const record = this.records.get(String(groupChatId || ""));
    if (!record) return false;
    record.tabLastErrorCode = String(errorCode || "summary_tab_api_error");
    record.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  async unlink(groupChatId) {
    const key = String(groupChatId || "");
    const existing = this.records.get(key);
    if (!existing) return undefined;
    this.records.delete(key);
    await this.persist();
    return structuredClone(existing);
  }

  async appendTurn({ groupChatId, threadId, turnId, content, completedAtMs }) {
    const record = this.records.get(String(groupChatId || ""));
    if (!record) return false;
    const turnKey = `${requiredText(threadId, "threadId")}:${requiredText(turnId, "turnId")}`;
    if (
      record.processedTurnKeys.includes(turnKey)
      || record.pending.some((entry) => entry.turnKey === turnKey)
    ) return false;
    record.pending.push(normalizePending({ turnKey, content, completedAtMs }));
    record.updatedAt = Date.now();
    record.lastErrorCode = undefined;
    await this.persist();
    return true;
  }

  selectBatch(groupChatId, { maxChars = 24_000 } = {}) {
    const record = this.records.get(String(groupChatId || ""));
    if (!record || record.pending.length === 0) return undefined;
    const selected = [];
    let used = 0;
    for (const entry of record.pending) {
      if (selected.length > 0 && used + entry.content.length > maxChars) break;
      selected.push(structuredClone(entry));
      used += entry.content.length;
    }
    return Object.freeze({
      groupChatId: record.groupChatId,
      documentUrl: record.documentUrl,
      previousSummary: record.summary,
      entries: Object.freeze(selected),
    });
  }

  async commitBatch(groupChatId, turnKeys, summary, syncedAt = Date.now()) {
    const record = this.records.get(String(groupChatId || ""));
    if (!record) return undefined;
    const committed = new Set(turnKeys);
    record.pending = record.pending.filter((entry) => !committed.has(entry.turnKey));
    record.processedTurnKeys = [
      ...record.processedTurnKeys,
      ...turnKeys.filter((key) => !record.processedTurnKeys.includes(key)),
    ].slice(-MAX_PROCESSED_TURNS);
    record.summary = requiredText(summary, "summary");
    record.lastSyncedAt = Number(syncedAt) || Date.now();
    record.updatedAt = Date.now();
    record.lastErrorCode = undefined;
    await this.persist();
    return structuredClone(record);
  }

  async markFailure(groupChatId, errorCode) {
    const record = this.records.get(String(groupChatId || ""));
    if (!record) return false;
    record.lastErrorCode = String(errorCode || "summary_update_failed");
    record.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  async persist() {
    await this.writeSnapshot(JSON.stringify(this.list(), null, 2));
  }
}
