import { createSerializedFileWriter, readJsonArrayFile } from "./serialized-json-file.mjs";

function normalizeRecord(record) {
  if (!record || typeof record !== "object") throw new TypeError("Temporary Chat record must be an object");
  const conversationId = String(record.conversationId || "");
  const threadId = String(record.threadId || "");
  const cwd = String(record.cwd || "");
  const chatType = record.chatType === "group" ? "group" : "p2p";
  const status = record.status === "ended" ? "ended" : "active";
  if (!conversationId || !threadId || !cwd) {
    throw new TypeError("Temporary Chat record requires conversationId, threadId, and cwd");
  }
  return {
    conversationId,
    threadId,
    cwd,
    chatType,
    baseThreadId: record.baseThreadId ? String(record.baseThreadId) : undefined,
    status,
    createdAt: Number(record.createdAt) || Date.now(),
    endedAt: status === "ended" ? Number(record.endedAt) || Date.now() : undefined,
  };
}

export class TemporaryChatStore {
  constructor(filePath, records = []) {
    const normalized = records.map(normalizeRecord);
    const activeConversations = new Set();
    for (const record of normalized) {
      if (record.status !== "active") continue;
      if (activeConversations.has(record.conversationId)) {
        throw new TypeError("Temporary Chat store has duplicate active conversations");
      }
      activeConversations.add(record.conversationId);
    }
    this.records = new Map(normalized.map((record) => [record.threadId, record]));
    this.writeSnapshot = createSerializedFileWriter(filePath);
  }

  static async open(filePath) {
    const records = await readJsonArrayFile(filePath, "Temporary Chat store");
    return new TemporaryChatStore(filePath, records);
  }

  list() {
    return [...this.records.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => structuredClone(record));
  }

  getActive(conversationId) {
    const key = String(conversationId || "");
    const record = this.list().find((item) => item.conversationId === key && item.status === "active");
    return record ? Object.freeze(record) : undefined;
  }

  getByThread(threadId) {
    const record = this.records.get(String(threadId || ""));
    return record ? Object.freeze(structuredClone(record)) : undefined;
  }

  hasConversation(conversationId) {
    const key = String(conversationId || "");
    return [...this.records.values()].some((record) => record.conversationId === key);
  }

  hasPrivateConversation(conversationId) {
    const key = String(conversationId || "");
    return [...this.records.values()].some((record) => (
      record.conversationId === key && record.chatType === "p2p"
    ));
  }

  async start(record) {
    const normalized = normalizeRecord({ ...record, status: "active" });
    if (this.getActive(normalized.conversationId)) {
      throw new TypeError("The conversation already has an active temporary Chat");
    }
    if (this.records.has(normalized.threadId)) {
      throw new TypeError("The Codex task is already registered as a temporary Chat");
    }
    this.records.set(normalized.threadId, normalized);
    await this.persist();
    return Object.freeze(structuredClone(normalized));
  }

  async end(conversationId, endedAt = Date.now()) {
    const current = this.getActive(conversationId);
    if (!current) return undefined;
    const ended = normalizeRecord({ ...current, status: "ended", endedAt });
    this.records.set(ended.threadId, ended);
    await this.persist();
    return Object.freeze(structuredClone(ended));
  }

  async remove(threadId) {
    if (!this.records.delete(String(threadId || ""))) return false;
    await this.persist();
    return true;
  }

  async persist() {
    await this.writeSnapshot(JSON.stringify(this.list(), null, 2));
  }
}
