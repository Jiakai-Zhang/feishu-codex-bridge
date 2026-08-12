import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentEvent,
  decodeAgentEvent,
  encodeAgentEvent,
  validateAgentEvent,
  validateIncomingAgentEvent,
} from "./agent-protocol.mjs";

const now = 1_800_000_000_000;
const git = { remote: "origin", branch: "task/routing", commit: "a".repeat(40) };
const request = () => createAgentEvent({
  kind: "task.request",
  groupChatId: "oc_team",
  githubRepository: "Example/Bridge",
  fromAgentId: "alice-codex",
  toAgentId: "local-codex",
  requesterAgentId: "alice-codex",
  executorAgentId: "local-codex",
  payload: {
    title: "Fix routing",
    prompt: "Implement and test the routing fix.",
    receiveMode: "recommend",
    resultMode: "notify",
    git,
  },
}, { now, ttlMs: 60_000 });

test("round-trips a repository-bound Agent task event", () => {
  const event = request();
  assert.deepEqual(decodeAgentEvent(encodeAgentEvent(event)), event);
  const validated = validateAgentEvent(event, { now, maxTtlMs: 60_000 });
  assert.equal(validated.githubRepository, "example/bridge");
  assert.equal(validated.payload.git.branch, "task/routing");
});

test("binds inbound identity to Bot, group, repository, and target Agent", () => {
  const config = {
    agent: { id: "local-codex" },
    collaboration: {
      groupChatId: "oc_team",
      githubRepository: "example/bridge",
      eventTtlMs: 60_000,
      maxHops: 2,
    },
  };
  const peer = { agentId: "alice-codex" };
  assert.equal(validateIncomingAgentEvent(request(), { config, peer, chatId: "oc_team", now }).fromAgentId, "alice-codex");
  assert.throws(() => validateIncomingAgentEvent({
    ...request(),
    fromAgentId: "mallory",
    requesterAgentId: "mallory",
  }, { config, peer, chatId: "oc_team", now }), /authenticated peer/);
  assert.throws(() => validateIncomingAgentEvent({ ...request(), groupChatId: "oc_other" }, {
    config, peer, chatId: "oc_other", now,
  }), /bound Feishu group/);
  assert.throws(() => validateIncomingAgentEvent({ ...request(), githubRepository: "other/repo" }, {
    config, peer, chatId: "oc_team", now,
  }), /bound GitHub repository/);
  assert.throws(() => validateIncomingAgentEvent({
    ...request(),
    toAgentId: "other",
    executorAgentId: "other",
  }, { config, peer, chatId: "oc_team", now }), /another Agent/);
});

test("rejects expired, over-hop, invalid Git, oversized, and role-confused events", () => {
  assert.throws(() => validateAgentEvent({ ...request(), expiresAt: now }, { now, maxTtlMs: 60_000 }), /expired/);
  assert.throws(() => validateAgentEvent({ ...request(), hop: 3 }, { now, maxTtlMs: 60_000, maxHops: 2 }), /hop/);
  assert.throws(() => validateAgentEvent({ ...request(), requesterAgentId: "other" }, { now, maxTtlMs: 60_000 }), /requester to executor/);
  assert.throws(() => createAgentEvent({
    ...request(),
    eventId: undefined,
    kind: "task.request",
    payload: { ...request().payload, prompt: "x".repeat(12_001) },
  }, { now, ttlMs: 60_000 }), /too long/);
  assert.throws(() => createAgentEvent({
    ...request(),
    eventId: undefined,
    kind: "task.request",
    payload: { ...request().payload, git: { ...git, branch: "../escape" } },
  }, { now, ttlMs: 60_000 }), /git\.branch/);
});

test("enforces direction for executor updates and requester approval", () => {
  const progress = createAgentEvent({
    kind: "task.progress",
    taskId: request().taskId,
    groupChatId: "oc_team",
    githubRepository: "example/bridge",
    fromAgentId: "local-codex",
    toAgentId: "alice-codex",
    requesterAgentId: "alice-codex",
    executorAgentId: "local-codex",
    payload: { message: "running tests" },
  }, { now, ttlMs: 60_000 });
  assert.equal(progress.kind, "task.progress");
  assert.throws(() => validateAgentEvent({ ...progress, fromAgentId: "alice-codex" }, { now, maxTtlMs: 60_000 }), /executor to requester/);

  const approved = createAgentEvent({
    kind: "task.approved",
    taskId: progress.taskId,
    groupChatId: "oc_team",
    githubRepository: "example/bridge",
    fromAgentId: "alice-codex",
    toAgentId: "local-codex",
    requesterAgentId: "alice-codex",
    executorAgentId: "local-codex",
    payload: { note: "reviewed" },
  }, { now, ttlMs: 60_000 });
  assert.equal(approved.kind, "task.approved");
});
