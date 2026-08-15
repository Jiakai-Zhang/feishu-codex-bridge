import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExternalTurnPost,
  buildFinalAnswerReplyPost,
  buildGoalTurnPost,
  buildSessionProgressPost,
  CodexSessionObserver,
  CodexTurnCollector,
  externalTurnDeliveryId,
  promptInputSource,
  quoteMarkdown,
  stripCodexDesktopFileContext,
  userPromptDetailsFromItem,
  userPromptFromItem,
} from "../../../src/codex/codex-session-observer.mjs";

const target = { threadId: "thread-id", chatId: "oc_group", cwd: "C:/repo" };

function userItem(clientId, text = "Desktop prompt") {
  return {
    id: `user-${clientId}`,
    type: "userMessage",
    clientId,
    content: [{ type: "text", text }],
  };
}

function usageBreakdown({ inputTokens, outputTokens, totalTokens }) {
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens,
  };
}

test("extracts text and safe attachment labels from a user message", () => {
  const item = {
    type: "userMessage",
    content: [
      { type: "text", text: "check this" },
      { type: "localImage", path: "C:/secret/screenshot.png" },
      { type: "mention", name: "report.pdf", path: "C:/secret/report.pdf" },
      { type: "skill", name: "review" },
    ],
  };
  assert.equal(userPromptFromItem(item), "check this\n📎 附件：report.pdf\n[Skill：review]");
  assert.equal(userPromptFromItem(item).includes("C:/secret"), false);
  const details = userPromptDetailsFromItem(item);
  assert.deepEqual(details.resources.map(({ type, source, name }) => ({ type, source, name })), [
    { type: "image", source: "local", name: "screenshot.png" },
    { type: "attachment", source: "local", name: "report.pdf" },
  ]);
  assert.equal(quoteMarkdown("first\n\n- second"), "> first\n>  \n> - second");
  assert.equal(promptInputSource("om_message"), "feishu");
  assert.equal(promptInputSource("desktop-client"), "codex");
});

test("removes the exact Codex Desktop file wrapper while keeping image delivery metadata", () => {
  const item = {
    type: "userMessage",
    content: [
      {
        type: "text",
        text: [
          "",
          "# Files mentioned by the user:",
          "",
          "## screenshot.png: C:/secret/screenshot.png",
          "",
          "## My request for Codex:",
          "check this",
        ].join("\n"),
      },
      { type: "localImage", path: "C:/secret/screenshot.png" },
    ],
  };

  const details = userPromptDetailsFromItem(item);
  assert.equal(details.text, "check this");
  assert.equal(details.text.includes("Files mentioned by the user"), false);
  assert.equal(details.text.includes("C:/secret"), false);
  assert.deepEqual(details.resources, [{
    type: "image",
    source: "local",
    path: "C:/secret/screenshot.png",
    name: "screenshot.png",
  }]);
});

test("removes an exact Desktop wrapper without a separate input item and keeps lookalikes", () => {
  const wrapper = [
    "# Files mentioned by the user:",
    "",
    "## screenshot.png: C:/secret/screenshot.png",
    "",
    "## My request:",
    "check this",
  ].join("\n");
  const lookalike = [
    "# Files mentioned by the user:",
    "this is user-authored prose",
    "## My request:",
    "keep all of it",
  ].join("\n");

  assert.equal(stripCodexDesktopFileContext(wrapper), "check this");
  assert.equal(stripCodexDesktopFileContext(lookalike, { hasResources: true }), lookalike);
});

test("extracts an ordinary file from the Desktop wrapper without exposing its local path", () => {
  const item = {
    type: "userMessage",
    content: [{
      type: "text",
      text: [
        "",
        "# Files mentioned by the user:",
        "",
        "## workbook.xlsx: C:/private/cache/workbook.xlsx",
        "",
        "## My request for Codex:",
        "读取工作表",
      ].join("\n"),
      text_elements: [],
    }],
  };

  const details = userPromptDetailsFromItem(item);
  assert.equal(details.text, "读取工作表\n📎 附件：workbook.xlsx");
  assert.equal(details.text.includes("C:/private"), false);
  assert.deepEqual(details.resources, [{
    type: "attachment",
    source: "local",
    path: "C:/private/cache/workbook.xlsx",
    name: "workbook.xlsx",
  }]);
});

