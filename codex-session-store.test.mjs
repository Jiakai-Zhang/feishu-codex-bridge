import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CodexSessionStore, normalizeCodexCwd, readIndexedThreadName } from "./codex-session-store.mjs";

const threadId = "019ff5b8-decb-7ca3-802c-f115f2f196de";

test("reads the latest explicit Codex task name from session_index.jsonl", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-index-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const indexPath = path.join(dir, "session_index.jsonl");
  await fs.writeFile(indexPath, [
    JSON.stringify({ id: threadId, thread_name: "Old title" }),
    JSON.stringify({ id: "other", thread_name: "Other" }),
    JSON.stringify({ id: threadId, thread_name: "Current title" }),
  ].join("\n"), "utf8");
  assert.equal(await readIndexedThreadName(indexPath, threadId), "Current title");
});
test("loads an explicitly bound unarchived session regardless of thread_source", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "state.sqlite");
  const indexPath = path.join(dir, "session_index.jsonl");
  const db = new DatabaseSync(dbPath);
  db.exec(`create table threads (
    id text, name text, title text, cwd text, rollout_path text, archived integer,
    sandbox_policy text, approval_mode text, model text, reasoning_effort text, thread_source text
  )`);
  db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    threadId, null, "First prompt", "\\\\?\\C:\\repo", "\\\\?\\C:\\rollout.jsonl", 0,
    "{}", "never", "gpt", "high", "subagent",
  );
  db.close();
  await fs.writeFile(indexPath, `${JSON.stringify({ id: threadId, thread_name: "Visible task name" })}\n`, "utf8");
  const store = new CodexSessionStore({ stateDbPath: dbPath, sessionIndexPath: indexPath });
  const session = await store.get(threadId);
  assert.equal(session.title, "Visible task name");
  assert.equal(session.cwd, "C:\\repo");
  assert.equal(session.thread_source, "subagent");
});

test("normalizes Windows extended paths and rejects archived bindings", async (t) => {
  assert.equal(normalizeCodexCwd("\\\\?\\C:\\repo"), "C:\\repo");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-archived-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "state.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`create table threads (
    id text, name text, title text, cwd text, rollout_path text, archived integer,
    sandbox_policy text, approval_mode text, model text, reasoning_effort text, thread_source text
  )`);
  db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    threadId, "Archived", "Archived", "C:\\repo", "C:\\rollout", 1, "{}", "never", "gpt", "high", "user",
  );
  db.close();
  const store = new CodexSessionStore({ stateDbPath: dbPath, sessionIndexPath: path.join(dir, "missing.jsonl") });
  assert.equal(await store.get(threadId), undefined);
});
