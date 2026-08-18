import { promises as fs } from "node:fs";
import path from "node:path";
import { createSerializedFileWriter, readJsonArrayFile } from "../../../persistence/serialized-json-file.mjs";

function key(projectId, branch) {
  return `${projectId}:${branch}`;
}

export class TaskLeaseStore {
  static async open(filePath, { now = Date.now } = {}) {
    const records = await readJsonArrayFile(filePath, "Task lease store");
    return new TaskLeaseStore(filePath, records, { now });
  }

  constructor(filePath, records, { now = Date.now } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.leases = new Map(records.map((lease) => [key(lease.projectId, lease.branch), { ...lease }]));
    this.writeSnapshot = createSerializedFileWriter(filePath);
    this.prune();
  }

  list() {
    this.prune();
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  async acquire({ projectId, branch, taskId, ownerAgentId, leaseMs }) {
    return this.withFileLock(async () => {
      await this.reload();
      this.prune();
      const leaseKey = key(projectId, branch);
      const current = this.leases.get(leaseKey);
      if (current && current.taskId !== taskId) {
        throw new Error(`Branch ${branch} is leased by task ${current.taskId} until ${new Date(current.expiresAt).toISOString()}`);
      }
      const timestamp = this.now();
      const lease = {
        projectId,
        branch,
        taskId,
        ownerAgentId,
        acquiredAt: current?.acquiredAt || timestamp,
        renewedAt: timestamp,
        expiresAt: timestamp + leaseMs,
      };
      this.leases.set(leaseKey, lease);
      await this.persist();
      return { ...lease };
    });
  }

  async release({ projectId, branch, taskId }) {
    return this.withFileLock(async () => {
      await this.reload();
      const leaseKey = key(projectId, branch);
      const current = this.leases.get(leaseKey);
      if (!current || current.taskId !== taskId) return false;
      this.leases.delete(leaseKey);
      await this.persist();
      return true;
    });
  }

  prune() {
    const timestamp = this.now();
    for (const [leaseKey, lease] of this.leases) {
      if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= timestamp) this.leases.delete(leaseKey);
    }
  }

  async persist() {
    const snapshot = JSON.stringify(this.list(), null, 2);
    await this.writeSnapshot(snapshot);
  }

  async reload() {
    const records = await readJsonArrayFile(this.filePath, "Task lease store");
    this.leases = new Map(records.map((lease) => [key(lease.projectId, lease.branch), { ...lease }]));
  }

  async withFileLock(callback) {
    const lockPath = `${this.filePath}.lock`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        handle = await fs.open(lockPath, "wx");
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stale = await fs.stat(lockPath).then((stat) => this.now() - stat.mtimeMs > 30_000, () => false);
        if (stale) await fs.unlink(lockPath).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!handle) throw new Error("Task lease store is locked");
    try { return await callback(); }
    finally {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}