test("builds a titled rich-text post with prompt, send time, and final answer", () => {
  const post = buildExternalTurnPost({
    prompt: "What changed?",
    answer: "- one\n- two",
    uploadedImages: [{ imageKey: "img_test", name: "screenshot.png" }],
    promptAtMs: Date.UTC(2026, 7, 13, 4, 5, 6),
    completedAtMs: Date.UTC(2026, 7, 13, 4, 7, 8),
    durationMs: 122_000,
    tokenUsage: usageBreakdown({ inputTokens: 10_000, outputTokens: 2_345, totalTokens: 12_345 }),
    timeZone: "Asia/Shanghai",
  });
  assert.equal(post.zh_cn.title, "Codex 回复");
  assert.equal(post.zh_cn.content[0][0].text, "#### 对应 Prompt");
  assert.equal(post.zh_cn.content[1][0].text, "> What changed?");
  assert.deepEqual(post.zh_cn.content[2][0], { tag: "img", image_key: "img_test" });
  assert.match(post.zh_cn.content[3][0].text, /2026.*08.*13.*12.*05.*06/);
  assert.deepEqual(post.zh_cn.content[3][0].style, ["italic"]);
  assert.equal(post.zh_cn.content[4][0].tag, "hr");
  assert.equal(post.zh_cn.content[5][0].text, "#### 最终回答");
  assert.equal(post.zh_cn.content[6][0].text, "> - one\n> - two");
  assert.equal(post.zh_cn.content[7][0].tag, "hr");
  assert.match(post.zh_cn.content[8][0].text, /2026.*08.*13.*12.*07.*08/);
  assert.match(post.zh_cn.content[8][0].text, /2分02秒/);
  assert.match(post.zh_cn.content[8][0].text, /12,345/);
  assert.deepEqual(post.zh_cn.content[8][0].style, ["italic"]);
  assert.equal(externalTurnDeliveryId("thread-id", "turn-id"), "codex-turn:thread-id:turn-id");
});

test("renders uploaded final-answer images in place without exposing local paths", () => {
  const answerSegments = [
    { type: "text", text: "before" },
    { type: "image", imageKey: "img_answer" },
    { type: "text", text: "after" },
  ];
  const reply = buildFinalAnswerReplyPost({ answerSegments });
  assert.deepEqual(reply.zh_cn.content, [
    [{ tag: "md", text: "before" }],
    [{ tag: "img", image_key: "img_answer" }],
    [{ tag: "md", text: "after" }],
  ]);

  const proactive = buildExternalTurnPost({
    prompt: "show image",
    answerSegments,
    promptAtMs: Date.UTC(2026, 7, 13, 4, 5, 6),
  });
  const serialized = JSON.stringify(proactive);
  assert.ok(serialized.indexOf("before") < serialized.indexOf("img_answer"));
  assert.ok(serialized.indexOf("img_answer") < serialized.indexOf("after"));
  assert.equal(serialized.includes("C:/"), false);
});

