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
const request = () => createAgentEvent({
  kind: "task.request",
  projectId: "bridge",
  fromAgentId: "alice-codex",
  toAgentId: "local-codex",
  requesterAgentId: "alice-codex",
  executorAgentId: "local-codex",
  payload: { title: "Fix routing", prompt: "Implement and test the routing fix.", branch: "task/routing" },
}, { now, ttlMs: 60_000 });

test("round-trips a bounded Agent task event", () => {
  const event = request();
  assert.deepEqual(decodeAgentEvent(encodeAgentEvent(event)), event);
  assert.equal(validateAgentEvent(event, { now, maxTtlMs: 60_000 }).payload.branch, "task/routing");
});

test("binds inbound identity to the authenticated peer and Project", () => {
  const config = {
    agent: { id: "local-codex" },
    project: { id: "bridge" },
    collaboration: { eventTtlMs: 60_000, maxHops: 2 },
  };
  const peer = { agentId: "alice-codex", allowedProjectIds: ["bridge"] };
  assert.equal(validateIncomingAgentEvent(request(), { config, peer, now }).fromAgentId, "alice-codex");
  assert.throws(() => validateIncomingAgentEvent({
    ...request(),
    fromAgentId: "mallory",
    requesterAgentId: "mallory",
  }, { config, peer, now }), /authenticated peer/);
  assert.throws(() => validateIncomingAgentEvent({ ...request(), projectId: "other" }, { config, peer, now }), /Bridge Project/);
  assert.throws(() => validateIncomingAgentEvent({
    ...request(),
    toAgentId: "other",
    executorAgentId: "other",
  }, { config, peer, now }), /another Agent/);
});

test("rejects expired, over-hop, oversized, and role-confused events", () => {
  assert.throws(() => validateAgentEvent({ ...request(), expiresAt: now }, { now, maxTtlMs: 60_000 }), /expired/);
  assert.throws(() => validateAgentEvent({ ...request(), hop: 3 }, { now, maxTtlMs: 60_000, maxHops: 2 }), /hop/);
  assert.throws(() => validateAgentEvent({ ...request(), requesterAgentId: "other" }, { now, maxTtlMs: 60_000 }), /requester to executor/);
  assert.throws(() => createAgentEvent({
    ...request(),
    eventId: undefined,
    kind: "task.request",
    payload: { title: "x", prompt: "x".repeat(12_001), branch: "task/x" },
  }, { now, ttlMs: 60_000 }), /too long/);
  assert.throws(() => createAgentEvent({
    ...request(),
    eventId: undefined,
    kind: "task.request",
    payload: { title: "x", prompt: "x", branch: "../escape" },
  }, { now, ttlMs: 60_000 }), /payload.branch/);
});

test("enforces direction for executor updates and requester approval", () => {
  const progress = createAgentEvent({
    kind: "task.progress",
    taskId: request().taskId,
    projectId: "bridge",
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
    projectId: "bridge",
    fromAgentId: "alice-codex",
    toAgentId: "local-codex",
    requesterAgentId: "alice-codex",
    executorAgentId: "local-codex",
    payload: { note: "reviewed" },
  }, { now, ttlMs: 60_000 });
  assert.equal(approved.kind, "task.approved");
});
