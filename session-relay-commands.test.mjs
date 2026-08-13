import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSessionCommand,
  formatGoalStatus,
  formatModelView,
  formatPromptQueue,
  formatSessionStatus,
  parseQueueAction,
  parseSessionCommand,
} from "./session-relay-commands.mjs";

test("recognizes only Bridge-owned slash commands and leaves unknown slash text as a prompt", () => {
  assert.deepEqual(parseSessionCommand(" /status "), { name: "status", args: "", raw: "/status" });
  assert.deepEqual(parseSessionCommand("/model effort high"), {
    name: "model",
    args: "effort high",
    raw: "/model effort high",
  });
  assert.deepEqual(parseSessionCommand("/stop@relay_bot"), { name: "stop", args: "", raw: "/stop@relay_bot" });
  assert.deepEqual(parseSessionCommand("/queue run tests"), { name: "queue", args: "run tests", raw: "/queue run tests" });
  assert.deepEqual(parseQueueAction("run tests"), { action: "enqueue", text: "run tests" });
  assert.deepEqual(parseQueueAction("remove 2"), { action: "remove", position: 2 });
  assert.deepEqual(parseQueueAction("-- clear the cache"), { action: "enqueue", text: "clear the cache" });
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
  }, { queueEntries: [{ text: "run all tests" }] });
  assert.match(status, /正在回答/);
  assert.match(status, /等待：用户输入/);
  assert.match(status, /gpt-5\.6-sol/);
  assert.match(status, /Fast/);
  assert.match(status, /Plan/);
  assert.match(status, /下一轮队列：1 条/);
  assert.match(status, /下一条：run all tests/);
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