test("mentions the owner only in final Turn posts when enabled", () => {
  const compact = buildFinalAnswerReplyPost({
    answer: "done",
    mentionOpenId: "ou_owner",
  });
  assert.deepEqual(compact.zh_cn.content[0], [{ tag: "at", user_id: "ou_owner" }]);

  const proactive = buildExternalTurnPost({
    prompt: "run it",
    answer: "done",
    promptAtMs: Date.UTC(2026, 7, 13, 4, 5, 6),
    mentionOpenId: "ou_owner",
  });
  assert.equal(JSON.stringify(proactive).match(/\"tag\":\"at\"/g)?.length, 1);

  const goal = buildGoalTurnPost({
    goal: { objective: "finish", status: "complete" },
    answer: "done",
    mentionOpenId: "ou_owner",
  });
  assert.equal(JSON.stringify(goal).match(/\"tag\":\"at\"/g)?.length, 1);

  const disabled = buildFinalAnswerReplyPost({ answer: "done" });
  assert.equal(JSON.stringify(disabled).includes('"tag":"at"'), false);

  const progress = buildSessionProgressPost({ text: "working", sequence: 1 });
  assert.equal(JSON.stringify(progress).includes('"tag":"at"'), false);
});

test("renders image-only and multi-image prompts without textual file labels", () => {
  const post = buildExternalTurnPost({
    prompt: "",
    answer: "done",
    uploadedImages: [
      { imageKey: "img_one", name: "one.png" },
      { imageKey: "img_two", name: "two.png" },
    ],
    hasPromptResources: true,
    promptAtMs: Date.UTC(2026, 7, 13, 4, 5, 6),
  });

  assert.equal(post.zh_cn.content[0][0].text, "#### 对应 Prompt");
  assert.deepEqual(post.zh_cn.content[1][0], { tag: "img", image_key: "img_one" });
  assert.deepEqual(post.zh_cn.content[2][0], { tag: "img", image_key: "img_two" });
  assert.equal(JSON.stringify(post).includes("one.png"), false);
  assert.equal(JSON.stringify(post).includes("two.png"), false);
});

test("renders every in-turn adjustment in order with its own label and time", () => {
  const post = buildExternalTurnPost({
    promptEntries: [
      {
        text: "initial request",
        uploadedImages: [{ imageKey: "img_initial", name: "initial.png" }],
        promptAtMs: Date.UTC(2026, 7, 13, 4, 5, 6),
        hasPromptResources: true,
      },
      {
        text: "first adjustment",
        uploadedImages: [],
        promptAtMs: Date.UTC(2026, 7, 13, 4, 6, 7),
        hasPromptResources: false,
      },
      {
        text: "second adjustment",
        uploadedImages: [],
        promptAtMs: Date.UTC(2026, 7, 13, 4, 7, 8),
        hasPromptResources: false,
      },
    ],
    answer: "done",
    timeZone: "Asia/Shanghai",
  });
  const serialized = JSON.stringify(post);

  assert.match(serialized, /初始 Prompt/);
  assert.match(serialized, /初始 Prompt.*Codex/);
  assert.match(serialized, /调整方向 1/);
  assert.match(serialized, /调整方向 2/);
  assert.ok(serialized.indexOf("initial request") < serialized.indexOf("img_initial"));
  assert.ok(serialized.indexOf("img_initial") < serialized.indexOf("first adjustment"));
  assert.ok(serialized.indexOf("first adjustment") < serialized.indexOf("second adjustment"));
  assert.match(serialized, /发送时间/);
  assert.equal((serialized.match(/调整时间/g) || []).length, 2);
  assert.equal(serialized.includes("initial.png"), false);
});

test("builds a Goal progress post without exposing reasoning or tool events", () => {
  const post = buildGoalTurnPost({
    goal: {
      objective: "finish the bridge",
      status: "complete",
      tokenBudget: 20_000,
      tokensUsed: 12_345,
    },
    answer: "- tests passed\n- ready",
  });
  assert.equal(post.zh_cn.title, "Codex Goal 已完成");
  const serialized = JSON.stringify(post);
  assert.match(serialized, /finish the bridge/);
  assert.match(serialized, /最终结果/);
  assert.match(serialized, /tests passed/);
  assert.match(serialized, /12,345/);
});

test("formats public commentary as numbered progress with only a timestamp footer", () => {
  const post = buildSessionProgressPost({
    text: "正在检查测试结果。",
    sequence: 3,
    createdAtMs: Date.UTC(2026, 7, 13, 4, 5, 6),
    timeZone: "Asia/Shanghai",
  });
  assert.equal(post.zh_cn.title, "Codex 公开进度 #3");
  const serialized = JSON.stringify(post);
  assert.match(serialized, /正在检查测试结果/);
  assert.equal(serialized.includes("非隐藏思维链"), false);
  assert.equal(serialized.includes('"tag":"at"'), false);
  assert.match(serialized, /2026.*08.*13.*12.*05.*06/);
});

test("emits only completed commentary items as public progress and deduplicates them", async () => {
  const progress = [];
  const collector = new CodexTurnCollector({
    targets: [target],
    onTurnProgress: (record) => progress.push(record),
  });
  collector.handleNotification("turn/started", {
    threadId: "thread-id",
    turn: { id: "turn-progress", status: "inProgress", items: [] },
  });
  const commentary = {
    id: "commentary-one",
    type: "agentMessage",
    phase: "commentary",
    text: "公开阶段说明",
  };
  for (const item of [
    commentary,
    commentary,
    { id: "commentary-two", type: "agentMessage", phase: "commentary", text: "第二条公开阶段说明" },
    { id: "raw-reasoning", type: "reasoning", summary: ["do not emit"], content: ["secret"] },
    { id: "unphased", type: "agentMessage", text: "legacy answer" },
    { id: "final", type: "agentMessage", phase: "final_answer", text: "final answer" },
  ]) {
    collector.handleNotification("item/completed", {
      threadId: "thread-id",
      turnId: "turn-progress",
      completedAtMs: 1_786_593_600_100,
      item,
    });
  }
  await Promise.resolve();

  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0], {
    threadId: "thread-id",
    turnId: "turn-progress",
    chatId: "oc_group",
    itemId: "commentary-one",
    sequence: 1,
    text: "公开阶段说明",
    createdAtMs: 1_786_593_600_100,
  });
  assert.equal(progress[1].sequence, 2);
  assert.equal(JSON.stringify(progress).includes("secret"), false);
});

test("continues progress numbering from commentary already present in an active reconnect snapshot", async () => {
  const progress = [];
  const collector = new CodexTurnCollector({
    targets: [target],
    onTurnProgress: (record) => progress.push(record),
  });
  collector.seedThread({
    id: "thread-id",
    turns: [{
      id: "turn-reconnected-progress",
      status: "inProgress",
      items: [{
        id: "commentary-before-reconnect",
        type: "agentMessage",
        phase: "commentary",
        text: "重连前进度",
      }],
    }],
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-reconnected-progress",
    item: {
      id: "commentary-after-reconnect",
      type: "agentMessage",
      phase: "commentary",
      text: "重连后进度",
    },
  });
  await Promise.resolve();

  assert.equal(progress.length, 1);
  assert.equal(progress[0].sequence, 2);
});

test("emits only an external final answer and ignores commentary and Feishu-originated turns", async () => {
  const emitted = [];
  const collector = new CodexTurnCollector({ targets: [target], onExternalTurn: (record) => emitted.push(record) });
  collector.handleNotification("turn/started", {
    threadId: "thread-id",
    turn: { id: "turn-desktop", status: "inProgress", startedAt: 1_786_593_600, items: [] },
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-desktop",
    completedAtMs: 1_786_593_600_100,
    item: {
      ...userItem("desktop-client"),
      content: [
        { type: "text", text: "Desktop prompt" },
        { type: "localImage", path: "C:/Temp/example.png" },
      ],
    },
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-desktop",
    completedAtMs: 1_786_593_600_200,
    item: { ...userItem("desktop-client", "first adjustment"), id: "user-first-adjustment" },
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-desktop",
    completedAtMs: 1_786_593_600_300,
    item: { ...userItem("desktop-client", "second adjustment"), id: "user-second-adjustment" },
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-desktop",
    completedAtMs: 1_786_593_601_000,
    item: { id: "commentary", type: "agentMessage", phase: "commentary", text: "hidden progress" },
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-desktop",
    completedAtMs: 1_786_593_602_000,
    item: { id: "final", type: "agentMessage", phase: "final_answer", text: "visible answer" },
  });
  collector.handleNotification("turn/completed", {
    threadId: "thread-id",
    turn: { id: "turn-desktop", status: "completed", startedAt: 1_786_593_600, items: [] },
  });

  collector.handleNotification("turn/started", {
    threadId: "thread-id",
    turn: { id: "turn-feishu", status: "inProgress", startedAt: 1_786_593_610, items: [] },
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-feishu",
    completedAtMs: 1_786_593_610_100,
    item: userItem("om_x100b68e7b78f2ca8de9d5d264b84e99", "Feishu prompt"),
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-feishu",
    completedAtMs: 1_786_593_610_200,
    item: { ...userItem("desktop-client", "Desktop adjustment"), id: "feishu-turn-adjustment" },
  });
  collector.handleNotification("turn/completed", {
    threadId: "thread-id",
    turn: {
      id: "turn-feishu",
      status: "completed",
      items: [{ id: "answer-2", type: "agentMessage", phase: "final_answer", text: "reply path owns this" }],
    },
  });
  await Promise.resolve();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].prompt, "Desktop prompt");
  assert.equal(emitted[0].answer, "visible answer");
  assert.equal(emitted[0].chatId, "oc_group");
  assert.deepEqual(emitted[0].promptEntries.map(({ text }) => text), [
    "Desktop prompt",
    "first adjustment",
    "second adjustment",
  ]);
  assert.deepEqual(emitted[0].promptEntries.map(({ sequence, kind, source }) => ({ sequence, kind, source })), [
    { sequence: 1, kind: "initial", source: "codex" },
    { sequence: 2, kind: "steer", source: "codex" },
    { sequence: 3, kind: "steer", source: "codex" },
  ]);
  assert.deepEqual(emitted[0].promptEntries.map(({ promptAtMs }) => promptAtMs), [
    1_786_593_600_100,
    1_786_593_600_200,
    1_786_593_600_300,
  ]);
  assert.deepEqual(emitted[0].promptResources, [{
    type: "image",
    source: "local",
    path: "C:/Temp/example.png",
    name: "example.png",
  }]);
});

