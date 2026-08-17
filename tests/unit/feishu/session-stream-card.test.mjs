import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSessionStreamCard,
  buildSessionStreamCardFollowups,
  SessionStreamCardStore,
} from "../../../src/feishu/session-stream-card.mjs";

test("reposts the final answer after updating the stream card", () => {
  const records = buildSessionStreamCardFollowups({
    kind: "reply",
    deliveryId: "final-a",
    messageId: "message-a",
    chatId: "chat-a",
    threadId: "thread-a",
    createdAt: 100,
  }, [{
    localPath: "C:\\tmp\\report.pdf",
    fileName: "report.pdf",
    fileSize: 42,
    modifiedAtMs: 10,
  }]);

  assert.equal(records.length, 2);
  assert.equal(records[0].deliveryId, "final-a");
  assert.equal(records[0].kind, "reply");
  assert.equal(records[1].kind, "file");
  assert.equal(records[1].dependsOn, "final-a");
});

test("reposts proactive final answers before native attachments", () => {
  const records = buildSessionStreamCardFollowups({
    kind: "send",
    deliveryId: "final-b",
    chatId: "chat-b",
    createdAt: 100,
  }, [{ localPath: "C:\\tmp\\result.zip", fileName: "result.zip" }]);

  assert.equal(records.length, 2);
  assert.equal(records[0].kind, "send");
  assert.equal(records[1].kind, "file");
  assert.equal(records[1].dependsOn, "final-b");
  assert.equal(records[0].messageId, undefined);
});

test("builds one updateable progress card from public commentary", () => {
  const card = buildSessionStreamCard({
    startedAtMs: 1_000,
    nowMs: 62_000,
    progress: [
      { sequence: 1, text: "正在读取配置" },
      { sequence: 2, text: "- 测试列表\n- `inline code`" },
    ],
  });

  assert.equal(card.schema, "2.0");
  assert.equal(card.config.update_multi, true);
  assert.equal(card.body.elements.length, 1);
  assert.match(card.body.elements[0].content, /正在读取配置/);
  assert.match(card.body.elements[0].content, /- 测试列表/);
  assert.match(card.body.elements[0].content, /已处理：1分1秒/);
  assert.doesNotMatch(JSON.stringify(card), /reasoning|tool output/i);
});

test("builds the queued acknowledgement as the initial stream card state", () => {
  const card = buildSessionStreamCard({
    queued: { position: 2, alreadyQueued: false },
  });

  assert.equal(card.schema, "2.0");
  assert.equal(card.body.elements.length, 1);
  assert.match(card.body.elements[0].content, /已按默认设置加入下一轮队列/);
  assert.match(card.body.elements[0].content, /当前排位：\*\*2\*\*/);
  assert.match(card.body.elements[0].content, /独立的新 Turn/);
  assert.match(card.config.summary.content, /排队中/);
});

test("preserves markdown and images when the same card becomes the final answer", () => {
  const card = buildSessionStreamCard({
    answerSegments: [
      { type: "text", text: "## 结果\n\n- 第一项\n\n```js\nconst ok = true;\n```" },
      { type: "image", imageKey: "img_test" },
    ],
    completedAtMs: Date.UTC(2026, 7, 14, 1, 2, 3),
    durationMs: 61_000,
    tokenUsage: { totalTokens: 12_345 },
    timeZone: "Asia/Shanghai",
  });

  assert.equal(card.body.elements[0].tag, "markdown");
  assert.match(card.body.elements[0].content, /## 结果/);
  assert.match(card.body.elements[0].content, /```js/);
  assert.deepEqual(card.body.elements[1], {
    tag: "img",
    img_key: "img_test",
    alt: { tag: "plain_text", content: "Codex 回复中的图片" },
  });
  assert.match(card.body.elements.at(-1).content, /12,345/);
});

test("persists one card per turn and deduplicates progress", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "session-stream-card-"));
  const filePath = path.join(directory, "cards.json");
  const store = await SessionStreamCardStore.open(filePath);

  await store.start({
    threadId: "thread-a",
    turnId: "turn-a",
    chatId: "chat-a",
    messageId: "message-a",
  });
  await store.start({
    threadId: "thread-a",
    turnId: "turn-a",
    chatId: "chat-a",
    messageId: "message-other",
  });
  await store.appendProgress("thread-a", "turn-a", { sequence: 1, text: "working" });
  await store.appendProgress("thread-a", "turn-a", { sequence: 1, text: "working" });

  const reopened = await SessionStreamCardStore.open(filePath);
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.get("thread-a", "turn-a").messageId, "message-a");
  assert.equal(reopened.get("thread-a", "turn-a").progress.length, 1);
  assert.doesNotReject(() => readFile(filePath, "utf8"));

  assert.equal(await reopened.remove("thread-a", "turn-a"), true);
  assert.equal(reopened.get("thread-a", "turn-a"), undefined);
});

test("reassigns a queued card to its real Turn without changing the Feishu message", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "session-stream-card-adopt-"));
  const filePath = path.join(directory, "cards.json");
  const store = await SessionStreamCardStore.open(filePath);
  await store.start({
    threadId: "thread-a",
    turnId: "queued:input-a",
    chatId: "chat-a",
    messageId: "card-a",
    createdAt: 100,
  });

  const adopted = await store.reassign("thread-a", "queued:input-a", "turn-a", { createdAt: 200 });
  assert.equal(adopted.messageId, "card-a");
  assert.equal(adopted.createdAt, 200);
  assert.equal(store.get("thread-a", "queued:input-a"), undefined);
  assert.equal(store.get("thread-a", "turn-a").messageId, "card-a");
});

test("routes public progress and completion through the persistent card only in turn handlers", async () => {
  const source = await readFile(new URL("../../../src/app/session-relay.mjs", import.meta.url), "utf8");
  const commandStart = source.indexOf("async function processCommandMessage");
  const progressStart = source.indexOf("async function processTurnProgress");
  const completionStart = source.indexOf("async function processCompletedTurn");
  const commandBody = source.slice(commandStart, progressStart);
  const progressBody = source.slice(progressStart, completionStart);
  const completionBody = source.slice(completionStart, source.indexOf("const channel = createLarkChannel"));

  assert.doesNotMatch(commandBody, /appendProgress|tryEnsureTurnStreamCard/);
  assert.match(progressBody, /tryEnsureTurnStreamCard/);
  assert.match(progressBody, /appendProgress/);
  assert.match(progressBody, /channel\.updateCard/);
  assert.match(completionBody, /tryCompleteTurnStreamCard/);
  assert.match(source, /onAccepted:[\s\S]*tryAdoptQueuedStreamCard/);
  assert.doesNotMatch(source, /deliveryId: `default-queue:/);
});
