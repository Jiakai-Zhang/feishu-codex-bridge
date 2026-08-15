import assert from "node:assert/strict";
import test from "node:test";
import { SessionBindingRemover } from "../../../src/relay/session-binding-remover.mjs";

const binding = Object.freeze({
  groupChatId: "oc_session",
  threadId: "019ff5b8-decb-7ca3-802c-f115f2f196de",
  ownerOpenId: "ou_owner",
});

test("removes the Feed label before deleting the exact local binding", async () => {
  const calls = [];
  const remover = new SessionBindingRemover({
    registry: {
      list: async () => [binding],
      remove: async (value) => { calls.push(["binding", value.groupChatId]); return value; },
    },
    feedGroupManager: {
      removeChat: async (chatId) => { calls.push(["tag", chatId]); },
      restoreChat: async () => { calls.push(["restore"]); },
    },
    getStatus: async () => ({ status: { type: "idle" }, goal: { status: "paused" } }),
  });

  const result = await remover.remove(binding);

  assert.deepEqual(calls, [["tag", "oc_session"], ["binding", "oc_session"]]);
  assert.equal(result.tagRemoved, true);
});

test("preserves the binding while the task or Goal is active", async () => {
  let changed = false;
  const remover = new SessionBindingRemover({
    registry: {
      list: async () => [binding],
      remove: async () => { changed = true; },
    },
    feedGroupManager: {
      removeChat: async () => { changed = true; },
    },
    getStatus: async () => ({ status: { type: "active" } }),
  });

  await assert.rejects(
    remover.remove(binding),
    (error) => error?.code === "binding_delete_busy",
  );
  assert.equal(changed, false);
});

test("preserves the binding while the Session has queued prompts", async () => {
  let changed = false;
  const remover = new SessionBindingRemover({
    registry: {
      list: async () => [binding],
      remove: async () => { changed = true; },
    },
    feedGroupManager: {
      removeChat: async () => { changed = true; },
    },
    getStatus: async () => ({ status: { type: "idle" } }),
    getPendingQueueCount: async () => 2,
  });

  await assert.rejects(
    remover.remove(binding),
    (error) => error?.code === "binding_delete_queued",
  );
  assert.equal(changed, false);
});

test("restores the Feed label when local binding persistence fails", async () => {
  const calls = [];
  const remover = new SessionBindingRemover({
    registry: {
      list: async () => [binding],
      remove: async () => { calls.push("binding"); throw new Error("disk full"); },
    },
    feedGroupManager: {
      removeChat: async () => { calls.push("tag"); },
      restoreChat: async () => { calls.push("restore"); },
    },
    getStatus: async () => ({ status: { type: "idle" } }),
  });

  await assert.rejects(
    remover.remove(binding),
    (error) => error?.code === "binding_remove_failed",
  );
  assert.deepEqual(calls, ["tag", "binding", "restore"]);
});

test("restores the Feed label when a turn starts during label removal", async () => {
  const calls = [];
  let statusReads = 0;
  const remover = new SessionBindingRemover({
    registry: {
      list: async () => [binding],
      remove: async () => { calls.push("binding"); },
    },
    feedGroupManager: {
      removeChat: async () => { calls.push("tag"); },
      restoreChat: async () => { calls.push("restore"); },
    },
    getStatus: async () => ({
      status: { type: statusReads++ === 0 ? "idle" : "active" },
    }),
  });

  await assert.rejects(
    remover.remove(binding),
    (error) => error?.code === "binding_delete_busy",
  );
  assert.deepEqual(calls, ["tag", "restore"]);
});
