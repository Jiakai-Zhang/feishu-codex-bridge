import { promises as fs } from "node:fs";
import { normalizeCodexPromptAttachments } from "../feishu/feishu-inbound-attachment.mjs";

export class SessionAttachmentDraftError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionAttachmentDraftError";
    this.code = code;
  }
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") throw new TypeError("Attachment draft record must be an object");
  const messageId = String(record.messageId || "");
  const sessionThreadId = String(record.sessionThreadId || "");
  const chatId = String(record.chatId || "");
  const attachments = normalizeCodexPromptAttachments(record.attachments);
  if (!messageId) throw new TypeError("Attachment draft record requires a messageId");
  if (!sessionThreadId) throw new TypeError("Attachment draft record requires a sessionThreadId");
  if (!chatId) throw new TypeError("Attachment draft record requires a chatId");
  if (attachments.length === 0) throw new TypeError("Attachment draft record requires attachments");
  return {
    messageId,
    sessionThreadId,
    chatId,
    feishuThreadId: record.feishuThreadId ? String(record.feishuThreadId) : undefined,
    attachments,
    claimedBy: record.claimedBy ? String(record.claimedBy) : undefined,
    createdAt: Number(record.createdAt) || Date.now(),
  };
}

function cloneRecord(record) {
  return {
    ...record,
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
  };
}

function sameRecord(left, right) {
  return left.sessionThreadId === right.sessionThreadId
    && left.chatId === right.chatId
    && left.feishuThreadId === right.feishuThreadId
    && JSON.stringify(left.attachments) === JSON.stringify(right.attachments);
}

function compareRecords(left, right) {
  return left.createdAt - right.createdAt || left.messageId.localeCompare(right.messageId);
}

function attachmentBytes(attachments) {
  return attachments.reduce((sum, attachment) => sum + (Number(attachment.size) || 0), 0);
}

export function shouldStageAttachmentPrompt(prompt, { hasPendingDraft = false } = {}) {
  const text = String(prompt?.text || "").trim();
  const attachments = normalizeCodexPromptAttachments(prompt?.attachments);
  if (text || attachments.length === 0) return false;
  return hasPendingDraft || attachments.some(({ kind }) => kind === "file");
}

export class SessionAttachmentDraftStore {
  constructor(filePath, records = [], { maxItems = 10, maxTotalBytes = 60 * 1024 * 1024 } = {}) {
    this.filePath = filePath;
    this.maxItems = Math.max(1, Number(maxItems) || 10);
    this.maxTotalBytes = Math.max(1, Number(maxTotalBytes) || 60 * 1024 * 1024);
    this.records = new Map(records.map((record) => {
      const value = normalizeRecord(record);
      return [value.messageId, value];
    }));
    this.writeTail = Promise.resolve();
  }

  static async open(filePath, options) {
    let records = [];
    try {
      const value = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!Array.isArray(value)) throw new TypeError("Attachment draft store must contain an array");
      records = value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return new SessionAttachmentDraftStore(filePath, records, options);
  }

  list(sessionThreadId, { includeClaimed = false } = {}) {
    const target = sessionThreadId == null ? undefined : String(sessionThreadId);
    return [...this.records.values()]
      .filter((record) => target === undefined || record.sessionThreadId === target)
      .filter((record) => includeClaimed || !record.claimedBy)
      .sort(compareRecords)
      .map(cloneRecord);
  }

  count(sessionThreadId) {
    return this.list(sessionThreadId).reduce((sum, record) => sum + record.attachments.length, 0);
  }

  hasPending(sessionThreadId) {
    return this.count(sessionThreadId) > 0;
  }

  protectedMessageIds() {
    return this.list(undefined, { includeClaimed: true }).map(({ messageId }) => messageId);
  }

  protectedAttachmentPaths() {
    return this.list(undefined, { includeClaimed: true })
      .flatMap(({ attachments }) => attachments.map(({ localPath }) => localPath));
  }

