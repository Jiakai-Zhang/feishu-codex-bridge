import assert from "node:assert/strict";
import test from "node:test";
import { retireTemporaryChat } from "../../../src/relay/temporary-chat-retirement.mjs";

function fixture({ archived = false, archiveError, deleteError } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      record: { threadId: "thread-temporary", status: "ended" },
      pendingPromptCount: 0,
      hasPendingDelivery: false,
      readStatus: async () => ({ status: { type: "idle" }, goal: null }),
      archiveStore: {
        has: async () => archived,
        archive: async () => {
          calls.push("archive");
          if (archiveError) throw archiveError;
        },
      },
      readThread: async () => {
        calls.push("read");
        return { id: "thread-temporary", status: { type: "idle" }, turns: [] };
      },
      deleteThread: async () => {
        calls.push("delete");
        if (deleteError) throw deleteError;
      },
      removeRecord: async () => calls.push("remove"),
    },
  };
}

test("archives before deleting an ended temporary Codex Chat", async () => {
  const { calls, options } = fixture();
  assert.equal(await retireTemporaryChat(options), true);
  assert.deepEqual(calls, ["read", "archive", "delete", "remove"]);
});

test("keeps the Codex Chat when local archiving fails", async () => {
  const { calls, options } = fixture({ archiveError: new Error("disk full") });
  await assert.rejects(() => retireTemporaryChat(options), /disk full/);
  assert.deepEqual(calls, ["read", "archive"]);
});

test("reuses an existing archive when retrying Codex deletion", async () => {
  const { calls, options } = fixture({ archived: true });
  assert.equal(await retireTemporaryChat(options), true);
  assert.deepEqual(calls, ["delete", "remove"]);
});

test("keeps the retirement record when Codex deletion fails", async () => {
  const { calls, options } = fixture({ archived: true, deleteError: new Error("offline") });
  await assert.rejects(() => retireTemporaryChat(options), /offline/);
  assert.deepEqual(calls, ["delete"]);
});

test("can retry after Codex deletion succeeds but local record removal fails", async () => {
  const { calls, options } = fixture({ archived: true });
  let removeAttempts = 0;
  options.removeRecord = async () => {
    calls.push("remove");
    removeAttempts += 1;
    if (removeAttempts === 1) throw new Error("local state unavailable");
  };

  await assert.rejects(() => retireTemporaryChat(options), /local state unavailable/);
  assert.equal(await retireTemporaryChat(options), true);
  assert.deepEqual(calls, ["delete", "remove", "delete", "remove"]);
});

test("defers retirement while work or delivery remains", async () => {
  const prompt = fixture();
  prompt.options.pendingPromptCount = 1;
  assert.equal(await retireTemporaryChat(prompt.options), false);
  assert.deepEqual(prompt.calls, []);

  const delivery = fixture();
  delivery.options.hasPendingDelivery = true;
  assert.equal(await retireTemporaryChat(delivery.options), false);
  assert.deepEqual(delivery.calls, []);
});
