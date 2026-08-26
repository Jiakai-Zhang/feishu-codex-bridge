import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionSummaryDocumentStore } from "../../../src/persistence/session-summary-document-store.mjs";
import {
  buildCompletedTurnSummaryDelta,
  SessionSummaryCoordinator,
} from "../../../src/relay/session-summary-coordinator.mjs";

function turn(turnId, prompt, answer) {
  return {
    chatId: "oc_group",
    threadId: "thread_fixed",
    turnId,
    promptEntries: [{ text: prompt, resources: [] }],
    answer,
    completedAtMs: Date.now(),
  };
}

test("formats only the completed turn as summary delta", () => {
  assert.equal(
    buildCompletedTurnSummaryDelta(turn("turn_1", "新问题", "新回答")),
    "用户：新问题\n\n助手：新回答",
  );
});

test("keeps both the user input and assistant answer when a turn is truncated", () => {
  const delta = buildCompletedTurnSummaryDelta(
    turn("turn_1", `问题${"甲".repeat(2_000)}`, `回答${"乙".repeat(2_000)}`),
    { maxChars: 1_000 },
  );
  assert.equal(delta.length <= 1_000, true);
  assert.match(delta, /^用户：问题/);
  assert.match(delta, /助手：回答/);
});

test("rolls old summary plus only unsummarized turns into each update", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "summary-coordinator-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await SessionSummaryDocumentStore.open(path.join(directory, "summaries.json"));
  await store.link({
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    documentUrl: "https://example.feishu.cn/docx/doc_test",
  });
  const requests = [];
  const updates = [];
  const coordinator = new SessionSummaryCoordinator({
    store,
    debounceMs: 60_000,
    documentManager: { update: async (value) => updates.push(value) },
    summarizer: {
      summarize: async (value) => {
        requests.push(value);
        return requests.length === 1 ? "摘要一" : "摘要二";
      },
    },
  });
  await coordinator.recordTurn(turn("turn_1", "问题一", "回答一"));
  await coordinator.syncNow("oc_group");
  await coordinator.recordTurn(turn("turn_2", "问题二", "回答二"));
  await coordinator.syncNow("oc_group");
  coordinator.stop();

  assert.equal(requests[0].previousSummary, "");
  assert.match(requests[0].newContent, /问题一/);
  assert.equal(requests[1].previousSummary, "摘要一");
  assert.match(requests[1].newContent, /问题二/);
  assert.doesNotMatch(requests[1].newContent, /问题一/);
  assert.deepEqual(updates.map((entry) => entry.summary), ["摘要一", "摘要二"]);
  assert.equal(store.get("oc_group").pending.length, 0);
});

test("pins a linked summary document to the group and removes only that tab on unbind", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "summary-tab-coordinator-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await SessionSummaryDocumentStore.open(path.join(directory, "summaries.json"));
  const tabCalls = [];
  const coordinator = new SessionSummaryCoordinator({
    store,
    documentManager: {
      create: async () => ({ url: "https://example.feishu.cn/docx/doc_test" }),
      update: async () => {},
    },
    tabManager: {
      ensure: async (value) => {
        tabCalls.push({ action: "ensure", value });
        return { tabId: "tab_summary" };
      },
      remove: async (value) => tabCalls.push({ action: "remove", value }),
    },
    summarizer: { summarize: async () => "摘要" },
  });
  const linked = await coordinator.create({
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    title: "英语学习",
  });
  assert.equal(linked.tabId, "tab_summary");
  assert.deepEqual(tabCalls[0], {
    action: "ensure",
    value: {
      chatId: "oc_group",
      documentUrl: "https://example.feishu.cn/docx/doc_test",
      tabName: "持续摘要",
    },
  });
  await coordinator.unbind("oc_group");
  assert.equal(store.get("oc_group"), undefined);
  assert.deepEqual(tabCalls[1], {
    action: "remove",
    value: {
      chatId: "oc_group",
      documentUrl: "https://example.feishu.cn/docx/doc_test",
      tabId: "tab_summary",
    },
  });
});

test("waits for an in-flight summary update before removing the document binding", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "summary-unbind-race-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await SessionSummaryDocumentStore.open(path.join(directory, "summaries.json"));
  await store.link({
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    documentUrl: "https://example.feishu.cn/docx/doc_test",
  });
  let releaseSummary;
  let markSummaryStarted;
  const summaryStarted = new Promise((resolve) => { markSummaryStarted = resolve; });
  const coordinator = new SessionSummaryCoordinator({
    store,
    debounceMs: 60_000,
    documentManager: { update: async () => {} },
    summarizer: {
      summarize: async () => {
        markSummaryStarted();
        return new Promise((resolve) => { releaseSummary = resolve; });
      },
    },
  });
  await coordinator.recordTurn(turn("turn_1", "问题", "回答"));
  const sync = coordinator.syncNow("oc_group");
  await summaryStarted;
  let unbound = false;
  const removal = coordinator.unbind("oc_group").then(() => { unbound = true; });
  await Promise.resolve();
  assert.equal(unbound, false);
  releaseSummary("摘要");
  await Promise.all([sync, removal]);
  assert.equal(store.get("oc_group"), undefined);
  coordinator.stop();
});

test("discards local summary state even when Session deletion cannot remove the tab", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "summary-delete-cleanup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await SessionSummaryDocumentStore.open(path.join(directory, "summaries.json"));
  await store.link({
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    documentUrl: "https://example.feishu.cn/docx/doc_test",
  });
  const logs = [];
  const coordinator = new SessionSummaryCoordinator({
    store,
    documentManager: { update: async () => {} },
    tabManager: {
      remove: async () => {
        throw Object.assign(new Error("tab unavailable"), { code: "summary_tab_api_error" });
      },
    },
    summarizer: { summarize: async () => "摘要" },
    log: (message) => logs.push(message),
  });
  const removed = await coordinator.discard("oc_group");
  assert.equal(removed.groupChatId, "oc_group");
  assert.equal(store.get("oc_group"), undefined);
  assert.match(logs[0], /summary_tab_api_error/);
  coordinator.stop();
});

test("keeps the document linked when background tab pinning needs a retry", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "summary-tab-retry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await SessionSummaryDocumentStore.open(path.join(directory, "summaries.json"));
  const error = Object.assign(new Error("missing scope"), { code: "summary_tab_auth_required" });
  const coordinator = new SessionSummaryCoordinator({
    store,
    retryMs: 60_000,
    documentManager: {
      bind: async ({ url }) => ({ url }),
      update: async () => {},
    },
    tabManager: { ensure: async () => { throw error; } },
    summarizer: { summarize: async () => "摘要" },
  });
  const linked = await coordinator.bind({
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    url: "https://example.feishu.cn/docx/doc_test",
  });
  assert.equal(linked.documentUrl, "https://example.feishu.cn/docx/doc_test");
  assert.equal(linked.tabId, undefined);
  assert.equal(linked.tabLastErrorCode, "summary_tab_auth_required");
  coordinator.stop();
});