  async stage(record) {
    const value = normalizeRecord(record);
    const existing = this.records.get(value.messageId);
    if (existing) {
      if (!sameRecord(existing, value)) {
        throw new SessionAttachmentDraftError(
          "attachment_draft_conflict",
          "The Feishu message id is already associated with another attachment draft",
        );
      }
      return Object.freeze({
        record: Object.freeze(cloneRecord(existing)),
        attachmentCount: this.count(value.sessionThreadId),
        alreadyStaged: true,
      });
    }
    const pending = this.list(value.sessionThreadId);
    const attachments = [...pending.flatMap((entry) => entry.attachments), ...value.attachments];
    if (attachments.length > this.maxItems) {
      throw new SessionAttachmentDraftError(
        "attachment_draft_full",
        "The staged attachment draft exceeds the configured item limit",
      );
    }
    if (attachmentBytes(attachments) > this.maxTotalBytes) {
      throw new SessionAttachmentDraftError(
        "attachment_draft_total_too_large",
        "The staged attachment draft exceeds the configured total byte limit",
      );
    }
    this.records.set(value.messageId, value);
    await this.persist();
    return Object.freeze({
      record: Object.freeze(cloneRecord(value)),
      attachmentCount: attachments.length,
      alreadyStaged: false,
    });
  }

  async claim(sessionThreadId, promptMessageId, { additionalAttachments = [] } = {}) {
    const target = String(sessionThreadId || "");
    const claimId = String(promptMessageId || "");
    if (!target) throw new TypeError("Attachment draft claim requires a sessionThreadId");
    if (!claimId) throw new TypeError("Attachment draft claim requires a promptMessageId");
    const additional = normalizeCodexPromptAttachments(additionalAttachments);
    const alreadyClaimed = this.list(target, { includeClaimed: true })
      .filter(({ claimedBy }) => claimedBy === claimId);
    const pending = this.list(target);
    const otherClaim = this.list(target, { includeClaimed: true })
      .find(({ claimedBy }) => claimedBy && claimedBy !== claimId);
    if (otherClaim) {
      throw new SessionAttachmentDraftError(
        "attachment_draft_busy",
        "Another prompt is already consuming the staged attachment draft",
      );
    }
    const records = alreadyClaimed.length > 0 ? alreadyClaimed : pending;
    const stagedAttachments = records.flatMap(({ attachments }) => attachments);
    const combined = [...stagedAttachments, ...additional];
    if (combined.length > this.maxItems) {
      throw new SessionAttachmentDraftError(
        "attachment_draft_full",
        "The combined prompt exceeds the configured attachment item limit",
      );
    }
    if (attachmentBytes(combined) > this.maxTotalBytes) {
      throw new SessionAttachmentDraftError(
        "attachment_draft_total_too_large",
        "The combined prompt exceeds the configured attachment byte limit",
      );
    }
    if (alreadyClaimed.length === 0 && pending.length > 0) {
      for (const record of pending) this.records.get(record.messageId).claimedBy = claimId;
      await this.persist();
    }
    return Object.freeze({
      records: Object.freeze(records.map((record) => Object.freeze(cloneRecord({ ...record, claimedBy: claimId })))),
      messageIds: Object.freeze(records.map(({ messageId }) => messageId)),
      attachments: Object.freeze(combined.map((attachment) => Object.freeze({ ...attachment }))),
    });
  }

  async completeClaim(promptMessageId) {
    const claimId = String(promptMessageId || "");
    let removed = 0;
    for (const [messageId, record] of this.records) {
      if (record.claimedBy !== claimId) continue;
      this.records.delete(messageId);
      removed += 1;
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  async releaseClaim(promptMessageId) {
    const claimId = String(promptMessageId || "");
    let released = 0;
    for (const record of this.records.values()) {
      if (record.claimedBy !== claimId) continue;
      delete record.claimedBy;
      released += 1;
    }
    if (released > 0) await this.persist();
    return released;
  }

  async clear(sessionThreadId) {
    const target = String(sessionThreadId || "");
    const removed = [];
    for (const [messageId, record] of this.records) {
      if (record.sessionThreadId !== target || record.claimedBy) continue;
      removed.push(cloneRecord(record));
      this.records.delete(messageId);
    }
    if (removed.length > 0) await this.persist();
    return removed;
  }

  async reconcile({ isPromptAccepted = () => false } = {}) {
    let completed = 0;
    let released = 0;
    for (const [messageId, record] of this.records) {
      if (!record.claimedBy) continue;
      if (isPromptAccepted(record.claimedBy)) {
        this.records.delete(messageId);
        completed += 1;
      } else {
        delete record.claimedBy;
        released += 1;
      }
    }
    if (completed > 0 || released > 0) await this.persist();
    return Object.freeze({ completed, released });
  }

  async persist() {
    const snapshot = JSON.stringify(this.list(undefined, { includeClaimed: true }), null, 2);
    this.writeTail = this.writeTail.then(
      () => fs.writeFile(this.filePath, snapshot, "utf8"),
      () => fs.writeFile(this.filePath, snapshot, "utf8"),
    );
    await this.writeTail;
  }
}
