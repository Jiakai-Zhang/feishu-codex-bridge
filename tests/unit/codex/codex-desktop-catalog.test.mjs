import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildSessionGroupName,
  CodexDesktopCatalog,
  displaySessionTitle,
} from "../../../src/codex/codex-desktop-catalog.mjs";

const state = {
  "local-projects": {
    a: { id: "project-a", name: "Alpha", rootPaths: ["C:\\alpha"] },
    b: { id: "project-b", name: "Beta", rootPaths: ["C:\\beta"] },
  },
  "project-order": ["project-b", "project-a"],
  "thread-project-assignments": {
    "thread-a": { projectKind: "local", projectId: "project-a" },
    "thread-stale": { projectKind: "local", projectId: "missing" },
  },
  "projectless-thread-ids": ["thread-i"],
};

test("lists sessions by exact Desktop Project assignment and projectless state", async () => {
  const files = new Map([
    ["global.json", JSON.stringify(state)],
    ["index.jsonl", `${JSON.stringify({ id: "thread-a", thread_name: "Renamed Task" })}\n`],
  ]);
  const catalog = new CodexDesktopCatalog({
    globalStatePath: "global.json",
    stateDbPath: "state.db",
    sessionIndexPath: "index.jsonl",
    readFile: async (file) => files.get(file),
    listProjectWorktrees: async (root) => [root],
    readThreads: () => [
      { id: "thread-i", preview: "Independent task", cwd: "C:\\independent", updated_at_ms: 30 },
      { id: "thread-a", title: "Old task title", cwd: "\\\\?\\C:\\alpha", updated_at_ms: 20 },
      { id: "thread-stale", title: "Stale project", cwd: "C:\\stale", updated_at_ms: 10 },
    ],
  });

  const result = await catalog.load({
    bindings: [{ threadId: "thread-a", groupChatId: "oc_bound" }],
  });

  assert.deepEqual(result.projects.map(({ id }) => id), ["project-b", "project-a"]);
  assert.equal(result.projects[1].sessions[0].title, "Renamed Task");
  assert.equal(result.projects[1].sessions[0].cwd, "C:\\alpha");
  assert.equal(result.projects[1].sessions[0].binding.groupChatId, "oc_bound");
  assert.equal(result.independent[0].title, "Independent task");
  assert.equal(result.sessionsById.has("thread-stale"), false);
});

test("infers only unassigned sessions from a unique Project Git worktree", async () => {
  const inferredState = {
    "local-projects": {
      a: { id: "project-a", name: "Alpha", rootPaths: ["C:\\alpha"] },
      b: { id: "project-b", name: "Beta", rootPaths: ["C:\\beta"] },
    },
    "thread-project-assignments": {
      "thread-explicit": { projectKind: "local", projectId: "project-b" },
    },
    "projectless-thread-ids": ["thread-independent"],
  };
  const files = new Map([
    ["global.json", JSON.stringify(inferredState)],
    ["index.jsonl", ""],
  ]);
  const catalog = new CodexDesktopCatalog({
    globalStatePath: "global.json",
    stateDbPath: "state.db",
    sessionIndexPath: "index.jsonl",
    readFile: async (file) => files.get(file),
    listProjectWorktrees: async (root) => root === "C:\\alpha"
      ? [root, "C:/worktrees/alpha-feature"]
      : [root],
    readThreads: () => [
      { id: "thread-inferred", title: "Inferred", cwd: "C:\\worktrees\\alpha-feature", updated_at_ms: 30 },
      { id: "thread-explicit", title: "Explicit", cwd: "C:\\worktrees\\alpha-feature", updated_at_ms: 20 },
      { id: "thread-independent", title: "Independent", cwd: "C:\\worktrees\\alpha-feature", updated_at_ms: 10 },
    ],
  });

  const result = await catalog.load();
  const alpha = result.projects.find(({ id }) => id === "project-a");
  const beta = result.projects.find(({ id }) => id === "project-b");
  assert.deepEqual(alpha.sessions.map(({ id }) => id), ["thread-inferred"]);
  assert.deepEqual(beta.sessions.map(({ id }) => id), ["thread-explicit"]);
  assert.deepEqual(result.independent.map(({ id }) => id), ["thread-independent"]);
});

