import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeHub } from "./knowledge-hub.mjs";

async function fixture(run, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-knowledge-"));
  try {
    await run(new KnowledgeHub(directory, {
      projectId: "bridge",
      agentId: "local-codex",
      repositoryIds: ["bridge", "docs"],
      maxContextChars: options.maxContextChars || 4_000,
      now: () => 1_800_000_000_000,
    }), directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("creates, lists, reads, and revision-updates Project knowledge", async () => fixture(async (hub) => {
  const created = await hub.create({
    category: "knowledge",
    id: "project-boundary",
    title: "Project boundary",
    content: "Use one writable branch per worktree.",
    authorHumanOpenId: "ou_owner",
  });
  assert.equal(created.repositoryIds.length, 2);
  assert.equal((await hub.list())[0].id, "project-boundary");
  const current = await hub.get("knowledge", "project-boundary");
  assert.equal(current.externalChange, false);
  const updated = await hub.update({
    category: "knowledge",
    id: "project-boundary",
    content: "Use one writable branch per independent worktree.",
    expectedRevision: current.revision,
    authorHumanOpenId: "ou_owner",
  });
  assert.notEqual(updated.revision, current.revision);
  await assert.rejects(() => hub.update({
    category: "knowledge",
    id: "project-boundary",
    content: "stale writer",
    expectedRevision: current.revision,
    authorHumanOpenId: "ou_owner",
  }), /revision conflict/);
}));

test("separates stable categories and builds bounded Codex context", async () => fixture(async (hub) => {
  await hub.create({ category: "knowledge", id: "rules", title: "Rules", content: "Stable rule", authorHumanOpenId: "ou_owner" });
  await hub.create({ category: "summaries", id: "handoff", title: "Handoff", content: "Milestone summary", authorHumanOpenId: "ou_owner" });
  await hub.create({ category: "references", id: "api", title: "API", content: "Reference: https://example.test", authorHumanOpenId: "ou_owner" });
  const context = await hub.buildContext();
  assert.match(context, /不是实时任务状态/);
  assert.match(context, /knowledge\/rules/);
  assert.match(context, /summaries\/handoff/);
  assert.match(context, /references\/api/);
  assert.ok(context.length <= 4_000);
}));

test("contains paths and detects direct external edits", async () => fixture(async (hub, directory) => {
  await assert.rejects(() => hub.create({ category: "knowledge", id: "../escape", content: "x" }), /Invalid/);
  await hub.create({ category: "knowledge", id: "rules", title: "Rules", content: "v1", authorHumanOpenId: "ou_owner" });
  const contentPath = path.join(directory, "projects", "bridge", "knowledge", "rules.md");
  await fs.writeFile(contentPath, "external edit\n", "utf8");
  assert.equal((await hub.get("knowledge", "rules")).externalChange, true);
}));

test("serializes concurrent writers and rejects the stale revision", async () => fixture(async (hub) => {
  await hub.create({ category: "summaries", id: "milestone", title: "Milestone", content: "v1", authorHumanOpenId: "ou_owner" });
  const current = await hub.get("summaries", "milestone");
  const results = await Promise.allSettled([
    hub.update({ category: "summaries", id: "milestone", content: "writer A", expectedRevision: current.revision, authorHumanOpenId: "ou_owner" }),
    hub.update({ category: "summaries", id: "milestone", content: "writer B", expectedRevision: current.revision, authorHumanOpenId: "ou_owner" }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.match(results.find(({ status }) => status === "rejected").reason.message, /revision conflict/);
}));
