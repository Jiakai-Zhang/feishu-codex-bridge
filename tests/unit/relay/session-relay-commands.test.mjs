import assert from "node:assert/strict";
import test from "node:test";
import {
  executeGlobalSettingsCommand,
  executeSessionCommand,
  formatGoalStatus,
  formatAttachmentDraft,
  formatGlobalSessionSettings,
  formatModelView,
  formatPromptQueue,
  formatSessionSettings,
  formatSessionStatus,
  parseQueueAction,
  parseAttachmentsAction,
  parseSessionCommand,
  parseSettingsAction,
} from "../../../src/relay/session-relay-commands.mjs";

test("recognizes only Bridge-owned slash commands and leaves unknown slash text as a prompt", () => {
  assert.deepEqual(parseSessionCommand(" /status "), { name: "status", args: "", raw: "/status" });
  assert.deepEqual(parseSessionCommand("/model effort high"), {
    name: "model",
    args: "effort high",
    raw: "/model effort high",
  });
  assert.deepEqual(parseSessionCommand("/stop@relay_bot"), { name: "stop", args: "", raw: "/stop@relay_bot" });
  assert.deepEqual(parseSessionCommand("/queue run tests"), { name: "queue", args: "run tests", raw: "/queue run tests" });
  assert.deepEqual(parseSessionCommand("/steer change direction"), {
    name: "steer",
    args: "change direction",
    raw: "/steer change direction",
  });
  assert.deepEqual(parseSessionCommand("/settings progress on"), {
    name: "settings",
    args: "progress on",
    raw: "/settings progress on",
  });
  assert.deepEqual(parseQueueAction("run tests"), { action: "enqueue", text: "run tests" });
  assert.deepEqual(parseQueueAction("remove 2"), { action: "remove", position: 2 });
  assert.deepEqual(parseAttachmentsAction("clear"), { action: "clear" });
  assert.deepEqual(parseSessionCommand("/attachments"), { name: "attachments", args: "", raw: "/attachments" });
  assert.deepEqual(parseQueueAction("-- clear the cache"), { action: "enqueue", text: "clear the cache" });
  assert.deepEqual(parseSettingsAction("input queue"), { action: "input", value: "queue" });
  assert.deepEqual(parseSettingsAction("thinking on"), { action: "progress", value: true });
  assert.deepEqual(parseSettingsAction("mention off"), { action: "mention", value: false });
  assert.equal(parseSessionCommand("/review this change"), undefined);
  assert.equal(parseSessionCommand("please /stop"), undefined);
});

test("formats status, model, and Goal state without exposing reasoning or local paths", () => {
  const status = formatSessionStatus({
    connected: true,
    status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    activeTurnId: "019ff5b8-decb-7ca3-802c-f115f2f196de",
    settings: {
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "fast",
      collaborationMode: { mode: "plan" },
    },
    tokenUsage: { total: { totalTokens: 12345 } },
    goal: { status: "paused", tokensUsed: 100 },
  }, {
    queueEntries: [{ text: "run all tests" }],
    relaySettings: { inputMode: "queue", publicProgress: true, finalMention: true },
  });
  assert.match(status, /正在回答/);
  assert.match(status, /等待：用户输入/);
  assert.match(status, /gpt-5\.6-sol/);
  assert.match(status, /Fast/);
  assert.match(status, /Plan/);
  assert.match(status, /下一轮队列：1 条/);
  assert.match(status, /待提交附件：0 个/);
  assert.match(status, /下一条：run all tests/);
  assert.match(status, /普通消息：排队新 Turn/);
  assert.match(status, /公开进度：开启/);
  assert.match(status, /最终回答提醒：开启/);
  assert.equal(status.includes("C:\\"), false);

  const model = formatModelView({
    settings: { model: "gpt-5.6-sol", effort: "high", serviceTier: null, collaborationMode: { mode: "default" } },
    models: [{
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      serviceTiers: [{ id: "fast" }],
      additionalSpeedTiers: [],
    }],
  });
  assert.match(model, /可用模型/);
  assert.match(model, /\/model speed standard\|fast/);

  const goal = formatGoalStatus({
    objective: "finish the bridge",
    status: "active",
    tokenBudget: 20000,
    tokensUsed: 1200,
    timeUsedSeconds: 75,
  });
  assert.match(goal, /> finish the bridge/);
  assert.match(goal, /运行中/);
  assert.match(goal, /1 分 15 秒/);

  const queue = formatPromptQueue([
    { text: "first queued prompt" },
    { text: "second queued prompt" },
  ], { status: { connected: true, status: { type: "active" } } });
  assert.match(queue, /等待：2 条/);
  assert.match(queue, /当前回答完成/);
  assert.ok(queue.indexOf("first queued prompt") < queue.indexOf("second queued prompt"));

  const attachments = formatAttachmentDraft([{
    attachments: [{ name: "input.xlsx" }, { name: "notes.pdf" }],
  }]);
  assert.match(attachments, /当前暂存 2 个附件/);
  assert.match(attachments, /input\.xlsx/);
  assert.match(attachments, /下一条普通文字 Prompt/);

  const relaySettings = formatSessionSettings({ inputMode: "steer", publicProgress: false, finalMention: true });
  assert.match(relaySettings, /调整当前回答（steer）/);
  assert.match(relaySettings, /公开进度：关闭/);
  assert.match(relaySettings, /最终回答提醒：开启/);
  assert.match(relaySettings, /非隐藏思维链/);

  const globalSettings = formatGlobalSessionSettings({ inputMode: "queue", publicProgress: true, finalMention: true });
  assert.match(globalSettings, /新绑定默认设置/);
  assert.match(globalSettings, /已有绑定群不会随全局默认变化/);
});

