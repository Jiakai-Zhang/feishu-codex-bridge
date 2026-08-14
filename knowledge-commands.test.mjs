import assert from "node:assert/strict";
import test from "node:test";
import { buildKnowledgeArtifactMarkdown, buildKnowledgeListMarkdown, parseKnowledgeCommand } from "./knowledge-commands.mjs";

test("parses list, show, create, and revision-checked update commands", () => {
  assert.deepEqual(parseKnowledgeCommand(""), { action: "list" });
  assert.deepEqual(parseKnowledgeCommand("show knowledge/rules"), { action: "show", category: "knowledge", id: "rules" });
  assert.deepEqual(parseKnowledgeCommand("create summaries/handoff milestone complete"), {
    action: "create",
    category: "summaries",
    id: "handoff",
    content: "milestone complete",
    title: "handoff",
  });
  const rev = "a".repeat(64);
  assert.deepEqual(parseKnowledgeCommand(`update references/api ${rev} new link`), {
    action: "update",
    category: "references",
    id: "api",
    expectedRevision: rev,
    content: "new link",
  });
  assert.match(parseKnowledgeCommand("show ../escape").error, /用法/);
});

test("renders repository scope, revision, and stable/live separation", () => {
  const record = {
    projectId: "bridge",
    category: "knowledge",
    id: "rules",
    title: "Rules",
    revision: "b".repeat(64),
    repositoryIds: ["bridge"],
    authorAgentId: "local-codex",
    externalChange: false,
  };
  const list = buildKnowledgeListMarkdown([record], {
    project: { name: "Bridge" },
    teamHub: { path: "C:/hub", repositoryIds: ["bridge"], maxContextChars: 24000 },
  });
  assert.match(list, /实时 Agent 任务状态/);
  assert.match(list, /knowledge\/rules/);
  const artifact = buildKnowledgeArtifactMarkdown({ metadata: record, content: "Stable rule", revision: record.revision, externalChange: false });
  assert.match(artifact, /Stable rule/);
  assert.match(artifact, new RegExp(record.revision));
});
