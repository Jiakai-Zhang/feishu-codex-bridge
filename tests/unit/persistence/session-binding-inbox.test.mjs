import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requestSessionBinding, SessionBindingInbox } from "../../../src/persistence/session-binding-inbox.mjs";

const threadId = "019ff5b8-decb-7ca3-802c-f115f2f196de";

test("round-trips a current-task binding request through the local inbox", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "binding-inbox-"));
  let nowMs = 1_000;
  const inbox = await new SessionBindingInbox({
    directory,
    now: () => nowMs,
    handleRequest: async ({ threadId: received }) => ({
      groupName: `Project/${received.slice(0, 8)}`,
      feedGroupName: "HOST-Codex",
      restart: true,
    }),
  }).open();
  const response = await requestSessionBinding({
    directory,
    threadId,
    now: () => nowMs,
    pollMs: 1,
    sleep: async () => { nowMs += 1; await inbox.poll(); },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.feedGroupName, "HOST-Codex");
  assert.equal(response.result.restart, true);
});

test("returns a bounded safe error to the requesting skill", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "binding-inbox-"));
  let nowMs = 1_000;
  const inbox = await new SessionBindingInbox({
    directory,
    now: () => nowMs,
    handleRequest: async () => {
      const error = new Error("Bot create scope is missing");
      error.code = "chat_create_auth_required";
      error.missingScopes = ["im:chat:create"];
      throw error;
    },
  }).open();
  const response = await requestSessionBinding({
    directory,
    threadId,
    now: () => nowMs,
    pollMs: 1,
    sleep: async () => { nowMs += 1; await inbox.poll(); },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "chat_create_auth_required");
  assert.deepEqual(response.error.missingScopes, ["im:chat:create"]);
});
