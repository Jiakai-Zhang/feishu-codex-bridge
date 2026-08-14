import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionGroupName,
  CodexDesktopCatalog,
  displaySessionTitle,
} from "./codex-desktop-catalog.mjs";

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

test("builds bounded Project/session and independent group names", () => {
  assert.equal(buildSessionGroupName("Alpha", "Fix login"), "Alpha/Fix login");
  assert.equal(buildSessionGroupName("独立", "audio/video"), "独立/audio／video");
  const name = buildSessionGroupName("A very long project name that will be bounded", "x".repeat(100));
  assert.ok(name.length <= 60);
  assert.equal(displaySessionTitle("a\n b\t c"), "a b c");
});
