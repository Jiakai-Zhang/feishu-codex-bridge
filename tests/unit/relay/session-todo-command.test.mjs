import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import {
  formatTodoSuccess,
  parseTodoInvocation,
  parseTodoRequest,
  publicTodoFailure,
  todoIdempotencyKey,
} from "../../../src/relay/session-todo-command.mjs";

const NOW = Date.UTC(2026, 8, 30, 2, 0, 0);
const OPTIONS = { nowMs: NOW, timeZone: "Asia/Taipei" };

test("recognizes only an exact todo command", () => {
  assert.equal(parseTodoInvocation("/todo 明天写报告"), "明天写报告");
  assert.equal(parseTodoInvocation("/todo@bridge 明天写报告"), "明天写报告");
  assert.equal(parseTodoInvocation("/todos 明天写报告"), undefined);
  assert.equal(parseTodoInvocation("请 /todo 明天写报告"), undefined);
});

test("parses natural Chinese due dates without using a model", () => {
  assert.deepEqual(parseTodoRequest("明天要给老师写报告", OPTIONS), {
    summary: "给老师写报告",
    due: "2026-10-01",
  });
  assert.deepEqual(parseTodoRequest("后天提醒我交材料", OPTIONS), {
    summary: "交材料",
    due: "2026-10-02",
  });
  assert.deepEqual(parseTodoRequest("下周一需要提交周报", OPTIONS), {
    summary: "提交周报",
    due: "2026-10-05",
  });
  assert.deepEqual(parseTodoRequest("10月8日复查结果", OPTIONS), {
    summary: "复查结果",
    due: "2026-10-08",
  });
  assert.deepEqual(parseTodoRequest("2026-12-31 年终总结", OPTIONS), {
    summary: "年终总结",
    due: "2026-12-31",
  });
  assert.deepEqual(parseTodoRequest("买牛奶", OPTIONS), {
    summary: "买牛奶",
    due: undefined,
  });
});

test("rejects missing tasks and invalid dates", () => {
  assert.throws(() => parseTodoRequest("", OPTIONS), /写明待办事项/);
  assert.throws(() => parseTodoRequest("明天", OPTIONS), /写明待办事项/);
  assert.throws(() => parseTodoRequest("2026-02-30 写报告", OPTIONS), /截止日期无效/);
});

test("formats a safe confirmation and stable idempotency key", () => {
  assert.equal(todoIdempotencyKey("om_message-123"), "feishu-todo-ommessage123");
  assert.match(formatTodoSuccess({
    summary: "给老师写报告",
    due: "2026-10-01",
    url: "https://applink.larkoffice.com/client/todo/detail?guid=test",
  }), /2026-10-01（全天）/);
  assert.match(formatTodoSuccess({
    summary: "给老师写报告",
    due: "2026-10-01",
    url: "https://applink.larkoffice.com/client/todo/detail?guid=test",
  }), /在飞书任务中打开/);
  assert.match(publicTodoFailure({ code: "task_auth_required" }), /task:task:write/);
});

test("wires todo before temporary Chat and binding fallbacks", async () => {
  const source = await fs.readFile(new URL("../../../src/app/session-relay.mjs", import.meta.url), "utf8");
  const inbound = source.slice(
    source.indexOf("async function processInboundMessage"),
    source.indexOf("async function handleChannelMessage"),
  );
  assert.ok(inbound.indexOf("parseTodoInvocation(rawContent)") < inbound.indexOf("parseTemporaryChatCommand(rawContent)"));
  assert.ok(inbound.indexOf("parseTodoInvocation(rawContent)") < inbound.indexOf("if (!binding)"));
  const todoHandler = source.slice(
    source.indexOf("async function processTodoMessage"),
    source.indexOf("async function pollSessionBindingInbox"),
  );
  assert.match(todoHandler, /msg\.chatType !== "p2p"/);
  assert.match(todoHandler, /msg\.senderId !== config\.agent\.ownerOpenId/);
  assert.match(todoHandler, /feishuTaskManager\.create/);
  assert.match(todoHandler, /todoIdempotencyKey\(msg\.messageId\)/);
});
