import { normalizeCodexPromptAttachments } from "../feishu/feishu-inbound-attachment.mjs";
import { createSerializedFileWriter, readJsonArrayFile } from "./serialized-json-file.mjs";

export class SessionPromptQueueError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "SessionPromptQueueError";
    this.code = code;
  }
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") throw new TypeError("Queued prompt must be an object");
  const messageId = String(record.messageId || "");
  const sessionThreadId = String(record.sessionThreadId || "");
  const chatId = String(record.chatId || "");
  const text = String(record.text || "");
  const attachments = normalizeCodexPromptAttachments(record.attachments);
  if (!messageId) throw new TypeError("Queued prompt requires a messageId");
  if (!sessionThreadId) throw new TypeError("Queued prompt requires a sessionThreadId");
  if (!chatId) throw new TypeError("Queued prompt requires a chatId");
  if (!text.trim() && attachments.length === 0) throw new TypeError("Queued prompt is empty");
  return {
    messageId,
    sessionThreadId,
    chatId,
    feishuThreadId: record.feishuThreadId ? String(record.feishuThreadId) : undefined,
    text,
    attachments,
    createdAt: Number(record.createdAt) || Date.now(),
  };
}

function cloneRecord(record) {
  return {
    ...record,
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
  };
}

function samePrompt(left, right) {
  return left.text === right.text && JSON.stringify(left.attachments) === JSON.stringify(right.attachments);
}

function compareRecords(left, right) {
  return left.createdAt - right.createdAt || left.messageId.localeCompare(right.messageId);
}

export class SessionPromptQueue {
  constructor(filePath, records = [], {
    maxPerSession = 100,
    getController = () => undefined,
    onAccepted = async () => {},
    onError = () => {},
  } = {}) {
    this.maxPerSession = maxPerSession;
    this.getController = getController;
    this.onAccepted = onAccepted;
    this.onError = onError;
    this.records = new Map(records.map((record) => {
      const value = normalizeRecord(record);
      return [value.messageId, value];
    }));
    this.writeSnapshot = createSerializedFileWriter(filePath);
    this.threadTails = new Map();
    this.dispatching = new Map();
  }

  static async open(filePath, options) {
    const records = await readJsonArrayFile(filePath, "Session prompt queue");
    return new SessionPromptQueue(filePath, records, options);
  }

  has(messageId) {
    return this.records.has(String(messageId));
  }

  list(sessionThreadId) {
    const target = sessionThreadId == null ? undefined : String(sessionThreadId);
    return [...this.records.values()]
      .filter((record) => target === undefined || record.sessionThreadId === target)
      .sort(compareRecords)
      .map(cloneRecord);
  }

  count(sessionThreadId) {
    return this.list(sessionThreadId).length;
  }

  pendingThreads() {
    return [...new Set(this.list().map((record) => record.sessionThreadId))];
  }

  #serialize(sessionThreadId, work) {
    const key = String(sessionThreadId);
    const previous = this.threadTails.get(key) || Promise.resolve();
    const running = previous.catch(() => {}).then(work);
    const tail = running.catch(() => {}).finally(() => {
      if (this.threadTails.get(key) === tail) this.threadTails.delete(key);
    });
    this.threadTails.set(key, tail);
    return running;
  }

  async enqueue(record, { afterPersist } = {}) {
    const value = normalizeRecord(record);
    return this.#serialize(value.sessionThreadId, async () => {
      const existing = this.records.get(value.messageId);
      if (existing) {
        if (existing.sessionThreadId !== value.sessionThreadId || !samePrompt(existing, value)) {
          throw new SessionPromptQueueError(
            "queue_message_conflict",
            "The Feishu message id is already associated with another queued prompt",
          );
        }
        return Object.freeze({
          record: Object.freeze(cloneRecord(existing)),
          position: this.list(value.sessionThreadId).findIndex(({ messageId }) => messageId === value.messageId) + 1,
          alreadyQueued: true,
        });
      }
      if (this.count(value.sessionThreadId) >= this.maxPerSession) {
        throw new SessionPromptQueueError("queue_full", "The Session prompt queue is full");
      }
      this.records.set(value.messageId, value);
      await this.persist();
      try {
        await afterPersist?.(Object.freeze(cloneRecord(value)));
      } catch (error) {
        this.records.delete(value.messageId);
        await this.persist().catch(() => {});
        throw error;
      }
      return Object.freeze({
        record: Object.freeze(cloneRecord(value)),
        position: this.list(value.sessionThreadId).findIndex(({ messageId }) => messageId === value.messageId) + 1,
        alreadyQueued: false,
      });
    });
  }

  async removeAt(sessionThreadId, position) {
    const target = String(sessionThreadId);
    return this.#serialize(target, async () => {
      const index = Number(position) - 1;
      const entries = this.list(target);
      if (!Number.isSafeInteger(index) || index < 0 || index >= entries.length) {
        throw new SessionPromptQueueError("queue_position_invalid", "The queued prompt position does not exist");
      }
      const [record] = entries.splice(index, 1);
      this.records.delete(record.messageId);
      await this.persist();
      return Object.freeze(cloneRecord(record));
    });
  }

  async clear(sessionThreadId) {
    const target = String(sessionThreadId);
    return this.#serialize(target, async () => {
      const entries = this.list(target);
      for (const record of entries) this.records.delete(record.messageId);
      if (entries.length > 0) await this.persist();
      return entries.length;
    });
  }

  async dispatch(sessionThreadId) {
    const target = String(sessionThreadId);
    const existing = this.dispatching.get(target);
    if (existing) return existing;
    const running = this.#serialize(target, async () => {
      let reconciled = 0;
      for (;;) {
        const record = this.list(target)[0];
        if (!record) return Object.freeze({ kind: "empty", reconciled });
        const controller = this.getController();
        if (!controller) return Object.freeze({ kind: "waiting", reason: "controller_unavailable", reconciled });
        let result;
        try {
          result = await controller.startQueuedPrompt({
            threadId: target,
            text: record.text,
            attachments: record.attachments,
            clientUserMessageId: record.messageId,
          });
        } catch (error) {
          this.onError(error, record);
          return Object.freeze({ kind: "waiting", reason: error?.code || "controller_error", reconciled });
        }
        if (result?.kind === "waiting") {
          return Object.freeze({ ...result, reconciled });
        }
        try {
          await this.onAccepted(Object.freeze(cloneRecord(record)), result);
        } catch (error) {
          this.onError(error, record);
          return Object.freeze({ kind: "waiting", reason: "acceptance_persist_failed", reconciled });
        }
        this.records.delete(record.messageId);
        try {
          await this.persist();
        } catch (error) {
          this.records.set(record.messageId, record);
          this.onError(error, record);
          return Object.freeze({ kind: "waiting", reason: "acceptance_remove_failed", reconciled });
        }
        if (result?.turnStatus === "inProgress" || result?.kind === "started") {
          return Object.freeze({ ...result, messageId: record.messageId, reconciled });
        }
        reconciled += 1;
      }
    });
    this.dispatching.set(target, running);
    const clear = () => {
      if (this.dispatching.get(target) === running) this.dispatching.delete(target);
    };
    running.then(clear, clear);
    return running;
  }

  async dispatchAll() {
    return Promise.allSettled(this.pendingThreads().map((threadId) => this.dispatch(threadId)));
  }

  async persist() {
    const snapshot = JSON.stringify(this.list(), null, 2);
    await this.writeSnapshot(snapshot);
  }
}
