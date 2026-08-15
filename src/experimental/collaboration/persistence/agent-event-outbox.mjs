import { promises as fs } from "node:fs";

function normalize(record) {
  if (!record?.event?.eventId || typeof record.peerAgentId !== "string" || typeof record.chatId !== "string") {
    throw new TypeError("Agent event outbox record requires event, peerAgentId, and chatId");
  }
  return {
    eventId: String(record.event.eventId),
    peerAgentId: record.peerAgentId,
    chatId: record.chatId,
    event: JSON.parse(JSON.stringify(record.event)),
    createdAt: Number(record.createdAt) || Date.now(),
    attempts: Math.max(0, Number(record.attempts) || 0),
    nextAttemptAt: Math.max(0, Number(record.nextAttemptAt) || 0),
    lastErrorCode: record.lastErrorCode ? String(record.lastErrorCode).slice(0, 80) : undefined,
  };
}

function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) return String(error.code).slice(0, 80);
  return error instanceof Error ? error.name.slice(0, 80) : "unknown";
}

export class AgentEventOutbox {
  static async open(filePath) {
    let records = [];
    try {
      records = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!Array.isArray(records)) throw new TypeError("Agent event outbox must contain an array");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return new AgentEventOutbox(filePath, records);
  }

  constructor(filePath, records = []) {
    this.filePath = filePath;
    this.records = new Map(records.map((record) => {
      const value = normalize(record);
      return [value.eventId, value];
    }));
    this.writeTail = Promise.resolve();
  }

  size() {
    return this.records.size;
  }

  list({ dueAt } = {}) {
    return [...this.records.values()]
      .filter((record) => dueAt === undefined || record.nextAttemptAt <= dueAt)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => JSON.parse(JSON.stringify(record)));
  }

  async put(record) {
    const value = normalize(record);
    const existing = this.records.get(value.eventId);
    if (existing && JSON.stringify(existing.event) !== JSON.stringify(value.event)) {
      throw new Error(`Agent eventId collision: ${value.eventId}`);
    }
    this.records.set(value.eventId, existing || value);
    await this.persist();
  }

  async remove(eventId) {
    if (!this.records.delete(eventId)) return;
    await this.persist();
  }

  async markFailure(eventId, error, {
    now = Date.now(),
    baseDelayMs = 15_000,
    maxDelayMs = 15 * 60_000,
  } = {}) {
    const current = this.records.get(eventId);
    if (!current) return;
    const attempts = current.attempts + 1;
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempts - 1, 6));
    this.records.set(eventId, {
      ...current,
      attempts,
      nextAttemptAt: now + delay,
      lastErrorCode: errorCode(error),
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