test("does not classify a Desktop-started turn as external after a Feishu adjustment", async () => {
  const external = [];
  const completed = [];
  const collector = new CodexTurnCollector({
    targets: [target],
    onExternalTurn: (record) => external.push(record),
    onTurnCompleted: (record) => completed.push(record),
  });
  collector.handleNotification("turn/started", {
    threadId: "thread-id",
    turn: { id: "turn-cross-client", status: "inProgress", items: [] },
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-cross-client",
    completedAtMs: 1_786_593_600_100,
    item: { ...userItem("desktop-client", "Desktop initial"), id: "desktop-initial" },
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-cross-client",
    completedAtMs: 1_786_593_600_200,
    item: { ...userItem("om_adjust", "Feishu adjustment"), id: "feishu-adjustment" },
  });
  collector.handleNotification("turn/completed", {
    threadId: "thread-id",
    turn: {
      id: "turn-cross-client",
      status: "completed",
      items: [{ id: "answer-cross", type: "agentMessage", phase: "final_answer", text: "done" }],
    },
  });
  await Promise.resolve();

  assert.equal(external.length, 0);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].promptEntries.map(({ text, source }) => ({ text, source })), [
    { text: "Desktop initial", source: "codex" },
    { text: "Feishu adjustment", source: "feishu" },
  ]);
});

