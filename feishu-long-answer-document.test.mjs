import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLongAnswerDocumentMarkdown,
  buildLongAnswerDocumentTitle,
  FeishuLongAnswerDocumentManager,
  LongAnswerDocumentStore,
  shouldCreateLongAnswerDocument,
} from "./feishu-long-answer-document.mjs";

test("detects answers that exceed the Feishu reply threshold", () => {
  assert.equal(shouldCreateLongAnswerDocument("12345", 4), true);
  assert.equal(shouldCreateLongAnswerDocument("1234", 4), false);
});

test("builds document markdown without local image paths", () => {
  const markdown = buildLongAnswerDocumentMarkdown([
    { type: "text", text: "## 结果\n\n正文" },
    { type: "image", path: "C:\\private\\chart.png", alt: "趋势图" },
  ]);
  assert.match(markdown, /## 结果/);
  assert.match(markdown, /图片将在飞书消息中单独投递：趋势图/);
  assert.doesNotMatch(markdown, /C:\\private/);
});

test("creates a user-owned Markdown document with content on stdin", async () => {
  let call;
  const manager = new FeishuLongAnswerDocumentManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    runCommand: async (...args) => {
      call = args;
      return { ok: true, data: { document: { url: "https://example.feishu.cn/docx/document-token" } } };
    },
  });
  const result = await manager.create({ title: "完整回答", markdown: "## 内容\n\n正文" });
  assert.equal(result.url, "https://example.feishu.cn/docx/document-token");
  assert.deepEqual(call[2].slice(0, 6), ["docs", "+create", "--as", "user", "--doc-format", "markdown"]);
  assert.equal(call[2][call[2].indexOf("--content") + 1], "-");
  assert.equal(call[3].input, "## 内容\n\n正文");
  assert.doesNotMatch(call[2].join(" "), /正文/);
});

test("rejects a non-HTTPS document response", async () => {
  const manager = new FeishuLongAnswerDocumentManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    runCommand: async () => ({ ok: true, data: { document: { url: "file:///private/doc" } } }),
  });
  await assert.rejects(manager.create({ title: "回答", markdown: "正文" }), /safe document URL/);
});

test("persists a created document so a retried turn reuses it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "long-answer-doc-"));
  const filePath = path.join(directory, "documents.json");
  const store = await LongAnswerDocumentStore.open(filePath);
  await store.put({
    threadId: "thread-a",
    turnId: "turn-a",
    url: "https://example.feishu.cn/docx/document-token",
    createdAt: 100,
  });
  const reopened = await LongAnswerDocumentStore.open(filePath);
  assert.equal(reopened.get("thread-a", "turn-a").url, "https://example.feishu.cn/docx/document-token");
  assert.equal(await reopened.remove("thread-a", "turn-a"), true);
  assert.equal(reopened.get("thread-a", "turn-a"), undefined);
});

test("formats a privacy-neutral title from completion time", () => {
  const title = buildLongAnswerDocumentTitle(Date.UTC(2026, 7, 14, 1, 2), "Asia/Shanghai");
  assert.match(title, /^Codex 完整回答/);
  assert.doesNotMatch(title, /thread|turn|project/i);
});