test("routes stop, model, plan, and Goal commands to native controller operations", async () => {
  const calls = [];
  const controller = {
    getStatus: async () => ({ connected: true, status: { type: "idle" }, settings: {} }),
    interrupt: async (...args) => { calls.push(["interrupt", ...args]); return { interrupted: true, goalPaused: true }; },
    getModelView: async () => ({ settings: { model: "m1" }, models: [] }),
    updateModel: async (...args) => { calls.push(["updateModel", ...args]); },
    setPlan: async (...args) => { calls.push(["setPlan", ...args]); return { mode: args[1] ? "plan" : "default" }; },
    getGoal: async () => null,
    startGoal: async (...args) => {
      calls.push(["startGoal", ...args]);
      return { objective: args[1], status: "active", tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null };
    },
  };
  const context = { controller, threadId: "thread-id", promptQueue: { count: () => 2, list: () => [] } };

  const stop = await executeSessionCommand(parseSessionCommand("/stop"), context);
  assert.match(stop, /Goal 已先暂停/);
  assert.match(stop, /队列中的 2 条 Prompt 保持不变/);
  await executeSessionCommand(parseSessionCommand("/model effort xhigh"), context);
  await executeSessionCommand(parseSessionCommand("/plan on"), context);
  await executeSessionCommand(parseSessionCommand("/goal start finish it"), context);

  assert.deepEqual(calls, [
    ["interrupt", "thread-id", { pauseGoal: true }],
    ["updateModel", "thread-id", { effort: "xhigh" }],
    ["setPlan", "thread-id", true],
    ["startGoal", "thread-id", "finish it"],
  ]);
});

test("routes an explicit steer independently from the Session default input mode", async () => {
  const calls = [];
  const result = await executeSessionCommand(parseSessionCommand("/steer use the other API"), {
    controller: {},
    threadId: "thread-id",
    steerPrompt: async (text) => {
      calls.push(text);
      return { kind: "steered" };
    },
  });
  assert.deepEqual(calls, ["use the other API"]);
  assert.match(result, /已调整方向/);
});

test("rejects malformed recognized commands instead of sending them to Codex", async () => {
  const controller = { interrupt: async () => ({}) };
  await assert.rejects(
    () => executeSessionCommand(parseSessionCommand("/stop now"), { controller, threadId: "thread-id" }),
    /用法/,
  );
});

