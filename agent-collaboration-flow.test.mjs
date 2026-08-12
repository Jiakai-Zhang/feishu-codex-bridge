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
const groupChatId = "oc_team";
const githubRepository = "example/shared-repository";
const requestGit = { remote: "origin", branch: "task/routing", commit: "1".repeat(40) };
const resultGit = { remote: "origin", branch: "task/routing", commit: "2".repeat(40) };
const config = (agentId) => ({
  agent: { id: agentId },
  project: { id: `${agentId}-local-project` },
  collaboration: {
    groupChatId,
    githubRepository,
    eventTtlMs: 60_000,
    maxHops: 2,
  },
});
const alicePeer = { agentId: "alice-codex", botOpenId: "ou_alice_bot", humanOpenId: "ou_alice_human" };
const localPeer = { agentId: "local-codex", botOpenId: "ou_local_bot", humanOpenId: "ou_local_human" };

function wire(event, targetConfig, authenticatedPeer) {
  return validateIncomingAgentEvent(decodeAgentEvent(encodeAgentEvent(event)), {
    config: targetConfig,
    peer: authenticatedPeer,
    chatId: groupChatId,
    now,
  });
}

function update(kind, task, payload) {
  const requesterToExecutor = kind === "task.approved";
  return createAgentEvent({
    kind,
    taskId: task.taskId,
    groupChatId: task.groupChatId,
    githubRepository: task.githubRepository,
    fromAgentId: requesterToExecutor ? task.requesterAgentId : task.executorAgentId,
    toAgentId: requesterToExecutor ? task.executorAgentId : task.requesterAgentId,
    requesterAgentId: task.requesterAgentId,
    executorAgentId: task.executorAgentId,
    payload,
  }, { now, ttlMs: 60_000 });
}

test("round-trips repository-backed work without sharing local Project or thread identities", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-agent-flow-"));
  try {
    const aliceStore = await TeamTaskStore.open(path.join(directory, "alice.json"), { now: () => now });
    const localStore = await TeamTaskStore.open(path.join(directory, "local.json"), { now: () => now });
    const request = createAgentEvent({
      kind: "task.request",
      groupChatId,
      githubRepository,
      fromAgentId: "alice-codex",
      toAgentId: "local-codex",
      requesterAgentId: "alice-codex",
      executorAgentId: "local-codex",
      payload: {
        title: "Fix routing",
        prompt: "Fix routing and run tests.",
        receiveMode: "recommend",
        resultMode: "resume",
        git: requestGit,
      },
    }, { now, ttlMs: 60_000 });
    await aliceStore.createOutboundRequest(request, {
      peer: localPeer,
      chatId: groupChatId,
      requesterHumanOpenId: "ou_alice_owner",
      sourceThreadId: "alice-thread-local-only",
      localProjectId: "alice-project",
    });

    const inboundRequest = wire(request, config("local-codex"), alicePeer);
    let localTask = (await localStore.recordInboundEvent(inboundRequest, {
      peer: alicePeer,
      chatId: groupChatId,
      localProjectId: "local-project",
    })).task;
    assert.equal(localTask.localProjectId, "local-project");
    assert.equal("sourceThreadId" in localTask, false);
    await localStore.setLandingRecommendation(localTask.taskId, { landing: "new-worktree" });
    localTask = await localStore.acceptInbound(localTask.taskId, "ou_local_owner", { landing: "new-worktree" });
    localTask = await localStore.markRunning(localTask.taskId, {
      threadId: "local-thread-local-only",
      worktree: "C:/local/worktree",
      branch: requestGit.branch,
      landing: "new-worktree",
    });

    const accepted = update("task.accepted", localTask, { message: "accepted", landing: localTask.landing });
    await aliceStore.recordInboundEvent(wire(accepted, config("alice-codex"), localPeer), {
      peer: localPeer,
      chatId: groupChatId,
      localProjectId: "alice-project",
    });
    const progress = update("task.progress", localTask, { message: "running tests" });
    await aliceStore.recordInboundEvent(wire(progress, config("alice-codex"), localPeer), {
      peer: localPeer,
      chatId: groupChatId,
      localProjectId: "alice-project",
    });

    localTask = await localStore.markCompleted(localTask.taskId, "Tests pass.", { git: resultGit });
    const result = update("task.result", localTask, { summary: localTask.result, git: localTask.resultGit });
    const aliceCompleted = (await aliceStore.recordInboundEvent(wire(result, config("alice-codex"), localPeer), {
      peer: localPeer,
      chatId: groupChatId,
      localProjectId: "alice-project",
    })).task;
    assert.equal(aliceCompleted.state, "completed");
    assert.deepEqual(aliceCompleted.resultGit, resultGit);
    assert.equal(aliceCompleted.sourceThreadId, "alice-thread-local-only");
    assert.equal("localThreadId" in aliceCompleted, false);

    const approvedTask = await aliceStore.approveOutbound(aliceCompleted.taskId, "Reviewed.", "ou_alice_owner");
    const approved = update("task.approved", approvedTask, { note: approvedTask.approvalNote });
    const localApproved = (await localStore.recordInboundEvent(wire(approved, config("local-codex"), alicePeer), {
      peer: alicePeer,
      chatId: groupChatId,
      localProjectId: "local-project",
    })).task;
    assert.equal(localApproved.state, "approved");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
