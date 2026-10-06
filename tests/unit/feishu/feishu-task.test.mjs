import assert from "node:assert/strict";
import test from "node:test";
import {
  FeishuTaskManager,
  runLarkCliTaskJson,
} from "../../../src/feishu/feishu-task.mjs";

test("creates an assigned user task with due date and idempotency", async () => {
  const calls = [];
  const manager = new FeishuTaskManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli-entry",
    assigneeOpenId: "ou_owner",
    runCommand: async (_node, _entry, args) => {
      calls.push(args);
      return {
        ok: true,
        data: { url: "https://applink.larkoffice.com/client/todo/detail?guid=task_test" },
      };
    },
  });
  const result = await manager.create({
    summary: "给老师写报告",
    due: "2026-10-01",
    idempotencyKey: "feishu-todo-message123",
  });
  assert.deepEqual(calls[0], [
    "task", "+create",
    "--as", "user",
    "--summary", "给老师写报告",
    "--assignee", "ou_owner",
    "--idempotency-key", "feishu-todo-message123",
    "--format", "json",
    "--due", "2026-10-01",
  ]);
  assert.equal(result.due, "2026-10-01");
  assert.match(result.url, /^https:\/\/applink\.larkoffice\.com\//);
});

test("creates an undated task and rejects untrusted returned links", async () => {
  let args;
  const manager = new FeishuTaskManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli-entry",
    assigneeOpenId: "ou_owner",
    runCommand: async (_node, _entry, value) => {
      args = value;
      return { ok: true, data: { url: "https://evil.example/task" } };
    },
  });
  const result = await manager.create({ summary: "买牛奶", idempotencyKey: "feishu-todo-message456" });
  assert.equal(args.includes("--due"), false);
  assert.equal(result.url, undefined);
});

test("maps missing user task scope without leaking the CLI response", async () => {
  const execFile = (...args) => {
    const callback = args.at(-1);
    callback(
      Object.assign(new Error("command failed"), { code: 1 }),
      "",
      JSON.stringify({
        ok: false,
        identity: "user",
        error: {
          type: "authorization",
          subtype: "missing_scope",
          missing_scopes: ["task:task:write"],
        },
      }),
    );
  };
  await assert.rejects(
    runLarkCliTaskJson("node", "lark-cli-entry", ["task", "+create"], { execFile }),
    (error) => error.code === "task_auth_required"
      && error.missingScopes[0] === "task:task:write",
  );
});

test("classifies a missing Feishu CLI runtime", async () => {
  const execFile = (...args) => {
    const callback = args.at(-1);
    callback(Object.assign(new Error("spawn failed"), { code: "ENOENT" }), "", "");
  };
  await assert.rejects(
    runLarkCliTaskJson("node", "lark-cli-entry", ["task", "+create"], { execFile }),
    (error) => error.code === "task_cli_unavailable",
  );
});
