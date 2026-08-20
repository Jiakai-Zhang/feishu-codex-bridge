import { createSerializedFileWriter, readJsonArrayFile } from "./serialized-json-file.mjs";

function normalize(record) {
  if (!record || typeof record !== "object") throw new TypeError("Input ledger record must be an object");
  const messageId = String(record.messageId || "");
  if (!messageId) throw new TypeError("Input ledger record requires messageId");
  return {
    messageId,
    chatId: record.chatId ? String(record.chatId) : undefined,
    threadId: record.threadId ? String(record.threadId) : undefined,
    ...(record.senderOpenId ? { senderOpenId: String(record.senderOpenId) } : {}),
    ...(record.sessionThreadId ? { sessionThreadId: String(record.sessionThreadId) } : {}),
    ...(record.turnId ? { turnId: String(record.turnId) } : {}),
    ...(record.turnInitiator === true ? { turnInitiator: true } : {}),
    kind: String(record.kind || "prompt"),
    createdAt: Number(record.createdAt) || Date.now(),
  };
}

export class SessionInputLedger {
  constructor(filePath, records = [], { maxEntries = 10_000 } = {}) {
    this.maxEntries = maxEntries;
    this.records = new Map(records.map((record) => {
      const value = normalize(record);
      return [value.messageId, value];
    }));
    this.writeSnapshot = createSerializedFileWriter(filePath);
  }

  static async open(filePath, options) {
    const records = await readJsonArrayFile(filePath, "Input ledger");
    return new SessionInputLedger(filePath, records, options);
  }

  has(messageId) {
    return this.records.has(String(messageId));
  }

  get(messageId) {
    const record = this.records.get(String(messageId));
    return record ? { ...record } : undefined;
  }

  findTurnInitiator(sessionThreadId, turnId) {
    const session = String(sessionThreadId || "");
    const turn = String(turnId || "");
    if (!session || !turn) return undefined;
    return this.list()
      .filter((record) => record.sessionThreadId === session && record.turnId === turn && record.turnInitiator === true)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
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
    await this.writeSnapshot(snapshot);
  }
}
