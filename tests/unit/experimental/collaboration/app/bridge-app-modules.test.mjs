import assert from "node:assert/strict";
import test from "node:test";
import { commandName, immediateCommands } from "../../../../../src/experimental/collaboration/app/command-router.mjs";
import { createOutboundDelivery } from "../../../../../src/experimental/collaboration/app/outbound-delivery.mjs";
import {
  createStatusRenderer,
  formatDuration,
  safeProgressUpdate,
  sanitizeProgressNote,
} from "../../../../../src/experimental/collaboration/app/progress-renderer.mjs";

test("classifies only the command token for immediate routing", () => {
  assert.equal(commandName("/status anything"), "/status");
  assert.equal(commandName(" ordinary prompt "), "ordinary");
  assert.equal(immediateCommands.has("/status"), true);
  assert.equal(immediateCommands.has("/use"), false);
});

test("renders bounded public progress without exposing reasoning contents or mentions", () => {
  assert.deepEqual(safeProgressUpdate({
    type: "item.completed",
    item: { type: "reasoning", text: "private chain" },
  }), { kind: "activity", text: "分析阶段完成" });
  assert.equal(sanitizeProgressNote("<at user_id=\"private\">Name</at> ready"), "＠用户 ready");
  assert.equal(formatDuration(61_000), "1 分 1 秒");
});

test("builds status from an explicit runtime view instead of bridge globals", () => {
  const renderer = createStatusRenderer({
    config: { project: { name: "Project", id: "project" }, sandboxMode: "workspace-write" },
    projectContext: { effectiveSandbox: () => "workspace-write" },
    activeWorks: new Map(),
    getActiveThreadId: () => "thread",
    isChannelConnected: () => true,
    bridgeStartedAt: Date.now() - 1_000,
    getQueuedCount: () => 2,
    deliveryOutbox: { size: () => 1 },
    agentEventOutbox: { size: () => 0 },
    auditLog: { size: () => 3, headHash: () => "abcdef0123456789" },
    taskLeaseStore: { list: () => [] },
    getTemporaryChat: () => undefined,
    getLastWork: () => undefined,
    getThread: () => undefined,
  });
  const markdown = renderer.buildStatusMarkdown(undefined, { lifecycle: { type: "task_complete" } }, undefined);
  assert.match(markdown, /Channel SDK：\*\*已连接\*\*/);
  assert.match(markdown, /等待队列：2 条/);
  assert.doesNotMatch(markdown, /thread/);
});

test("retries a persisted final answer without rerunning Codex", async () => {
  const calls = [];
  const records = [{ messageId: "message", markdown: "answer", attempts: 1 }];
  const service = createOutboundDelivery({
    channel: {
      rawClient: { im: { message: { reply: async (request) => {
        calls.push(request);
        return { code: 0, data: { message_id: "reply" } };
      } } } },
    },
    deliveryOutbox: {
      list: () => records,
      remove: async (id) => calls.push(["remove", id]),
      markFailure: async () => assert.fail("delivery should not fail"),
    },
    isConnected: () => true,
    persistCompleted: async (id) => calls.push(["complete", id]),
    log: () => {},
    safeError: String,
  });

  await service.retryPendingDeliveries();
  assert.equal(calls[0].path.message_id, "message");
  assert.deepEqual(calls.slice(1), [["complete", "message"], ["remove", "message"]]);
});
