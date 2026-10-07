import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectSubagentProgress } from "../../../src/codex/codex-subagent-progress.mjs";
import { CodexTurnCollector } from "../../../src/codex/codex-turn-collector.mjs";
import { buildSessionStreamCard, SessionStreamCardStore } from "../../../src/feishu/session-stream-card.mjs";

const target = { threadId: "parent-fixture", chatId: "group-fixture" };
const collab = (fields = {}) => ({
  type: "collabAgentToolCall", id: "spawn-fixture", tool: "spawnAgent", status: "inProgress",
  receiverThreadIds: [], agentsStates: {}, ...fields,
});
const activity = (kind, agentThreadId = "child-fixture") => ({
  type: "subAgentActivity", id: `activity-${kind}`, agentThreadId, kind, agentPath: "/private-fixture/agent",
});
function harness() {
  const progress = [];
  const collector = new CodexTurnCollector({ targets: [target], onTurnProgress: (item) => progress.push(item) });
  collector.handleNotification("turn/started", {
    threadId: target.threadId, turn: { id: "turn-fixture", items: [{
      type: "userMessage", id: "input-fixture", clientId: "om_fixture", content: [{ type: "text", text: "work" }],
    }] },
  });
  const emit = (item, method = "item/completed") => collector.handleNotification(method, {
    threadId: target.threadId, turnId: "turn-fixture", item,
  });
  return { collector, progress, emit };
}

