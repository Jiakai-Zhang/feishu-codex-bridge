import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentEvent } from "./agent-protocol.mjs";
import { TeamTaskStore } from "./team-task-store.mjs";

const now = 1_800_000_000_000;

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
    "task.request": { title: "Fix tests", prompt: "Fix and verify the tests.", branch: "task/tests" },
    "task.accepted": { message: "accepted" },
    "task.progress": { message: "running tests" },
    "task.result": { summary: "All tests pass.", threadId: "thread-1" },
    "task.blocked": { reason: "Need a fixture." },
    "task.rejected": { reason: "Out of scope." },
    "task.approved": { note: "Reviewed." },
  };
  return createAgentEvent({
    kind,
    taskId: overrides.taskId,
    projectId: "bridge",
    fromAgentId,
    toAgentId,
    requesterAgentId,
    executorAgentId,
    payload: payloads[kind],
  }, { now, ttlMs: 60_000 });
}

const alice = { agentId: "alice-codex", botOpenId: "ou_alice", allowedProjectIds: ["bridge"] };

test("deduplicates inbound requests and persists human acceptance", async () => fixture(async (store) => {
  const request = event("task.request");
  const first = await store.recordInboundEvent(request, { peer: alice, chatId: "oc_team" });
  assert.equal(first.task.state, "pending");
  assert.equal((await store.recordInboundEvent(request, { peer: alice, chatId: "oc_team" })).duplicate, true);
  assert.equal((await store.acceptInbound(request.taskId, "ou_owner")).state, "accepted");
  assert.equal((await store.acceptInbound(request.taskId, "ou_owner")).state, "accepted");
  assert.equal((await store.markRunning(request.taskId, { threadId: "thread-1", worktree: "C:/work", branch: "task/tests" })).state, "running");
  assert.equal((await store.markCompleted(request.taskId, "done")).state, "completed");
}));

test("tracks outbound executor progress, result, and human approval", async () => fixture(async (store) => {
  const request = event("task.request", {
    requesterAgentId: "local-codex",
    executorAgentId: "alice-codex",
  });
  await store.createOutboundRequest(request, { peer: alice, chatId: "oc_team", requesterHumanOpenId: "ou_owner" });
  assert.equal(store.get(request.taskId).requesterHumanOpenId, "ou_owner");
  const progress = event("task.progress", {
    taskId: request.taskId,
    requesterAgentId: "local-codex",
    executorAgentId: "alice-codex",
  });
  assert.equal((await store.recordInboundEvent(progress, { peer: alice, chatId: "oc_team" })).task.state, "running");
  const result = event("task.result", {
    taskId: request.taskId,
    requesterAgentId: "local-codex",
    executorAgentId: "alice-codex",
  });
  assert.equal((await store.recordInboundEvent(result, { peer: alice, chatId: "oc_team" })).task.state, "completed");
  assert.equal((await store.approveOutbound(request.taskId, "reviewed", "ou_owner")).state, "approved");
}));

test("refuses ownership changes and invalid state transitions", async () => fixture(async (store) => {
  const request = event("task.request");
  await store.recordInboundEvent(request, { peer: alice, chatId: "oc_team" });
  await assert.rejects(() => store.markCompleted(request.taskId, "skipped approval"), /cannot complete/);
  const approved = event("task.approved", { taskId: request.taskId });
  await assert.rejects(() => store.recordInboundEvent(approved, { peer: alice, chatId: "oc_team" }), /pending -> task.approved/);
  await assert.rejects(() => store.recordInboundEvent({
    ...event("task.progress", {
      taskId: request.taskId,
      requesterAgentId: "bob-codex",
      executorAgentId: "local-codex",
    }),
  }, { peer: alice, chatId: "oc_team" }), /ownership|peer identity/);
}));