test("uses the complete App Server item order as the canonical adjustment sequence", async () => {
  const completed = [];
  const collector = new CodexTurnCollector({ targets: [target], onTurnCompleted: (record) => completed.push(record) });
  const initial = { ...userItem("desktop-client", "initial"), id: "canonical-initial" };
  const first = { ...userItem("om_first", "first adjustment"), id: "canonical-first" };
  const second = { ...userItem("desktop-client", "second adjustment"), id: "canonical-second" };
  collector.handleNotification("turn/started", {
    threadId: "thread-id",
    turn: { id: "turn-canonical-order", status: "inProgress", items: [] },
  });
  for (const item of [second, initial, first]) {
    collector.handleNotification("item/completed", {
      threadId: "thread-id",
      turnId: "turn-canonical-order",
      item,
    });
  }
  collector.handleNotification("turn/completed", {
    threadId: "thread-id",
    turn: {
      id: "turn-canonical-order",
      status: "completed",
      items: [initial, first, second, { id: "canonical-answer", type: "agentMessage", phase: "final_answer", text: "done" }],
    },
  });
  await Promise.resolve();

  assert.deepEqual(completed[0].promptEntries.map(({ text, sequence, source }) => ({ text, sequence, source })), [
    { text: "initial", sequence: 1, source: "codex" },
    { text: "first adjustment", sequence: 2, source: "feishu" },
    { text: "second adjustment", sequence: 3, source: "codex" },
  ]);
  assert.equal(completed[0].clientId, "desktop-client");
});

