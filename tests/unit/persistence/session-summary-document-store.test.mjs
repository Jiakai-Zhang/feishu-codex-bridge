import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionSummaryDocumentStore } from "../../../src/persistence/session-summary-document-store.mjs";

test("persists links, idempotent pending turns, and incremental commits", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "summary-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "summaries.json");
  const store = await SessionSummaryDocumentStore.open(filePath);
  await store.link({
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    documentUrl: "https://example.feishu.cn/docx/doc_test",
  });
  await store.setTab("oc_group", "tab_summary");
  assert.equal(await store.appendTurn({
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    turnId: "turn_1",
    content: "第一轮",
  }), true);
  assert.equal(await store.appendTurn({
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    turnId: "turn_1",
    content: "重复",
  }), false);
  const batch = store.selectBatch("oc_group");
  assert.equal(batch.entries.length, 1);
  await store.commitBatch("oc_group", [batch.entries[0].turnKey], "摘要一", 1234);
  const reopened = await SessionSummaryDocumentStore.open(filePath);
  assert.equal(reopened.get("oc_group").summary, "摘要一");
  assert.equal(reopened.get("oc_group").tabId, "tab_summary");
  assert.equal(reopened.get("oc_group").pending.length, 0);
  assert.equal(await reopened.appendTurn({
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    turnId: "turn_1",
    content: "仍然重复",
  }), false);
});
