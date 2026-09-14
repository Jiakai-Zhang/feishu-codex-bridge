import assert from "node:assert/strict";
import test from "node:test";
import { createSessionTurnOrchestrator } from "../../../../../src/experimental/collaboration/app/session-turn-orchestrator.mjs";

test("persists a completed public group turn in shared context before delivery cleanup", async () => {
  const calls = [];
  const channel = {
    async stream(_chatId, input) {
      await input.markdown({ async setContent() {} });
      return { messageId: "om_card" };
    },
    async reply(_msg, input) { calls.push(["reply", input]); },
  };
  const orchestrator = createSessionTurnOrchestrator({
    config: {
      streamSegmentMs: 60_000,
      project: { id: "local-project", name: "Project" },
      agent: { id: "alice-codex" },
    },
    channel,
    executor: {
      type: "codex",
      async runTurn() { return "公开答案"; },
    },
    activeWorks: new Map(),
    setLastWork() {},
    updateActiveWork() {},
    deliveryOutbox: {
      async put(record) { calls.push(["outbox.put", record.markdown]); },
      async remove(messageId) { calls.push(["outbox.remove", messageId]); },
      has() { return false; },
    },
    log() {},
    async handleCommand() { return false; },
    projectContext: {
      async refresh() { return {}; },
      async validateThread() { return { id: "thread", worktree: { branch: "main" } }; },
    },
    getThread() { return { id: "thread" }; },
    async replyCommand() {},
    async audit(type) { calls.push(["audit", type]); },
    async persistCompleted(messageId) { calls.push(["completed", messageId]); },
    async retryPendingDeliveries() {},
    safeError: String,
    safeErrorCode: String,
    sharedContextJournal: {
      async appendTurn(turn) { calls.push(["context", turn]); },
    },
  });

  const ok = await orchestrator.processMessage({
    chatId: "oc_group",
    chatType: "group",
    messageId: "om_user",
    senderId: "ou_human",
  }, "共享这个问题", "thread");

  assert.equal(ok, true);
  const contextCall = calls.find(([kind]) => kind === "context");
  assert.deepEqual(contextCall[1], {
    messageId: "om_user",
    humanContent: "共享这个问题",
    agentAnswer: "公开答案",
  });
  assert.ok(calls.findIndex(([kind]) => kind === "context") < calls.findIndex(([kind]) => kind === "outbox.remove"));
});
