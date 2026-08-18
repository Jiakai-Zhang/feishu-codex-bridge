import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { stripWindowsExtendedPathPrefix } from "../runtime/shared/fs-paths.mjs";

export function normalizeCodexCwd(value) {
  return stripWindowsExtendedPathPrefix(value);
}
export async function readIndexedThreadName(indexPath, threadId) {
  const text = await fs.readFile(indexPath, "utf8");
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || !line.includes(threadId)) continue;
    try {
      const record = JSON.parse(line);
      if (record.id === threadId && typeof record.thread_name === "string" && record.thread_name.trim()) {
        return record.thread_name.trim();
      }
    } catch {}
  }
  return undefined;
}

export class CodexSessionStore {
  constructor({ stateDbPath, sessionIndexPath }) {
    this.stateDbPath = stateDbPath;
    this.sessionIndexPath = sessionIndexPath;
  }

  readState(threadId) {
    const db = new DatabaseSync(this.stateDbPath, { readOnly: true });
    try {
      return db.prepare(
        `select id, name, title, cwd, rollout_path, archived, sandbox_policy,
          approval_mode, model, reasoning_effort, thread_source
         from threads where id = ? limit 1`,
      ).get(threadId);
    } finally {
      db.close();
    }
  }

  async get(threadId) {
    const state = this.readState(threadId);
    if (!state || Number(state.archived) !== 0) return undefined;
    let indexedName;
    try { indexedName = await readIndexedThreadName(this.sessionIndexPath, threadId); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const title = String(indexedName || state.name || state.title || "").trim();
    return Object.freeze({
      ...state,
      title,
      cwd: normalizeCodexCwd(state.cwd),
      rolloutPath: normalizeCodexCwd(state.rollout_path),
    });
  }
}
