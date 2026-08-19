import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionPromptQueue } from "../../../src/persistence/session-prompt-queue.mjs";

async function fixture(run, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-prompt-queue-"));
  const file = path.join(directory, "queue.json");
  try {
    const queue = await SessionPromptQueue.open(file, options);
    await run({ queue, file });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function record(messageId, text, sessionThreadId = "codex-thread") {
  return {
    messageId,
    sessionThreadId,
    chatId: "oc_group",
    feishuThreadId: "omt_topic",
    senderOpenId: "ou_member",
    text,
    createdAt: Number(messageId.replace(/\D/g, "")) || 1,
  };
}

test("persists a per-Session FIFO and supports numbered removal and clearing", async () => {
  await fixture(async ({ queue, file }) => {
    assert.equal((await queue.enqueue(record("om_1", "first"))).position, 1);
    assert.equal((await queue.enqueue(record("om_2", "second"))).position, 2);
    assert.equal((await queue.enqueue(record("om_3", "other", "other-thread"))).position, 1);
    assert.deepEqual(queue.list("codex-thread").map(({ text }) => text), ["first", "second"]);
    assert.equal(queue.list("codex-thread")[0].senderOpenId, "ou_member");

    const removed = await queue.removeAt("codex-thread", 2);
    assert.equal(removed.messageId, "om_2");
    assert.equal(await queue.clear("codex-thread"), 1);
    assert.deepEqual((await SessionPromptQueue.open(file)).list().map(({ messageId }) => messageId), ["om_3"]);
  });
});

test("rolls back a newly queued prompt when its input ledger cannot persist", async () => {
  await fixture(async ({ queue }) => {
    await assert.rejects(
      queue.enqueue(record("om_1", "first"), {
        afterPersist: async () => { throw new Error("disk full"); },
      }),
      /disk full/,
    );
    assert.equal(queue.count("codex-thread"), 0);
  });
});

test("persists and dispatches an attachment-only queued prompt", async () => {
  let dispatched;
  await fixture(async ({ queue, file }) => {
    const localPath = path.resolve(path.dirname(file), "image.png");
    await queue.enqueue({
      ...record("om_4", ""),
      attachments: [{ kind: "image", localPath, name: "image.png", size: 42 }],
    });
    const reopened = await SessionPromptQueue.open(file, {
      getController: () => ({
        startQueuedPrompt: async (input) => {
          dispatched = input;
          return { kind: "started", turnId: "turn-image", turnStatus: "inProgress" };
        },
      }),
    });
    const result = await reopened.dispatch("codex-thread");
    assert.equal(result.kind, "started");
    assert.equal(dispatched.text, "");
    assert.deepEqual(dispatched.attachments, [{
      kind: "image",
      localPath,
      name: "image.png",
      contentType: undefined,
      size: 42,
    }]);
  });
});

test("keeps a prompt queued while busy and removes it only after a new Turn is accepted", async () => {
  const calls = [];
  let busy = true;
  await fixture(async ({ queue }) => {
    await queue.enqueue(record("om_1", "first"));
    const waiting = await queue.dispatch("codex-thread");
    assert.deepEqual(waiting, { kind: "waiting", reason: "turn_active", reconciled: 0 });
    assert.equal(queue.count("codex-thread"), 1);

    busy = false;
    const started = await queue.dispatch("codex-thread");
    assert.equal(started.kind, "started");
    assert.equal(started.messageId, "om_1");
    assert.equal(queue.count("codex-thread"), 0);
    assert.deepEqual(calls, [["accepted", "om_1", "turn-new"]]);
  }, {
    getController: () => ({
      startQueuedPrompt: async ({ clientUserMessageId }) => busy
        ? { kind: "waiting", reason: "turn_active" }
        : { kind: "started", turnId: "turn-new", turnStatus: "inProgress", clientUserMessageId },
    }),
    onAccepted: async (queued, result) => calls.push(["accepted", queued.messageId, result.turnId]),
  });
});

test("restores an accepted prompt in memory when removing it from durable storage fails", async () => {
  const errors = [];
  let calls = 0;
  await fixture(async ({ queue }) => {
    await queue.enqueue(record("om_1", "first"));
    const persist = queue.persist.bind(queue);
    queue.persist = async () => { throw new Error("disk full"); };

    const deferred = await queue.dispatch("codex-thread");
    assert.equal(deferred.reason, "acceptance_remove_failed");
    assert.equal(queue.count("codex-thread"), 1);
    assert.equal(errors.length, 1);

    queue.persist = persist;
    const reconciled = await queue.dispatch("codex-thread");
    assert.equal(reconciled.kind, "empty");
    assert.equal(reconciled.reconciled, 1);
    assert.equal(queue.count("codex-thread"), 0);
  }, {
    getController: () => ({
      startQueuedPrompt: async () => (++calls === 1
        ? { kind: "started", turnId: "turn-new", turnStatus: "inProgress" }
        : { kind: "accepted", turnId: "turn-new", turnStatus: "completed" }),
    }),
    onError: (error) => errors.push(error),
  });
});

test("reconciles a completed accepted item before starting the next FIFO entry", async () => {
  const calls = [];
  await fixture(async ({ queue }) => {
    await queue.enqueue(record("om_1", "first"));
    await queue.enqueue(record("om_2", "second"));
    const result = await queue.dispatch("codex-thread");
    assert.equal(result.kind, "started");
    assert.equal(result.messageId, "om_2");
    assert.equal(result.reconciled, 1);
    assert.equal(queue.count("codex-thread"), 0);
  }, {
    getController: () => ({
      startQueuedPrompt: async ({ clientUserMessageId }) => {
        calls.push(clientUserMessageId);
        return clientUserMessageId === "om_1"
          ? { kind: "accepted", turnId: "turn-old", turnStatus: "completed" }
          : { kind: "started", turnId: "turn-new", turnStatus: "inProgress" };
      },
    }),
  });
  assert.deepEqual(calls, ["om_1", "om_2"]);
});
