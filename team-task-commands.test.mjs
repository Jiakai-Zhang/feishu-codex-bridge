import assert from "node:assert/strict";
import test from "node:test";
import { buildTeamTasksMarkdown, parseDelegateArgument, parseTaskActionArgument } from "./team-task-commands.mjs";

test("parses bounded human delegation and task actions", () => {
  assert.deepEqual(parseDelegateArgument("alice-codex task/router 修复路由并测试"), {
    peerAgentId: "alice-codex",
    branch: "task/router",
    prompt: "修复路由并测试",
    title: "修复路由并测试",
  });
  assert.match(parseDelegateArgument("alice ../escape x").error, /branch/);
  assert.deepEqual(parseTaskActionArgument("task:12345678 reviewed"), {
    taskId: "task:12345678",
    note: "reviewed",
  });
  assert.match(parseTaskActionArgument("task:12345678", { requireNote: true }).error, /原因/);
});

test("renders task ownership and state without full prompts", () => {
  const markdown = buildTeamTasksMarkdown([{
    taskId: "task:12345678",
    title: "Fix routing",
    prompt: "secret full prompt",
    state: "pending",
    direction: "inbound",
    peerAgentId: "alice-codex",
    requesterAgentId: "alice-codex",
    executorAgentId: "local-codex",
    branch: "task/router",
  }]);
  assert.match(markdown, /alice-codex/);
  assert.match(markdown, /pending/);
  assert.doesNotMatch(markdown, /secret full prompt/);
});
