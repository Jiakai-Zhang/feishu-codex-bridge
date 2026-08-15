import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalGitHubRepository,
  CollaborationRequestInbox,
  validateCollaborationRequest,
} from "../../../../../src/experimental/collaboration/protocol/collaboration-request-inbox.mjs";

const NOW = 1_800_000_000_000;

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: "req:123e4567-e89b-12d3-a456-426614174000",
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    source: {
      agentId: "alice-codex",
      projectId: "alice-local-project",
      groupChatId: "oc_team_alpha",
      githubRepository: "Example/Shared-Repo",
      cwd: process.cwd(),
      threadId: "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294",
      remote: "origin",
      branch: "codex/login-tests",
      head: "a".repeat(40),
    },
    action: {
      type: "delegate",
      peerAgentId: "bob-codex",
      title: "Add login tests",
      prompt: "Add focused tests and report the result.",
      receiveMode: "recommend",
      gitSyncMode: "push",
      resultMode: "notify",
    },
    ...overrides,
  };
}

test("canonicalizes HTTPS, SSH, and repository slug forms", () => {
  assert.equal(canonicalGitHubRepository("https://github.com/Org/Repo.git"), "org/repo");
  assert.equal(canonicalGitHubRepository("git@github.com:Org/Repo.git"), "org/repo");
  assert.equal(canonicalGitHubRepository("Org/Repo"), "org/repo");
  assert.throws(() => canonicalGitHubRepository("https://gitlab.com/org/repo"), /github\.com/);
  assert.throws(() => canonicalGitHubRepository("../repo"), /dot path/);
});

test("validates a Project-scoped skill delegation request", () => {
  const value = validateCollaborationRequest(request(), { now: NOW });
  assert.equal(value.source.githubRepository, "example/shared-repo");
  assert.equal(value.action.receiveMode, "recommend");
});

test("rejects expired requests and invalid Git heads", () => {
  assert.throws(() => validateCollaborationRequest(request({ expiresAt: NOW }), { now: NOW }), /expired/);
  assert.throws(() => validateCollaborationRequest(request({
    source: { ...request().source, head: "abc" },
  }), { now: NOW }), /full Git commit SHA/);
});

test("lists pending files and writes a result artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collaboration-inbox-"));
  try {
    const inbox = await CollaborationRequestInbox.open(root);
    const filePath = path.join(inbox.incomingPath, "req_123e4567-e89b-12d3-a456-426614174000.json");
    await fs.writeFile(filePath, JSON.stringify(request()), "utf8");
    const pending = await inbox.list({ now: NOW });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].request.requestId, request().requestId);
    const resultPath = await inbox.finish(filePath, request().requestId, { ok: true, status: "delivered", taskId: "task:12345678" });
    assert.equal(await inbox.finish(filePath, request().requestId, { ok: false, status: "blocked" }), resultPath);
    assert.equal((await inbox.list({ now: NOW })).length, 0);
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    assert.equal(result.status, "delivered");
    assert.equal(result.taskId, "task:12345678");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects a request whose id does not match its durable filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collaboration-inbox-id-"));
  try {
    const inbox = await CollaborationRequestInbox.open(root);
    const filePath = path.join(inbox.incomingPath, "req_ffffffff-ffff-4fff-8fff-ffffffffffff.json");
    await fs.writeFile(filePath, JSON.stringify(request()), "utf8");
    const [record] = await inbox.list({ now: NOW });
    assert.match(record.error.message, /filename/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
