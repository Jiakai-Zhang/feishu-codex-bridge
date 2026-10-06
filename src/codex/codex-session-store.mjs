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

  async getUnmaterializedDraft(threadId) {
    const db = new DatabaseSync(this.stateDbPath, { readOnly: true });
    let state;
    try {
      state = db.prepare("select * from threads where id = ? limit 1").get(threadId);
      // Missing fields on older schemas are NOT evidence of an empty task.
      const required = ["history_mode", "has_user_event", "tokens_used", "first_user_message",
        "preview", "title", "created_at", "updated_at", "archived", "rollout_path"];
      if (!state || required.some((key) => !Object.hasOwn(state, key))) return undefined;
      // Desktop's initial metadata insert/update can differ by a millisecond.
      // Require both clocks to remain within the original creation second;
      // all independent no-input/no-history evidence below is still mandatory.
      const hasMillisecondClock = state.created_at_ms != null || state.updated_at_ms != null;
      const initialMillisecondClock = !hasMillisecondClock ||
        (Number.isSafeInteger(state.created_at_ms) && Number.isSafeInteger(state.updated_at_ms) &&
          state.updated_at_ms >= state.created_at_ms &&
          Math.floor(state.created_at_ms / 1000) === state.created_at &&
          Math.floor(state.updated_at_ms / 1000) === state.created_at);
      if (state.history_mode !== "paginated" || state.archived !== 0 ||
          state.has_user_event !== 0 || state.tokens_used !== 0 ||
          state.first_user_message || state.preview || state.title ||
          state.created_at == null || state.created_at !== state.updated_at || !state.rollout_path ||
          state.parent_thread_id || state.forked_from_id ||
          !initialMillisecondClock) return undefined;
      const tables = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name));
      if (tables.has("thread_attachments") &&
          db.prepare("select count(*) as n from thread_attachments where thread_id = ?").get(threadId).n) return undefined;
      if (tables.has("thread_spawn_edges") &&
          db.prepare("select count(*) as n from thread_spawn_edges where parent_thread_id = ? or child_thread_id = ?").get(threadId, threadId).n) return undefined;
    } finally {
      db.close();
    }
    try {
      await fs.stat(normalizeCodexCwd(state.rollout_path));
      return undefined;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this.get(threadId);
  }
}