test("emits an external image-only prompt without inventing a textual image label", async () => {
  const emitted = [];
  const collector = new CodexTurnCollector({ targets: [target], onExternalTurn: (record) => emitted.push(record) });
  collector.handleNotification("turn/started", {
    threadId: "thread-id",
    turn: { id: "turn-image-only", status: "inProgress", startedAt: 1_786_593_600, items: [] },
  });
  collector.handleNotification("item/completed", {
    threadId: "thread-id",
    turnId: "turn-image-only",
    completedAtMs: 1_786_593_600_100,
    item: {
      id: "user-image-only",
      type: "userMessage",
      clientId: "desktop-client",
      content: [{ type: "localImage", path: "C:/Temp/only.png" }],
    },
  });
  collector.handleNotification("turn/completed", {
    threadId: "thread-id",
    turn: {
      id: "turn-image-only",
      status: "completed",
      items: [{ id: "final-image-only", type: "agentMessage", phase: "final_answer", text: "visible answer" }],
    },
  });
  await Promise.resolve();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].prompt, "");
  assert.equal(emitted[0].promptResources[0].name, "only.png");
});

test("emits every completed turn to the unified callback, including Feishu and plan-only Goal turns", async () => {
  const completed = [];
  const external = [];
  const collector = new CodexTurnCollector({
    targets: [target],
    onTurnCompleted: (record) => completed.push(record),
    onExternalTurn: (record) => external.push(record),
  });
  collector.handleNotification("turn/started", {
    threadId: "thread-id",
    turn: { id: "turn-feishu-unified", status: "inProgress", items: [userItem("om_unified", "from Feishu")] },
  });
  collector.handleNotification("turn/completed", {
    threadId: "thread-id",
    turn: {
      id: "turn-feishu-unified",
      status: "completed",
      items: [{ id: "final-unified", type: "agentMessage", phase: "final_answer", text: "reply" }],
    },
  });
  collector.handleNotification("turn/started", {
    threadId: "thread-id",
    turn: { id: "turn-goal-plan", status: "inProgress", items: [] },
  });
  collector.handleNotification("turn/completed", {
    threadId: "thread-id",
    turn: {
      id: "turn-goal-plan",
      status: "completed",
      items: [{ id: "plan-result", type: "plan", text: "native plan result" }],
    },
  });
  await Promise.resolve();

  assert.equal(completed.length, 2);
  assert.equal(completed[0].clientId, "om_unified");
  assert.equal(completed[0].answer, "reply");
  assert.equal(completed[1].promptEntries.length, 0);
  assert.equal(completed[1].answer, "native plan result");
  assert.equal(external.length, 0);
});

test("emits completion timing and full per-turn token usage across multiple model calls", async () => {
  const completed = [];
  const collector = new CodexTurnCollector({
    targets: [target],
    onTurnCompleted: (record) => completed.push(record),
  });
  collector.handleNotification("turn/started", {
    threadId: "thread-id",
    turn: {
      id: "turn-metrics",
      status: "inProgress",
      startedAt: 1_786_593_600,
      items: [userItem("om_metrics", "measure this")],
    },
  });
  collector.handleNotification("thread/tokenUsage/updated", {
    threadId: "thread-id",
    turnId: "turn-metrics",
    tokenUsage: {
      total: usageBreakdown({ inputTokens: 1_000, outputTokens: 240, totalTokens: 1_240 }),
      last: usageBreakdown({ inputTokens: 180, outputTokens: 60, totalTokens: 240 }),
      modelContextWindow: 400_000,
    },
  });
  collector.handleNotification("thread/tokenUsage/updated", {
    threadId: "thread-id",
    turnId: "turn-metrics",
    tokenUsage: {
      total: usageBreakdown({ inputTokens: 1_200, outputTokens: 300, totalTokens: 1_500 }),
      last: usageBreakdown({ inputTokens: 200, outputTokens: 60, totalTokens: 260 }),
      modelContextWindow: 400_000,
    },
  });
  collector.handleNotification("turn/completed", {
    threadId: "thread-id",
    turn: {
      id: "turn-metrics",
      status: "completed",
      startedAt: 1_786_593_600,
      completedAt: 1_786_593_722,
      durationMs: 121_500,
      items: [{ id: "answer-metrics", type: "agentMessage", phase: "final_answer", text: "done" }],
    },
  });
  await Promise.resolve();

  assert.equal(completed.length, 1);
  assert.equal(completed[0].completedAtMs, 1_786_593_722_000);
  assert.equal(completed[0].durationMs, 121_500);
  assert.deepEqual(completed[0].tokenUsage, usageBreakdown({
    inputTokens: 380,
    outputTokens: 120,
    totalTokens: 500,
  }));
});

