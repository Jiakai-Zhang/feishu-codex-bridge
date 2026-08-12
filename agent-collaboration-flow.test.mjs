import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentEvent,
  decodeAgentEvent,
  encodeAgentEvent,
  validateIncomingAgentEvent,
} from "./agent-protocol.mjs";
import { TeamTaskStore } from "./team-task-store.mjs";

const now = 1_800_000_000_000;
const config = (agentId) => ({
  agent: { id: agentId },
  project: { id: "bridge" },
  collaboration: { eventTtlMs: 60_000, maxHops: 2 },
});
const alicePeer = { agentId: "alice-codex", botOpenId: "ou_alice", allowedProjectIds: ["bridge"] };
const localPeer = { agentId: "local-codex", botOpenId: "ou_local", allowedProjectIds: ["bridge"] };

function wire(event, targetConfig, authenticatedPeer) {
  return validateIncomingAgentEvent(decodeAgentEvent(encodeAgentEvent(event)), {
    config: targetConfig,
    peer: authenticatedPeer,
    now,
  });
}

function update(kind, task, payload) {
  const requesterToExecutor = kind === "task.approved";
  return createAgentEvent({
    kind,
    taskId: task.taskId,
    projectId: task.projectId,
    fromAgentId: requesterToExecutor ? task.requesterAgentId : task.executorAgentId,
    toAgentId: requesterToExecutor ? task.executorAgentId : task.requesterAgentId,
    requesterAgentId: task.requesterAgentId,
    executorAgentId: task.executorAgentId,
    payload,
  }, { now, ttlMs: 60_000 });
}

test("round-trips request, human acceptance, progress, result, and approval across two Agents", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-agent-flow-"));
  try {
    const aliceStore = await TeamTaskStore.open(path.join(directory, "alice.json"), { now: () => now });
    const localStore = await TeamTaskStore.open(path.join(directory, "local.json"), { now: () => now });
    const request = createAgentEvent({
      kind: "task.request",
      projectId: "bridge",
      fromAgentId: "alice-codex",
      toAgentId: "local-codex",
      requesterAgentId: "alice-codex",
      executorAgentId: "local-codex",
      payload: { title: "Fix routing", prompt: "Fix routing and run tests.", branch: "task/routing" },
    }, { now, ttlMs: 60_000 });
    await aliceStore.createOutboundRequest(request, {
      peer: localPeer,
      chatId: "oc_team",
      requesterHumanOpenId: "ou_alice_owner",
    });
    const inboundRequest = wire(request, config("local-codex"), alicePeer);
    let localTask = (await localStore.recordInboundEvent(inboundRequest, {
      peer: alicePeer,
      chatId: "oc_team",
    })).task;
    assert.equal(localTask.state, "pending");

    localTask = await localStore.acceptInbound(localTask.taskId, "ou_local_approver");
    const accepted = update("task.accepted", localTask, { message: "accepted" });
    await aliceStore.recordInboundEvent(wire(accepted, config("alice-codex"), localPeer), {
      peer: localPeer,
      chatId: "oc_team",
    });
    localTask = await localStore.markRunning(localTask.taskId, { threadId: "thread-local" });
    const progress = update("task.progress", localTask, { message: "tests running" });
    await aliceStore.recordInboundEvent(wire(progress, config("alice-codex"), localPeer), {
      peer: localPeer,
      chatId: "oc_team",
    });
    localTask = await localStore.markCompleted(localTask.taskId, "All tests pass.");
    const result = update("task.result", localTask, { summary: localTask.result, threadId: localTask.localThreadId });
    await aliceStore.recordInboundEvent(wire(result, config("alice-codex"), localPeer), {
      peer: localPeer,
      chatId: "oc_team",
    });
    assert.equal(aliceStore.get(localTask.taskId).state, "completed");

    const aliceTask = await aliceStore.approveOutbound(localTask.taskId, "reviewed", "ou_alice_owner");
    const approved = update("task.approved", aliceTask, { note: "reviewed" });
    await localStore.recordInboundEvent(wire(approved, config("local-codex"), alicePeer), {
      peer: alicePeer,
      chatId: "oc_team",
    });
    assert.equal(aliceStore.get(localTask.taskId).state, "approved");
    assert.equal(localStore.get(localTask.taskId).state, "approved");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
