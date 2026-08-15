import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditMarkdown, buildMetricsMarkdown, parseAuditLimit } from "../../../../../src/experimental/collaboration/commands/operational-commands.mjs";

test("bounds audit queries and renders only safe audit fields", () => {
  assert.equal(parseAuditLimit(""), 20);
  assert.equal(parseAuditLimit("100"), 100);
  assert.equal(parseAuditLimit("101"), undefined);
  const markdown = buildAuditMarkdown([{
    sequence: 1,
    type: "task.accepted",
    actor: "human:ou_owner",
    timestamp: 1_800_000_000_000,
    taskId: "task:12345678",
    hash: "a".repeat(64),
    details: { secret: "must-not-render" },
  }], "a".repeat(64));
  assert.match(markdown, /task.accepted/);
  assert.doesNotMatch(markdown, /must-not-render/);
});

test("renders delivery, task, knowledge, audit, and executor metrics", () => {
  const markdown = buildMetricsMarkdown({
    channelConnected: true,
    queuedWorkCount: 2,
    deliveryOutboxSize: 1,
    agentEventOutboxSize: 3,
    teamTaskCount: 4,
    taskStates: { running: 1, pending: 3 },
    knowledgeCount: 5,
    auditCount: 6,
    auditHead: "b".repeat(64),
    taskLeaseCount: 1,
    executorType: "codex",
    executorCapabilities: { persistentThreads: true, projectCwd: true, progressUpdates: true, cancellation: false },
  });
  assert.match(markdown, /Agent 事件发件箱：3/);
  assert.match(markdown, /pending`=3/);
  assert.match(markdown, /persistentThreads/);
  assert.match(markdown, /活跃分支租约：1/);
});