test("does not report partial token usage when observation begins mid-turn", async () => {
  const completed = [];
  const collector = new CodexTurnCollector({
    targets: [target],
    onTurnCompleted: (record) => completed.push(record),
  });
  collector.seedThread({
    id: "thread-id",
    turns: [{
      id: "turn-mid-flight",
      status: "inProgress",
      startedAt: 1_786_593_600,
      items: [userItem("desktop-client", "already running")],
    }],
  });
  collector.handleNotification("thread/tokenUsage/updated", {
    threadId: "thread-id",
    turnId: "turn-mid-flight",
    tokenUsage: {
      total: usageBreakdown({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
      last: usageBreakdown({ inputTokens: 900, outputTokens: 100, totalTokens: 1_000 }),
    },
  });
  collector.handleNotification("turn/completed", {
    threadId: "thread-id",
    turn: {
      id: "turn-mid-flight",
      status: "completed",
      startedAt: 1_786_593_600,
      completedAt: 1_786_593_660,
      items: [{ id: "answer-mid-flight", type: "agentMessage", phase: "final_answer", text: "done" }],
    },
  });
  await Promise.resolve();

  assert.equal(completed.length, 1);
  assert.equal(completed[0].tokenUsage, undefined);
});

function fakeWebSocketServer(snapshot) {
  const requests = [];
  let socket;
  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      socket = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(text) {
      const request = JSON.parse(text);
      requests.push(request);
      let result;
      if (request.method === "initialize") result = { userAgent: "test" };
      else if (request.method === "thread/resume") {
        result = { thread: { id: "thread-id", status: { type: "active" } } };
      } else if (request.method === "thread/read") result = { thread: structuredClone(snapshot) };
      else return;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ id: request.id, result }),
      })));
    }
    close() {
      const event = new Event("close");
      Object.defineProperty(event, "code", { value: 1000 });
      queueMicrotask(() => this.dispatchEvent(event));
    }
  }
  return {
    FakeWebSocket,
    requests,
    notify(method, params) {
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ method, params }) }));
    },
  };
}

test("observer seeds the current active turn without backfilling older completed turns", async () => {
  const snapshot = {
    id: "thread-id",
    status: { type: "active" },
    turns: [
      {
        id: "old-turn",
        status: "completed",
        startedAt: 1_786_593_000,
        completedAt: 1_786_593_010,
        items: [userItem("old-client", "old"), { id: "old-final", type: "agentMessage", phase: "final_answer", text: "old answer" }],
      },
      {
        id: "active-turn",
        status: "inProgress",
        startedAt: 1_786_593_600,
        completedAt: null,
        items: [userItem("desktop-client", "active prompt")],
      },
    ],
  };
  const server = fakeWebSocketServer(snapshot);
  let resolveRecord;
  const recordPromise = new Promise((resolve) => { resolveRecord = resolve; });
  const observer = new CodexSessionObserver({
    appServerUrl: "ws://127.0.0.1:47321/rpc",
    targets: [target],
    sandboxMode: "workspace-write",
    onExternalTurn: resolveRecord,
    WebSocketImpl: server.FakeWebSocket,
  });
  await observer.start();
  server.notify("item/completed", {
    threadId: "thread-id",
    turnId: "active-turn",
    completedAtMs: 1_786_593_605_000,
    item: { id: "active-final", type: "agentMessage", phase: "final_answer", text: "active answer" },
  });
  server.notify("turn/completed", {
    threadId: "thread-id",
    turn: { id: "active-turn", status: "completed", startedAt: 1_786_593_600, completedAt: 1_786_593_605, items: [] },
  });
  const record = await recordPromise;
  await observer.stop();

  assert.equal(record.prompt, "active prompt");
  assert.equal(record.answer, "active answer");
  assert.deepEqual(server.requests.map(({ method }) => method), ["initialize", "thread/resume", "thread/read"]);
});
