import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentEvent } from "./agent-protocol.mjs";
import { TeamTaskStore } from "./team-task-store.mjs";

const now = 1_800_000_000_000;
const groupChatId = "oc_team";
const githubRepository = "example/shared-repository";
const initialGit = {
  remote: "origin",
  branch: "task/tests",
  commit: "1".repeat(40),
};
const resultGit = {
  remote: "origin",
  branch: "task/tests",
  commit: "2".repeat(40),
};

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-team-tasks-"));
  try { await run(await TeamTaskStore.open(path.join(directory, "tasks.json"), { now: () => now })); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function event(kind, overrides = {}) {
  const requesterAgentId = overrides.requesterAgentId || "alice-codex";
  const executorAgentId = overrides.executorAgentId || "local-codex";
  const fromAgentId = kind === "task.request" || kind === "task.approved" ? requesterAgentId : executorAgentId;
  const toAgentId = fromAgentId === requesterAgentId ? executorAgentId : requesterAgentId;
  const payloads = {
    "task.request": {
      title: "Fix tests",
      prompt: "Fix and verify the tests.",
      receiveMode: "recommend",
      resultMode: "resume",
      git: initialGit,
    },
    "task.accepted": { message: "accepted", landing: "existing-thread" },
    "task.progress": { message: "running tests" },
    "task.result": { summary: "All tests pass.", git: resultGit },
    "task.blocked": { reason: "Need a fixture." },
    "task.rejected": { reason: "Out of scope." },
    "task.approved": { note: "Reviewed." },
  };
  return createAgentEvent({
    kind,
    taskId: overrides.taskId,
    groupChatId,
    githubRepository,
    fromAgentId,
    toAgentId,
    requesterAgentId,
    executorAgentId,
    payload: overrides.payload || payloads[kind],
  }, { now, ttlMs: 60_000 });
}

const alice = {
  agentId: "alice-codex",
  botOpenId: "ou_alice_bot",
  humanOpenId: "ou_alice_human",
};

test("deduplicates inbound requests and persists landing and local execution state", async () => fixture(async (store) => {
  const request = event("task.request");
  const first = await store.recordInboundEvent(request, {
    peer: alice,
    chatId: groupChatId,
    localProjectId: "local-project",
  });
  assert.equal(first.task.state, "pending");
  assert.equal(first.task.localProjectId, "local-project");
  assert.equal(first.task.githubRepository, githubRepository);
  assert.equal((await store.recordInboundEvent(request, {
    peer: alice,
    chatId: groupChatId,
    localProjectId: "local-project",
  })).duplicate, true);

  await store.setLandingRecommendation(request.taskId, {
    landing: "existing-thread",
    threadId: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
  });
  assert.equal((await store.acceptInbound(request.taskId, "ou_owner", {
    landing: "existing-thread",
    targetThreadId: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
  })).state, "accepted");
  assert.equal((await store.markRunning(request.taskId, {
    threadId: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
    worktree: "C:/work",
    branch: "task/tests",
    landing: "existing-thread",
  })).state, "running");
  const completed = await store.markCompleted(request.taskId, "done", { git: resultGit });
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.resultGit, resultGit);
}));

test("tracks outbound executor progress, Git result, and human approval", async () => fixture(async (store) => {
  const request = event("task.request", {
    requesterAgentId: "local-codex",
    executorAgentId: "alice-codex",
  });
  await store.createOutboundRequest(request, {
    peer: alice,
    chatId: groupChatId,
    requesterHumanOpenId: "ou_owner",
    sourceThreadId: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
    localProjectId: "local-project",
  });
  assert.equal(store.get(request.taskId).requesterHumanOpenId, "ou_owner");
  assert.equal(store.get(request.taskId).sourceThreadId, "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294");
  const progress = event("task.progress", {
    taskId: request.taskId,
    requesterAgentId: "local-codex",
    executorAgentId: "alice-codex",
  });
  assert.equal((await store.recordInboundEvent(progress, {
    peer: alice,
    chatId: groupChatId,
    localProjectId: "local-project",
  })).task.state, "running");
  const result = event("task.result", {
    taskId: request.taskId,
    requesterAgentId: "local-codex",
    executorAgentId: "alice-codex",
  });
  const completed = (await store.recordInboundEvent(result, {
    peer: alice,
    chatId: groupChatId,
    localProjectId: "local-project",
  })).task;
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.resultGit, resultGit);
  assert.equal((await store.approveOutbound(request.taskId, "reviewed", "ou_owner")).state, "approved");
}));

test("refuses group, repository, ownership, and state changes", async () => fixture(async (store) => {
  const request = event("task.request");
  await store.recordInboundEvent(request, { peer: alice, chatId: groupChatId, localProjectId: "local-project" });
  await assert.rejects(() => store.markCompleted(request.taskId, "skipped approval"), /cannot complete/);
  const approved = event("task.approved", { taskId: request.taskId });
  await assert.rejects(
    () => store.recordInboundEvent(approved, { peer: alice, chatId: groupChatId, localProjectId: "local-project" }),
    /pending -> task.approved/,
  );
  const changedOwnership = event("task.progress", {
    taskId: request.taskId,
    requesterAgentId: "bob-codex",
    executorAgentId: "local-codex",
  });
  await assert.rejects(
    () => store.recordInboundEvent(changedOwnership, { peer: alice, chatId: groupChatId, localProjectId: "local-project" }),
    /ownership|peer identity/,
  );
  await assert.rejects(
    () => store.recordInboundEvent(event("task.progress", { taskId: request.taskId }), {
      peer: alice,
      chatId: "oc_other",
      localProjectId: "local-project",
    }),
    /chat/,
  );
}));

test("migrates legacy schema without treating remote Project IDs as authority", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-team-tasks-v1-"));
  const filePath = path.join(directory, "tasks.json");
  try {
    await fs.writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        taskId: "task:12345678",
        projectId: "remote-project",
        chatId: groupChatId,
        branch: "task/legacy",
        updatedAt: now,
      }],
      seenEventIds: [],
    }), "utf8");
    const store = await TeamTaskStore.open(filePath, { now: () => now });
    assert.equal(store.get("task:12345678").legacyProjectId, "remote-project");
    assert.equal(store.get("task:12345678").projectId, "remote-project");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
