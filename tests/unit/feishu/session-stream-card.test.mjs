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

test("delivers only attachments after updating the final stream card", () => {
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

  assert.equal(records.length, 1);
  assert.equal(records[0].deliveryId, "final-a:attachment:1");
  assert.equal(records[0].kind, "file");
  assert.equal(records[0].messageId, "message-a");
  assert.equal(records[0].dependsOn, "final-a");
});

test("does not repost proactive final answers with native attachments", () => {
  const records = buildSessionStreamCardFollowups({
    kind: "send",
    deliveryId: "final-b",
    chatId: "chat-b",
    createdAt: 100,
  }, [{ localPath: "C:\\tmp\\result.zip", fileName: "result.zip" }]);

  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "file");
  assert.equal(records[0].dependsOn, "final-b");
  assert.equal(records[0].messageId, undefined);
});

test("successful final cards produce no extra answer or completion reminder", () => {
  for (const kind of ["reply", "send"]) {
    const base = { kind, deliveryId: "final", text: "answer", chatId: "chat-a" };
    assert.deepEqual(buildSessionStreamCardFollowups(base, []), []);
    assert.deepEqual(buildSessionStreamCardFollowups(base), []);
  }
});

test("final card followups preserve image, video and file delivery order", () => {
  const records = buildSessionStreamCardFollowups({
    kind: "reply", deliveryId: "final", messageId: "message-a", chatId: "chat-a", createdAt: 100,
  }, [
    { localPath: "C:\\tmp\\image.png", mediaType: "image" },
    { localPath: "C:\\tmp\\video.mp4", mediaType: "video" },
    { localPath: "C:\\tmp\\report.pdf", mediaType: "file" },
  ]);
  assert.deepEqual(records.map(record => record.mediaType), ["image", "video", "file"]);
  assert.deepEqual(records.map(record => record.deliveryId), [
    "final:attachment:1", "final:attachment:2", "final:attachment:3",
  ]);
  assert.deepEqual(records.map(record => record.createdAt), [101, 102, 103]);
  assert.ok(records.every(record => record.kind === "file" && record.messageId === "message-a"));
});

test("final card completion persists deduplication only after durable attachment delivery", async () => {
  const source = await readFile(new URL("../../../src/app/session-relay.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function tryFinalizeTurnStreamCard(");
  const end = source.indexOf("async function enqueuePromptMessage(", start);
  assert.ok(start >= 0 && end > start);
  const createHandler = new Function(
    "streamCards", "channelConnectivity", "channel", "buildSessionStreamCard", "config",
    "log", "safeError", "tryEnsureTurnStreamCard", "buildSessionStreamCardFollowups",
    "queueDeliveryBundle", "persistCompleted",
    `${source.slice(start, end)}\nreturn tryCompleteTurnStreamCard;`,
  );
  const record = { threadId: "thread-a", turnId: "turn-a", answer: "answer" };
  const delivery = { kind: "reply", deliveryId: "final", chatId: "chat-a" };
  for (const scenario of ["success", "attachments", "failed-update", "missing-card", "offline", "failed-outbox"]) {
    const events = [];
    const followups = [];
    const handler = createHandler(
      {
        get: () => scenario === "missing-card" ? undefined : { messageId: "card-a" },
        remove: async () => events.push("removed"),
      },
      { connected: scenario !== "offline" },
      { updateCard: async () => {
        events.push("updated");
        if (scenario === "failed-update") throw new Error("card unavailable");
      } },
      buildSessionStreamCard,
      { sessionRelay: { displayTimeZone: "Asia/Shanghai" }, maxReplyChars: 5000 },
      () => {}, () => "card unavailable", async () => undefined,
      buildSessionStreamCardFollowups,
      async records => {
        if (scenario === "failed-outbox") throw new Error("outbox unavailable");
        followups.push(...records);
        events.push("durable-followups");
      },
      async id => {
        assert.equal(id, "final");
        events.push("completed");
      },
    );
    const media = {
      segments: [{ type: "text", text: "answer" }],
      attachments: scenario === "attachments" ? [{ localPath: "C:\\tmp\\report.pdf" }] : [],
    };
    if (scenario === "failed-outbox") {
      await assert.rejects(handler(record, delivery, media), /outbox unavailable/);
      assert.deepEqual(events, ["updated"]);
    } else {
      const succeeded = scenario === "success" || scenario === "attachments";
      assert.equal(await handler(record, delivery, media), succeeded, scenario);
      assert.deepEqual(events, succeeded
        ? ["updated", "durable-followups", "completed", "removed"]
        : scenario === "failed-update" ? ["updated"] : [], scenario);
    }
    assert.equal(followups.length, scenario === "attachments" ? 1 : 0, scenario);
    assert.ok(followups.every(item => item.kind === "file"));
  }
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

test("unwraps heartbeat XML when a progress card becomes the final answer", () => {
  const heartbeat = [
    "<heartbeat>",
    "<automation_id>p1118-live</automation_id>",
    "<decision>NOTIFY</decision>",
    "<message>J418 已完成检查，下一步继续 refinement。</message>",
    "</heartbeat>",
  ].join("\n");
  const card = buildSessionStreamCard({
    answer: heartbeat,
    answerSegments: [{ type: "text", text: heartbeat }],
    heartbeatSchedule: "每 10 分钟",
  });

  assert.equal(card.body.elements[0].content, "J418 已完成检查，下一步继续 refinement。");
  assert.equal(
    card.body.elements.at(-1).content,
    "*定时任务 · 类型：Heartbeat · ID：p1118-live · 间隔：每 10 分钟 · 本轮：需要提醒*",
  );
  assert.doesNotMatch(JSON.stringify(card), /<heartbeat>|automation_id|<decision>|<message>/);
  assert.equal(card.config.summary.content, "J418 已完成检查，下一步继续 refinement。");
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
  assert.match(completionBody, /tryCompleteTurnStreamCard\(record, delivery, media, heartbeatSchedule\)/);
  assert.match(source, /onAccepted:[\s\S]*tryEnsureTurnStreamCard/);
});

test("refreshes the active stream-card clock every three seconds without racing turn output", async () => {
  const source = await readFile(new URL("../../../src/app/session-relay.mjs", import.meta.url), "utf8");

  assert.match(source, /const STREAM_CARD_CLOCK_REFRESH_MS = 3_000;/);
  assert.match(source, /setInterval\(refreshActiveStreamCardClocks, STREAM_CARD_CLOCK_REFRESH_MS\)/);
  assert.match(source, /enqueueTurnOutput\(record\.threadId,[\s\S]*status\?\.activeTurnId !== current\.turnId/);
  assert.match(source, /progress: current\.progress,[\s\S]*startedAtMs: current\.createdAt,[\s\S]*nowMs: Date\.now\(\)/);
  assert.match(source, /record\.turnId\.startsWith\("queued:"\)/);
  assert.match(source, /clearInterval\(streamCardClockTimer\)/);
});