test("subagent progress uses only known lifecycle enums, not prompts, paths, IDs or results", () => {
  const agents = new Map();
  const text = collectSubagentProgress(agents, collab({
    status: "completed", receiverThreadIds: ["secret-child-fixture"],
    senderThreadId: "secret-parent-fixture", prompt: "secret-prompt-fixture",
    model: "secret-model-fixture", error: "secret-error-fixture",
    agentsStates: { "secret-child-fixture": { status: "running", message: "secret-result-fixture" } },
  }));
  assert.match(text, /已启动子 agent/);
  assert.match(text, /子 agent #1：工作中/);
  assert.doesNotMatch(text, /secret|fixture/);
  assert.equal(collectSubagentProgress(agents, collab({ tool: "unknown-secret" })), undefined);
  assert.equal(collectSubagentProgress(agents, activity("unknown-secret")), undefined);
});

test("all reported lifecycle statuses are translated without guessing unknown status completion", () => {
  const agents = new Map();
  const states = Object.fromEntries(["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound", "unknown-secret"]
    .map((status, index) => [`child-${index}-fixture`, { status }]));
  const text = collectSubagentProgress(agents, collab({ tool: "wait", status: "completed", agentsStates: states }));
  for (const label of ["正在启动", "工作中", "已中断", "已完成", "执行失败", "已关闭", "暂不可用", "等待状态"]) {
    assert.ok(text.includes(label));
  }
  assert.doesNotMatch(text, /unknown-secret|child-.*fixture/);
});

test("collaboration failure is not mislabeled as child failure or child completion", () => {
  const agents = new Map();
  collectSubagentProgress(agents, activity("started"));
  for (const tool of ["sendInput", "resumeAgent", "wait", "closeAgent"]) {
    const text = collectSubagentProgress(agents, collab({ tool, status: "failed", receiverThreadIds: ["child-fixture"] }));
    assert.match(text, /协作调用失败/);
    assert.match(text, /#1：工作中/);
    assert.doesNotMatch(text, /已完成|执行失败|已关闭/);
  }
  const text = collectSubagentProgress(agents, collab({ status: "failed", receiverThreadIds: ["unknown-child-fixture"] }));
  assert.match(text, /#2：等待状态/);
  assert.doesNotMatch(text, /已启用/);
});

test("collector shows startup immediately, keeps child running after spawn returns, then shows completion", () => {
  const { progress, emit } = harness();
  const spawn = collab();
  emit(spawn, "item/started");
  emit(spawn, "item/started");
  emit(collab({ status: "completed", receiverThreadIds: ["child-fixture"], agentsStates: {
    "child-fixture": { status: "running", message: "hidden-fixture" },
  } }));
  const completed = activity("completed");
  emit(completed, "item/started");
  emit(completed);
  emit({ type: "agentMessage", id: "comment-fixture", phase: "commentary", text: "继续汇总" });
  assert.equal(progress.length, 4);
  assert.match(progress[0].text, /正在启动子 agent/);
  assert.match(progress[1].text, /#1：工作中/);
  assert.doesNotMatch(progress[1].text, /已完成/);
  assert.match(progress[2].text, /#1：已完成/);
  assert.deepEqual(progress.map((item) => item.sequence), [1, 2, 3, 4]);
  assert.equal(progress[0].kind, "subagent");
  assert.equal(progress[0].activityKey, "subagents");
  assert.equal(progress[0].clientId, "om_fixture");
  assert.equal(progress[3].kind, undefined);
  assert.doesNotMatch(JSON.stringify(progress), /hidden-fixture|child-fixture|private-fixture/);
});

test("waiting for a child does not claim its work is complete and subsequent resumes still emit", () => {
  const { progress, emit } = harness();
  emit(activity("started"), "item/started");
  emit(collab({ id: "wait-fixture", tool: "wait", receiverThreadIds: ["child-fixture"] }), "item/started");
  emit(collab({ id: "wait-fixture", tool: "wait", status: "completed", agentsStates: { "child-fixture": { status: "running" } } }));
  assert.match(progress.at(-1).text, /#1：工作中/);
  assert.doesNotMatch(progress.at(-1).text, /已完成/);
  emit(activity("completed"));
  emit(activity("started"));
  assert.equal(progress.length, 5);
  assert.match(progress.at(-1).text, /#1：工作中/);
});

test("multiple child statuses retain anonymous numbering and do not expose child-thread commentary", () => {
  const { collector, progress, emit } = harness();
  emit(activity("started", "first-child-fixture"));
  emit(activity("started", "second-child-fixture"));
  emit(activity("interrupted", "first-child-fixture"));
  assert.match(progress.at(-1).text, /#1：已中断/);
  assert.match(progress.at(-1).text, /#2：工作中/);
  collector.handleNotification("item/completed", {
    threadId: "first-child-fixture", turnId: "child-turn-fixture",
    item: { type: "agentMessage", phase: "commentary", text: "private-child-output-fixture" },
  });
  emit({ type: "reasoning", content: ["private-reasoning-fixture"] }, "item/started");
  emit({ type: "agentMessage", phase: "commentary", text: "not-finished" }, "item/started");
  assert.equal(progress.length, 3);
  assert.doesNotMatch(JSON.stringify(progress), /private-child|private-reasoning|not-finished/);
});

test("active reconnect snapshots retain known child statuses for the next lifecycle update", () => {
  const { collector, progress, emit } = harness();
  collector.seedThread({ id: target.threadId, turns: [{ id: "turn-fixture", status: "inProgress", items: [
    collab({ status: "completed", receiverThreadIds: ["child-fixture"], agentsStates: { "child-fixture": { status: "running" } } }),
  ] }] });
  assert.equal(progress.length, 0);
  emit(activity("completed"));
  assert.match(progress[0].text, /#1：已完成/);
  assert.equal(progress[0].sequence, 2);
});

test("stream cards keep a durable, updatable subagent panel while public commentary grows", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "subagent-card-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "cards.json");
  const store = await SessionStreamCardStore.open(file);
  await store.start({ ...target, turnId: "turn-fixture", messageId: "card-fixture" });
  await store.appendProgress(target.threadId, "turn-fixture", {
    kind: "subagent", activityKey: "subagents", sequence: 1, text: "子 agent #1：工作中",
  });
  for (let index = 2; index < 22; index++) {
    await store.appendProgress(target.threadId, "turn-fixture", { sequence: index, text: `公开进度 ${index}` });
  }
  let record = (await SessionStreamCardStore.open(file)).get(target.threadId, "turn-fixture");
  assert.equal(record.messageId, "card-fixture");
  assert.equal(record.progress.length, 13);
  let serialized = JSON.stringify(buildSessionStreamCard({ progress: record.progress }));
  assert.match(serialized, /子 agent 协作/);
  assert.match(serialized, /#1：工作中/);
  assert.match(serialized, /公开进度 21/);
  const reopened = await SessionStreamCardStore.open(file);
  await reopened.appendProgress(target.threadId, "turn-fixture", {
    kind: "subagent", activityKey: "subagents", sequence: 22, text: "子 agent #1：已完成",
  });
  record = reopened.get(target.threadId, "turn-fixture");
  assert.equal(record.progress.filter((item) => item.kind === "subagent").length, 1);
  serialized = JSON.stringify(buildSessionStreamCard({ progress: record.progress }));
  assert.match(serialized, /#1：已完成/);
  assert.doesNotMatch(serialized, /#1：工作中/);
  assert.doesNotMatch(JSON.stringify(buildSessionStreamCard({ progress: record.progress, answer: "结果已汇总" })), /子 agent 协作/);
});

test("subagent startup progress absorbs queue acknowledgements in the same card", () => {
  const card = buildSessionStreamCard({ queued: { position: 1 }, progress: [{
    kind: "subagent", activityKey: "subagents", sequence: 1, text: "正在启动子 agent…",
  }] });
  assert.match(JSON.stringify(card), /正在启动子 agent/);
  assert.doesNotMatch(JSON.stringify(card), /当前排位|下一轮队列/);
});
