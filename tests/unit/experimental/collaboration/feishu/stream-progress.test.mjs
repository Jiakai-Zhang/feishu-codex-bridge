import assert from "node:assert/strict";
import test from "node:test";
import { buildMarkdownCard, streamCodexInSingleMessage } from "../../../../../src/experimental/collaboration/feishu/stream-progress.mjs";

function createHarness({
  failPatch = false,
  failReply = false,
  finishNatively = false,
  heartbeatIntervalMs = 30_000,
  streamWindowMs = 5,
  resolveAtMs,
} = {}) {
  const setContents = [];
  const patches = [];
  const replies = [];
  const readyAnswers = [];
  let streamCalls = 0;
  let clock = 0;
  let resolveAnswer;
  const delayedAnswer = new Promise((resolve) => { resolveAnswer = resolve; });

  const channel = {
    async stream(_chatId, input) {
      streamCalls += 1;
      await input.markdown({
        messageId: "om_card",
        async setContent(markdown) { setContents.push(markdown); },
      });
      return { messageId: "om_card" };
    },
    async updateCard(messageId, card) {
      patches.push({ messageId, card });
      if (patches.length === 1 && !finishNatively && resolveAtMs === undefined) resolveAnswer("最终答案");
      if (failPatch) throw new Error("patch rejected");
    },
    async reply(_msg, input) {
      replies.push(input);
      if (failReply) throw new Error("reply timed out");
    },
  };

  const askCodex = async (_content, onProgress) => {
    onProgress({ kind: "activity", text: "已经开始执行" });
    if (finishNatively) return "原生流式内完成";
    return delayedAnswer;
  };

  const run = () => streamCodexInSingleMessage({
    channel,
    msg: { chatId: "oc_chat", messageId: "om_user" },
    content: "测试",
    askCodex,
    onAnswerReady: async (answer) => { readyAnswers.push(answer); },
    streamWindowMs,
    heartbeatIntervalMs,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
      if (resolveAtMs !== undefined && clock >= resolveAtMs) resolveAnswer("最终答案");
    },
  });

  return { run, setContents, patches, replies, readyAnswers, get streamCalls() { return streamCalls; } };
}

test("buildMarkdownCard creates a non-streaming CardKit 2.0 card", () => {
  const card = buildMarkdownCard("hello");
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.streaming_mode, undefined);
  assert.equal(card.body.elements[0].content, "hello");
});

test("a long task switches to updates on the original streamed message", async () => {
  const harness = createHarness();
  const answer = await harness.run();

  assert.equal(answer, "最终答案");
  assert.equal(harness.streamCalls, 1);
  assert.equal(harness.patches.length, 2);
  assert.deepEqual(harness.patches.map((entry) => entry.messageId), ["om_card", "om_card"]);
  assert.equal(harness.replies.length, 0);
  assert.match(harness.patches.at(-1).card.body.elements[0].content, /最终答案/);
});

test("a same-message patch failure sends only the final fallback reply", async () => {
  const harness = createHarness({ failPatch: true });
  const answer = await harness.run();

  assert.equal(answer, "最终答案");
  assert.equal(harness.streamCalls, 1);
  assert.equal(harness.patches.length, 1);
  assert.deepEqual(harness.replies, [{ markdown: "最终答案" }]);
  assert.deepEqual(harness.readyAnswers, ["最终答案"]);
});

test("persists the answer before a fallback reply times out", async () => {
  const harness = createHarness({ failPatch: true, failReply: true });
  await assert.rejects(harness.run(), /reply timed out/);
  assert.deepEqual(harness.readyAnswers, ["最终答案"]);
});

test("a short task completes in the native stream without patching", async () => {
  const harness = createHarness({ finishNatively: true });
  const answer = await harness.run();

  assert.equal(answer, "原生流式内完成");
  assert.equal(harness.streamCalls, 1);
  assert.equal(harness.patches.length, 0);
  assert.equal(harness.replies.length, 0);
  assert.match(harness.setContents.at(-1), /原生流式内完成/);
});

test("an active native stream refreshes elapsed time without model output", async () => {
  const harness = createHarness({
    heartbeatIntervalMs: 30_000,
    streamWindowMs: 100_000,
    resolveAtMs: 95_000,
  });
  await harness.run();

  assert.ok(harness.setContents.some((markdown) => /已用时 30 秒/.test(markdown)));
  assert.ok(harness.setContents.some((markdown) => /已用时 60 秒/.test(markdown)));
  assert.equal(harness.patches.length, 0);
});
