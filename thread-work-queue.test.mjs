import assert from "node:assert/strict";
import test from "node:test";
import { ThreadWorkQueue } from "./thread-work-queue.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("messages in the same Codex task stay sequential", async () => {
  const queue = new ThreadWorkQueue();
  const gate = deferred();
  const events = [];
  const first = queue.enqueue("thread-a", async () => {
    events.push("first-start");
    await gate.promise;
    events.push("first-end");
  });
  const second = queue.enqueue("thread-a", async () => { events.push("second"); });

  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  assert.equal(queue.queuedCount, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("different Codex tasks run concurrently", async () => {
  const queue = new ThreadWorkQueue();
  const firstGate = deferred();
  const events = [];
  const first = queue.enqueue("original", async () => {
    events.push("original-start");
    await firstGate.promise;
    events.push("original-end");
  });
  const chat = queue.enqueue("temporary-chat", async () => { events.push("chat-done"); });

  await chat;
  assert.deepEqual(events, ["original-start", "chat-done"]);
  firstGate.resolve();
  await first;
});
