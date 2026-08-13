import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeliveryOutbox, deliveryIdempotencyKey } from "./delivery-outbox.mjs";

async function withOutbox(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-outbox-"));
  const file = path.join(dir, "pending.json");
  try { await callback(file); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("persists a completed answer before delivery and removes it after success", async () => {
  await withOutbox(async (file) => {
    const outbox = await DeliveryOutbox.open(file);
    await outbox.put({ messageId: "om_1", chatId: "oc_1", markdown: "answer", createdAt: 10 });
    assert.equal(outbox.size(), 1);
    const reopened = await DeliveryOutbox.open(file);
    assert.equal(reopened.list()[0].markdown, "answer");
    assert.equal(reopened.list()[0].deliveryId, "om_1");
    assert.equal(reopened.list()[0].kind, "reply");
    await reopened.remove("om_1");
    assert.equal((await DeliveryOutbox.open(file)).size(), 0);
  });
});

test("persists proactive rich-text sends under a synthetic turn delivery id", async () => {
  await withOutbox(async (file) => {
    const outbox = await DeliveryOutbox.open(file);
    await outbox.put({
      kind: "send",
      deliveryId: "codex-turn:thread-1:turn-1",
      chatId: "oc_1",
      threadId: "thread-1",
      post: { zh_cn: { title: "Codex 回复", content: [[{ tag: "text", text: "body" }]] } },
      createdAt: 20,
    });
    const record = (await DeliveryOutbox.open(file)).list()[0];
    assert.equal(record.kind, "send");
    assert.equal(record.deliveryId, "codex-turn:thread-1:turn-1");
    assert.equal(record.messageId, undefined);
    assert.equal(record.post.zh_cn.title, "Codex 回复");
  });
});

test("persists rich-text reply payloads with uploaded images", async () => {
  await withOutbox(async (file) => {
    const outbox = await DeliveryOutbox.open(file);
    await outbox.put({
      deliveryId: "om_image_reply",
      messageId: "om_image_reply",
      chatId: "oc_1",
      post: { zh_cn: { content: [[{ tag: "img", image_key: "img_answer" }]] } },
    });
    const record = (await DeliveryOutbox.open(file)).list()[0];
    assert.equal(record.kind, "reply");
    assert.equal(record.post.zh_cn.content[0][0].image_key, "img_answer");
  });
});

test("persists only reply-scoped public status delivery bypasses", async () => {
  await withOutbox(async (file) => {
    const outbox = await DeliveryOutbox.open(file);
    await outbox.put({
      deliveryId: "steer:om_1",
      messageId: "om_1",
      chatId: "oc_1",
      markdown: "steer accepted",
      publicStatus: true,
    });
    await outbox.put({
      kind: "send",
      deliveryId: "codex-turn:thread:turn",
      chatId: "oc_1",
      post: { zh_cn: { content: [[{ tag: "text", text: "answer" }]] } },
      publicStatus: true,
    });
    const [reply, send] = (await DeliveryOutbox.open(file)).list();
    assert.equal(reply.publicStatus, true);
    assert.equal(send.publicStatus, false);
  });
});

test("failed deliveries use bounded exponential backoff", async () => {
  await withOutbox(async (file) => {
    const outbox = await DeliveryOutbox.open(file);
    await outbox.put({ messageId: "om_2", chatId: "oc_1", markdown: "answer" });
    await outbox.markFailure("om_2", new Error("ECONNRESET"), { now: 1000, baseDelayMs: 100, maxDelayMs: 500 });
    assert.equal(outbox.list()[0].nextAttemptAt, 1100);
    await outbox.markFailure("om_2", new Error("again"), { now: 1100, baseDelayMs: 100, maxDelayMs: 500 });
    assert.equal(outbox.list()[0].nextAttemptAt, 1300);
    assert.equal(outbox.list({ dueAt: 1299 }).length, 0);
    assert.equal(outbox.list({ dueAt: 1300 }).length, 1);
  });
});

test("delivery retry idempotency keys are stable and within Feishu limits", () => {
  const first = deliveryIdempotencyKey("om_test_delivery_message_1234567890");
  const second = deliveryIdempotencyKey("om_test_delivery_message_1234567890");
  assert.equal(first, second);
  assert.ok(first.length <= 50);
});
