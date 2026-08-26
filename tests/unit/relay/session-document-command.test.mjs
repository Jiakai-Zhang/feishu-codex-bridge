import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSessionDocumentCommand,
  formatSessionDocumentStatus,
  parseSessionDocumentAction,
} from "../../../src/relay/session-document-command.mjs";

test("parses document summary subcommands", () => {
  assert.deepEqual(parseSessionDocumentAction(""), { action: "status" });
  assert.deepEqual(parseSessionDocumentAction("create"), { action: "create" });
  assert.deepEqual(parseSessionDocumentAction("bind https://example.feishu.cn/docx/doc_test"), {
    action: "bind",
    url: "https://example.feishu.cn/docx/doc_test",
  });
  assert.deepEqual(parseSessionDocumentAction("summarize"), { action: "summarize" });
  assert.deepEqual(parseSessionDocumentAction("unbind"), { action: "unbind" });
  assert.throws(() => parseSessionDocumentAction("unknown"), /Invalid document summary command/);
});

test("formats a linked document without exposing internal binding IDs", () => {
  const markdown = formatSessionDocumentStatus({
    documentUrl: "https://example.feishu.cn/docx/doc_test",
    pending: [{ turnKey: "private" }],
    tabId: "tab_summary",
    lastSyncedAt: 1_700_000_000_000,
  });
  assert.match(markdown, /打开飞书文档/);
  assert.match(markdown, /待总结：1/);
  assert.match(markdown, /群标签页：已固定/);
  assert.doesNotMatch(markdown, /turnKey|private/);
});

test("executes document creation for the fixed group binding", async () => {
  let request;
  const record = {
    documentUrl: "https://example.feishu.cn/docx/doc_test",
    pending: [],
  };
  const markdown = await executeSessionDocumentCommand({ args: "create" }, {
    summaryCoordinator: {
      create: async (value) => {
        request = value;
        return record;
      },
    },
    summaryBinding: { groupChatId: "oc_group", threadId: "thread_fixed" },
    summaryTitle: "英语学习",
  });
  assert.deepEqual(request, {
    groupChatId: "oc_group",
    threadId: "thread_fixed",
    title: "英语学习",
  });
  assert.match(markdown, /持续摘要文档已更新/);
});
