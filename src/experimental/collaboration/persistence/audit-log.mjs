import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ZERO_HASH = "0".repeat(64);
const MAX_DETAILS_BYTES = 8_000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordHash(record) {
  const unsigned = { ...record };
  delete unsigned.hash;
  return createHash("sha256").update(canonical(unsigned), "utf8").digest("hex");
}

function safeDetails(details) {
  if (details === undefined) return undefined;
  if (!details || typeof details !== "object" || Array.isArray(details)) throw new TypeError("Audit details must be an object");
  const json = JSON.stringify(details);
  if (Buffer.byteLength(json, "utf8") > MAX_DETAILS_BYTES) throw new TypeError("Audit details are too large");
  return JSON.parse(json);
}

export class AuditLog {
  static async open(filePath, { now = Date.now } = {}) {
    let records = [];
    try {
      const text = await fs.readFile(filePath, "utf8");
      records = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Audit log is unreadable: ${error.message}`);
    }
    let previousHash = ZERO_HASH;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.schemaVersion !== 1 || record.sequence !== index + 1) throw new Error(`Audit sequence mismatch at record ${index + 1}`);
      if (record.previousHash !== previousHash || record.hash !== recordHash(record)) throw new Error(`Audit hash chain mismatch at record ${index + 1}`);
      previousHash = record.hash;
    }
    return new AuditLog(filePath, records, { now });
  }

  constructor(filePath, records, { now = Date.now } = {}) {
    this.filePath = filePath;
    this.records = records;
    this.now = now;
    this.writeTail = Promise.resolve();
  }

  async append({ type, actor, projectId, taskId, details }) {
    if (!/^[a-z][a-z0-9_.-]{2,79}$/.test(String(type || ""))) throw new TypeError("Invalid audit event type");
    if (typeof actor !== "string" || !actor.trim() || actor.length > 160) throw new TypeError("Invalid audit actor");
    if (typeof projectId !== "string" || !projectId.trim()) throw new TypeError("Invalid audit Project");
    const previousHash = this.records.at(-1)?.hash || ZERO_HASH;
    const record = {
      schemaVersion: 1,
      sequence: this.records.length + 1,
      timestamp: this.now(),
      type,
      actor: actor.trim(),
      projectId: projectId.trim(),
      previousHash,
    };
    if (taskId) record.taskId = String(taskId).slice(0, 160);
    const normalizedDetails = safeDetails(details);
    if (normalizedDetails !== undefined) record.details = normalizedDetails;
    record.hash = recordHash(record);
    this.records.push(record);
    const line = `${JSON.stringify(record)}\n`;
    this.writeTail = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await fs.open(this.filePath, "a");
      try {
        await handle.write(line, undefined, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    await this.writeTail;
    return { ...record, details: record.details ? { ...record.details } : undefined };
  }

  tail(limit = 20) {
    const bounded = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.records.slice(-bounded).map((record) => ({
      ...record,
      details: record.details ? { ...record.details } : undefined,
    }));
  }

  size() {
    return this.records.length;
  }

  headHash() {
    return this.records.at(-1)?.hash || ZERO_HASH;
  }
}