test("queues, lists, removes, and clears prompts through the persistent queue context", async () => {
  const entries = [];
  const promptQueue = {
    list: () => entries.map((entry) => ({ ...entry })),
    count: () => entries.length,
    removeAt: async (_threadId, position) => entries.splice(position - 1, 1)[0],
    clear: async () => entries.splice(0).length,
  };
  const controller = { getStatus: async () => ({ connected: true, status: { type: "active" } }) };
  const context = {
    controller,
    threadId: "thread-id",
    promptQueue,
    enqueuePrompt: async (text) => {
      entries.push({ text });
      return { position: entries.length, alreadyQueued: false };
    },
  };

  const queued = await executeSessionCommand(parseSessionCommand("/queue run tests"), context);
  assert.match(queued, /当前排位：1/);
  assert.match(await executeSessionCommand(parseSessionCommand("/queue"), context), /first|run tests/);
  assert.match(await executeSessionCommand(parseSessionCommand("/queue remove 1"), context), /已移除/);
  entries.push({ text: "one" }, { text: "two" });
  assert.match(await executeSessionCommand(parseSessionCommand("/queue clear"), context), /已删除 2 条/);
  assert.equal(entries.length, 0);
});

test("lists and clears staged attachments without submitting a Codex prompt", async () => {
  const records = [{
    messageId: "om_file",
    attachments: [{ name: "input.xlsx" }, { name: "notes.pdf" }],
  }];
  const attachmentDraftStore = {
    list: () => records.map((record) => structuredClone(record)),
    clear: async () => records.splice(0),
  };
  const context = {
    controller: {},
    threadId: "thread-id",
    attachmentDraftStore,
  };
  assert.match(await executeSessionCommand(parseSessionCommand("/attachments"), context), /input\.xlsx/);
  assert.match(await executeSessionCommand(parseSessionCommand("/attachments clear"), context), /已放弃 2 个附件/);
  assert.equal(records.length, 0);
});

test("views, updates, and resets persistent Session relay settings", async () => {
  const records = new Map();
  const defaults = { inputMode: "steer", publicProgress: false, finalMention: true };
  const settingsStore = {
    get: (thread) => ({ ...defaults, ...(records.get(thread) || {}) }),
    update: async (thread, patch) => {
      records.set(thread, { ...defaults, ...(records.get(thread) || {}), ...patch });
      return settingsStore.get(thread);
    },
    reset: async (thread) => {
      records.delete(thread);
      return settingsStore.get(thread);
    },
  };
  const context = {
    controller: { getStatus: async () => ({ connected: true, status: { type: "idle" }, settings: {} }) },
    threadId: "thread-id",
    settingsStore,
  };

  assert.match(await executeSessionCommand(parseSessionCommand("/settings"), context), /调整当前回答/);
  assert.match(await executeSessionCommand(parseSessionCommand("/settings input queue"), context), /排队新 Turn/);
  assert.match(await executeSessionCommand(parseSessionCommand("/settings progress on"), context), /公开进度：开启/);
  assert.match(await executeSessionCommand(parseSessionCommand("/settings mention off"), context), /最终回答提醒：关闭/);
  assert.deepEqual(settingsStore.get("thread-id"), { inputMode: "queue", publicProgress: true, finalMention: false });
  assert.match(await executeSessionCommand(parseSessionCommand("/settings reset"), context), /公开进度：关闭/);
  assert.deepEqual(settingsStore.get("thread-id"), defaults);
});

test("manages new-binding defaults through the global settings command", async () => {
  let defaults = { inputMode: "queue", publicProgress: true, finalMention: true };
  const settingsStore = {
    getDefaults: () => ({ ...defaults }),
    updateDefaults: async (patch) => {
      defaults = { ...defaults, ...patch };
      return { ...defaults };
    },
    resetDefaults: async () => {
      defaults = { inputMode: "queue", publicProgress: true, finalMention: true };
      return { ...defaults };
    },
  };

  assert.match(
    await executeGlobalSettingsCommand(parseSessionCommand("/settings"), { settingsStore }),
    /新绑定默认设置/,
  );
  assert.match(
    await executeGlobalSettingsCommand(parseSessionCommand("/settings input steer"), { settingsStore }),
    /调整当前回答/,
  );
  await executeGlobalSettingsCommand(parseSessionCommand("/settings progress off"), { settingsStore });
  await executeGlobalSettingsCommand(parseSessionCommand("/settings mention off"), { settingsStore });
  assert.deepEqual(defaults, { inputMode: "steer", publicProgress: false, finalMention: false });
  await executeGlobalSettingsCommand(parseSessionCommand("/settings reset"), { settingsStore });
  assert.deepEqual(defaults, { inputMode: "queue", publicProgress: true, finalMention: true });
});
