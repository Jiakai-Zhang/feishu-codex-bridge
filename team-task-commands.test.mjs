import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskLandingMarkdown,
  buildTeamTasksMarkdown,
  parseDelegateArgument,
  parseTaskAcceptArgument,
  parseTaskActionArgument,
} from "./team-task-commands.mjs";

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
  assert.deepEqual(parseTaskAcceptArgument("task:12345678 thread:019ff5a0-559b-79d3-8bd3-2eb2d5f0c294"), {
    taskId: "task:12345678",
    choice: "thread:019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
  });
  assert.deepEqual(parseTaskAcceptArgument("task:12345678"), { taskId: "task:12345678", choice: "auto" });
  assert.match(parseTaskAcceptArgument("task:12345678 anywhere").error, /接收位置/);
});

test("renders local landing choices without exposing another machine's thread id", () => {
  const task = { taskId: "task:12345678", githubRepository: "example/repo", branch: "task/router" };
  const markdown = buildTaskLandingMarkdown(task, {
    recommendation: { landing: "existing-thread", threadId: "local-thread" },
    options: [
      { landing: "existing-thread", threadId: "local-thread", title: "Routing" },
      { landing: "new-thread", worktreePath: "C:/local/path" },
    ],
  }, "recommend");
  assert.match(markdown, /local-thread/);
  assert.match(markdown, /new-thread/);
  assert.doesNotMatch(markdown, /C:\/local\/path/);
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
