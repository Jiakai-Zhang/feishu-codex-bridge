import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CodexSessionStore, normalizeCodexCwd, readIndexedThreadName } from "../../../src/codex/codex-session-store.mjs";

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
  assert.equal(await store.getUnmaterializedDraft(threadId), undefined);
});

async function draftFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-draft-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "state.sqlite");
  const rolloutPath = path.join(dir, "missing-rollout.jsonl");
  const db = new DatabaseSync(dbPath);
  db.exec(`create table threads (
    id text, name text, title text, cwd text, rollout_path text, archived integer,
    sandbox_policy text, approval_mode text, model text, reasoning_effort text, thread_source text,
    history_mode text, has_user_event integer, tokens_used integer, first_user_message text,
    preview text, created_at integer, updated_at integer, created_at_ms integer, updated_at_ms integer,
    parent_thread_id text, forked_from_id text
  );
  create table thread_attachments (thread_id text);
  create table thread_spawn_edges (parent_thread_id text, child_thread_id text)`);
  db.prepare(`insert into threads values (
    ?, ?, '', ?, ?, 0, '{}', 'never', null, null, 'desktop',
    'paginated', 0, 0, '', '', 100, 100, 100000, 100000, null, null
  )`).run("empty-draft", "Draft title", dir, rolloutPath);
  db.close();
  return {
    rolloutPath,
    store: new CodexSessionStore({ stateDbPath: dbPath, sessionIndexPath: path.join(dir, "missing-index.jsonl") }),
    mutate(sql) {
      const connection = new DatabaseSync(dbPath);
      try { connection.exec(sql); } finally { connection.close(); }
    },
  };
}

test("positively identifies an unused paginated Desktop draft without a rollout", async (t) => {
  const { store } = await draftFixture(t);
  const session = await store.getUnmaterializedDraft("empty-draft");
  assert.equal(session.id, "empty-draft");
  assert.equal(session.title, "Draft title");
  assert.equal(await store.getUnmaterializedDraft("absent"), undefined);
});

test("never treats an existing rollout, even an empty file, as an unused draft", async (t) => {
  const { store, rolloutPath } = await draftFixture(t);
  await fs.writeFile(rolloutPath, "");
  assert.equal(await store.getUnmaterializedDraft("empty-draft"), undefined);
});

test("refuses drafts with any evidence of history, lineage, activity or incompatible history mode", async (t) => {
  for (const change of [
    "history_mode = 'legacy'", "archived = 1", "has_user_event = 1", "tokens_used = 1",
    "first_user_message = 'hello'", "preview = 'hello'", "title = 'hello'",
    "updated_at = 101", "updated_at_ms = 101000", "parent_thread_id = 'parent'",
    "forked_from_id = 'parent'", "rollout_path = ''", "tokens_used = null",
    "has_user_event = null", "archived = null", "created_at = null, updated_at = null",
    "created_at_ms = null",
    "updated_at_ms = 99999", "created_at_ms = 99000",
  ]) {
    const { store, mutate } = await draftFixture(t);
    mutate(`update threads set ${change}`);
    assert.equal(await store.getUnmaterializedDraft("empty-draft"), undefined, change);
  }
  for (const sql of [
    "insert into thread_attachments values ('empty-draft')",
    "insert into thread_spawn_edges values ('empty-draft', 'child')",
    "insert into thread_spawn_edges values ('parent', 'empty-draft')",
  ]) {
    const { store, mutate } = await draftFixture(t);
    mutate(sql);
    assert.equal(await store.getUnmaterializedDraft("empty-draft"), undefined);
  }
});

test("missing proof columns on an older schema do not authorize replacement", async (t) => {
  const { store, mutate } = await draftFixture(t);
  mutate("alter table threads drop column history_mode");
  assert.equal(await store.getUnmaterializedDraft("empty-draft"), undefined);
});

test("accepts Desktop initial metadata timestamps that differ within the creation second", async (t) => {
  const { store, mutate } = await draftFixture(t);
  mutate("update threads set created_at_ms = 100915, updated_at_ms = 100916");
  assert.equal((await store.getUnmaterializedDraft("empty-draft")).id, "empty-draft");
});
