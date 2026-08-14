import { promises as fs } from "node:fs";

function normalizeRecord(record) {
  if (!record || typeof record !== "object") {
    throw new TypeError("Delivery record must be an object");
  }
  const kind = record.kind === "send" || record.kind === "file" ? record.kind : "reply";
  const deliveryId = String(record.deliveryId || record.messageId || "");
  if (!deliveryId) throw new TypeError("Delivery record requires a deliveryId");
  const messageId = record.messageId ? String(record.messageId) : undefined;
  const post = record.post && typeof record.post === "object" ? record.post : undefined;
  if (kind === "reply" && !messageId) throw new TypeError("Reply delivery requires a messageId");
  if (kind === "send" && !post) {
    throw new TypeError("Send delivery requires a post payload");
  }
  const fileKey = record.fileKey ? String(record.fileKey) : undefined;
  const localPath = record.localPath ? String(record.localPath) : undefined;
  if (kind === "file" && !fileKey && !localPath) {
    throw new TypeError("File delivery requires a fileKey or localPath");
  }
  return {
    deliveryId,
    kind,
    messageId,
    chatId: String(record.chatId || ""),
    threadId: record.threadId ? String(record.threadId) : undefined,
    markdown: String(record.markdown || ""),
    post: post ? structuredClone(post) : undefined,
    dependsOn: record.dependsOn ? String(record.dependsOn) : undefined,
    fileKey,
    localPath,
    fileName: record.fileName ? String(record.fileName).slice(0, 200) : undefined,
    fileSize: Number(record.fileSize) > 0 ? Number(record.fileSize) : undefined,
    modifiedAtMs: Number(record.modifiedAtMs) > 0 ? Number(record.modifiedAtMs) : undefined,
    publicStatus: kind === "reply" && record.publicStatus === true,
    createdAt: Number(record.createdAt) || Date.now(),
    attempts: Math.max(0, Number(record.attempts) || 0),
    nextAttemptAt: Math.max(0, Number(record.nextAttemptAt) || 0),
    lastError: record.lastError ? String(record.lastError).slice(0, 300) : undefined,
  };
}

export class DeliveryOutbox {
  constructor(filePath, records = []) {
    this.filePath = filePath;
    this.records = new Map(records.map((record) => {
      const normalized = normalizeRecord(record);
      return [normalized.deliveryId, normalized];
    }));
    this.writeTail = Promise.resolve();
  }

  static async open(filePath) {
    let records = [];
    try {
      const value = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!Array.isArray(value)) throw new TypeError("Delivery outbox must contain an array");
      records = value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return new DeliveryOutbox(filePath, records);
  }

  list({ dueAt } = {}) {
    return [...this.records.values()]
      .filter((record) => dueAt === undefined || record.nextAttemptAt <= dueAt)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => ({ ...record }));
  }

  size() {
    return this.records.size;
  }

  has(deliveryId) {
    return this.records.has(deliveryId);
  }

  async put(record) {
    await this.putMany([record]);
  }

  async putMany(records) {
    const normalizedRecords = records.map((record) => normalizeRecord(record));
    for (const normalized of normalizedRecords) {
      const existing = this.records.get(normalized.deliveryId);
      this.records.set(normalized.deliveryId, existing
        ? { ...existing, ...normalized, attempts: existing.attempts, nextAttemptAt: existing.nextAttemptAt }
        : normalized);
    }
    await this.persist();
  }

  async remove(deliveryId) {
    if (!this.records.delete(deliveryId)) return;
    await this.persist();
  }

  async markFailure(deliveryId, error, {
    now = Date.now(),
    baseDelayMs = 60_000,
    maxDelayMs = 15 * 60_000,
  } = {}) {
    const current = this.records.get(deliveryId);
    if (!current) return;
    const attempts = current.attempts + 1;
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempts - 1, 6));
    this.records.set(deliveryId, {
      ...current,
      attempts,
      nextAttemptAt: now + delay,
      lastError: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
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

export function deliveryIdempotencyKey(messageId) {
  const compact = String(messageId || "").replace(/[^a-zA-Z0-9]/g, "");
  return `codex-result-${compact.slice(-32)}`.slice(0, 50);
}