test("does not guess an unassigned session when Project worktree scopes are ambiguous", async () => {
  const ambiguousState = {
    "local-projects": {
      a: { id: "project-a", name: "Alpha", rootPaths: ["C:\\alpha"] },
      b: { id: "project-b", name: "Beta", rootPaths: ["C:\\beta"] },
    },
  };
  const files = new Map([
    ["global.json", JSON.stringify(ambiguousState)],
    ["index.jsonl", ""],
  ]);
  const catalog = new CodexDesktopCatalog({
    globalStatePath: "global.json",
    stateDbPath: "state.db",
    sessionIndexPath: "index.jsonl",
    readFile: async (file) => files.get(file),
    listProjectWorktrees: async (root) => [root, "C:\\shared-worktree"],
    readThreads: () => [
      { id: "thread-ambiguous", title: "Ambiguous", cwd: "C:\\shared-worktree", updated_at_ms: 10 },
    ],
  });

  const result = await catalog.load();
  assert.equal(result.sessionsById.has("thread-ambiguous"), false);
});

test("matches the Desktop task list by excluding archived and subagent threads", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-desktop-catalog-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stateDbPath = path.join(directory, "state.sqlite");
  const db = new DatabaseSync(stateDbPath);
  db.exec(`create table threads (
    id text primary key,
    name text,
    title text,
    preview text,
    cwd text,
    updated_at integer,
    updated_at_ms integer,
    recency_at integer,
    recency_at_ms integer,
    archived integer not null,
    thread_source text
  )`);
  const insert = db.prepare(`insert into threads (
    id, title, cwd, updated_at_ms, archived, thread_source
  ) values (?, ?, ?, ?, ?, ?)`);
  insert.run("thread-user", "User task", "C:\\alpha", 40, 0, "user");
  insert.run("thread-legacy", "Legacy user task", "C:\\alpha", 30, 0, null);
  insert.run("thread-subagent", "Guardian task", "C:\\alpha", 20, 0, "subagent");
  insert.run("thread-archived", "Archived task", "C:\\alpha", 10, 1, "user");
  db.close();

  const filteredState = {
    "local-projects": {
      a: { id: "project-a", name: "Alpha", rootPaths: ["C:\\alpha"] },
    },
    "thread-project-assignments": Object.fromEntries([
      "thread-user", "thread-legacy", "thread-subagent", "thread-archived",
    ].map((id) => [id, { projectKind: "local", projectId: "project-a" }])),
  };
  const catalog = new CodexDesktopCatalog({
    globalStatePath: "global.json",
    stateDbPath,
    sessionIndexPath: "index.jsonl",
    readFile: async (file) => file === "global.json" ? JSON.stringify(filteredState) : "",
    listProjectWorktrees: async (root) => [root],
  });

  const result = await catalog.load();
  assert.deepEqual(
    result.projects[0].sessions.map(({ id }) => id),
    ["thread-user", "thread-legacy"],
  );
  assert.equal(result.sessionsById.has("thread-subagent"), false);
  assert.equal(result.sessionsById.has("thread-archived"), false);
});

test("builds bounded Project/session and independent group names", () => {
  assert.equal(buildSessionGroupName("Alpha", "Fix login"), "Alpha/Fix login");
  assert.equal(buildSessionGroupName("独立", "audio/video"), "独立/audio／video");
  const name = buildSessionGroupName("A very long project name that will be bounded", "x".repeat(100));
  assert.ok(name.length <= 60);
  assert.equal(displaySessionTitle("a\n b\t c"), "a b c");
});
