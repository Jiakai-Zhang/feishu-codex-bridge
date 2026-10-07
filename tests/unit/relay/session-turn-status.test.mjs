import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStreamCardStore } from "../../../src/feishu/session-stream-card.mjs";
import { flushSessionTurnStatus, processSessionTurnStatus } from "../../../src/relay/session-turn-status.mjs";

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "turn-status-card-"));
  try {
    const file = path.join(directory, "cards.json");
    const streamCards = await SessionStreamCardStore.open(file);
    await streamCards.start({ threadId: "thread", turnId: "turn", chatId: "chat", messageId: "original-card", createdAt: 10 });
    await run({ streamCards, file });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const record = (type) => ({ threadId: "thread", turnId: "turn", chatId: "chat", executionStatus: { type, reason: "network", updatedAtMs: 100 } });

test("retry and recovery update the same card without creating another message", async () => fixture(async ({ streamCards }) => {
  const updates = [];
  const ports = { streamCards, ensureCard: () => { throw new Error("must reuse original card"); }, updateCard: current => updates.push(current), persistTerminal: () => { throw new Error("not terminal"); } };
  await processSessionTurnStatus({ record: record("retrying"), ...ports });
  await processSessionTurnStatus({ record: record("running"), ...ports });
  assert.deepEqual(updates.map(x => x.messageId), ["original-card", "original-card"]);
  assert.equal(streamCards.get("thread", "turn").executionStatus, undefined);
  assert.equal(streamCards.list().length, 1);
}));

test("failed update remains durable across restart and is retried before cleanup", async () => fixture(async ({ streamCards, file }) => {
  await assert.rejects(processSessionTurnStatus({
    record: record("failed"), streamCards,
    ensureCard: () => { throw new Error("must reuse card"); },
    updateCard: () => { throw new Error("network down"); },
    persistTerminal: () => { throw new Error("must not mark delivered"); },
  }), /network down/);
  const reopened = await SessionStreamCardStore.open(file);
  const current = reopened.get("thread", "turn");
  assert.equal(current.executionStatus.type, "failed");
  const events = [];
  await flushSessionTurnStatus({ current, streamCards: reopened,
    updateCard: (value) => events.push(`update:${value.messageId}`),
    persistTerminal: () => events.push("delivered"),
  });
  assert.deepEqual(events, ["update:original-card", "delivered"]);
  assert.equal((await SessionStreamCardStore.open(file)).list().length, 0);
}));

test("late running status cannot revive a terminal card", async () => fixture(async ({ streamCards }) => {
  await streamCards.updateExecutionStatus("thread", "turn", { type: "failed", reason: "network" });
  const updates = [];
  await processSessionTurnStatus({ record: record("running"), streamCards,
    updateCard: current => updates.push(current.executionStatus.type), persistTerminal: () => {},
  });
  assert.deepEqual(updates, ["failed"]);
  assert.equal(streamCards.list().length, 0);
}));

test("running events do not create unsolicited cards", async () => fixture(async ({ streamCards }) => {
  await streamCards.remove("thread", "turn");
  await processSessionTurnStatus({ record: record("running"), streamCards, ensureCard: () => { throw new Error("no new card"); } });
  assert.equal(streamCards.list().length, 0);
}));

test("a missing card can be created once to show a failure", async () => fixture(async ({ streamCards }) => {
  await streamCards.remove("thread", "turn");
  let created = 0;
  const updated = [];
  await processSessionTurnStatus({ record: record("failed"), streamCards,
    ensureCard: async () => { created += 1; return streamCards.start({ threadId: "thread", turnId: "turn", chatId: "chat", messageId: "failure-card" }); },
    updateCard: current => updated.push(current.messageId), persistTerminal: () => {},
  });
  assert.equal(created, 1);
  assert.deepEqual(updated, ["failure-card"]);
}));

test("expired cards retain undelivered state but never retry or send a duplicate notification", async () => fixture(async ({ streamCards, file }) => {
  let requests = 0;
  const ports = {
    streamCards,
    updateCard: () => { requests += 1; const error = new Error("expired"); error.response = { data: { code: 230031 } }; throw error; },
    persistTerminal: () => { throw new Error("must not claim delivery"); },
  };
  await processSessionTurnStatus({ record: record("failed"), ...ports });
  const reopened = await SessionStreamCardStore.open(file);
  const current = reopened.get("thread", "turn");
  assert.equal(current.executionStatus.uneditable, true);
  assert.equal(current.executionStatus.type, "failed");
  assert.equal(await flushSessionTurnStatus({ current, ...ports }), false);
  assert.equal(requests, 1);
  assert.equal(streamCards.list().length, 1);
}));
