import { promises as fs } from "node:fs";

function normalize(record) {
  if (!record || typeof record !== "object") throw new TypeError("Input ledger record must be an object");
  const messageId = String(record.messageId || "");
  if (!messageId) throw new TypeError("Input ledger record requires messageId");
  return {
    messageId,
    chatId: record.chatId ? String(record.chatId) : undefined,
    threadId: record.threadId ? String(record.threadId) : undefined,
    kind: String(record.kind || "prompt"),
    createdAt: Number(record.createdAt) || Date.now(),
  };
}

export class SessionInputLedger {
  constructor(filePath, records = [], { maxEntries = 10_000 } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.records = new Map(records.map((record) => {
      const value = normalize(record);
      return [value.messageId, value];
    }));
    this.writeTail = Promise.resolve();
  }

  static async open(filePath, options) {
    let records = [];
    try {
      const value = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!Array.isArray(value)) throw new TypeError("Input ledger must contain an array");
      records = value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return new SessionInputLedger(filePath, records, options);
  }

  has(messageId) {
    return this.records.has(String(messageId));
  }

  get(messageId) {
    const record = this.records.get(String(messageId));
    return record ? { ...record } : undefined;
  }

  list() {
    return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt).map((record) => ({ ...record }));
  }

  async put(record) {
    const value = normalize(record);
    this.records.set(value.messageId, value);
    if (this.records.size > this.maxEntries) {
      const removeCount = this.records.size - Math.floor(this.maxEntries * 0.8);
      for (const old of this.list().slice(0, removeCount)) this.records.delete(old.messageId);
    }
    await this.persist();
    return { ...value };
  }

  async remove(messageId) {
    if (!this.records.delete(String(messageId))) return;
    await this.persist();
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
