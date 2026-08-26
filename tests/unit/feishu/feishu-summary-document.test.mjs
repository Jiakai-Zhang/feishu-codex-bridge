import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSummaryBlockXml,
  buildSummaryDocumentXml,
  FeishuSummaryDocumentManager,
  locateSummarySection,
  SUMMARY_SECTION_MARKER,
} from "../../../src/feishu/feishu-summary-document.mjs";

const URL = "https://example.feishu.cn/docx/doc_summary_test";
const LOCATED = `<fragment><p id="marker_block">${SUMMARY_SECTION_MARKER}</p><p id="summary_block">暂无</p></fragment>`;

test("builds valid single-block XML for rolling summaries", () => {
  assert.match(buildSummaryDocumentXml("英语 & 学习"), /<title>英语 &amp; 学习<\/title>/);
  assert.equal(buildSummaryBlockXml("第一行\n第二行 <x>"), "<p>第一行<br/>第二行 &lt;x&gt;</p>");
  assert.deepEqual(locateSummarySection(LOCATED), {
    markerBlockId: "marker_block",
    summaryBlockId: "summary_block",
  });
});

test("creates a document and locates its managed summary section", async () => {
  const calls = [];
  const manager = new FeishuSummaryDocumentManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli-entry",
    runCommand: async (_node, _entry, args, options) => {
      calls.push({ args, input: options.input });
      if (args.includes("+create")) return { ok: true, data: { document: { url: URL } } };
      return { ok: true, data: { document: { content: LOCATED } } };
    },
  });
  const result = await manager.create({ title: "主题群" });
  assert.equal(result.url, URL);
  assert.equal(result.summaryBlockId, "summary_block");
  assert.match(calls[0].input, /主题群/);
  assert.equal(calls[1].args.includes("keyword"), true);
});

test("binding an existing document appends the managed section only when absent", async () => {
  const calls = [];
  let fetches = 0;
  const manager = new FeishuSummaryDocumentManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli-entry",
    runCommand: async (_node, _entry, args, options) => {
      calls.push({ args, input: options.input });
      if (args.includes("+fetch")) {
        fetches += 1;
        return { ok: true, data: { document: { content: fetches === 1 ? "<fragment></fragment>" : LOCATED } } };
      }
      return { ok: true, data: { result: "success" } };
    },
  });
  await manager.bind({ url: URL });
  const append = calls.find((call) => call.args.includes("+update"));
  assert.equal(append.args.includes("append"), true);
  assert.match(append.input, new RegExp(SUMMARY_SECTION_MARKER));
});

test("updates only the managed summary block", async () => {
  const calls = [];
  const manager = new FeishuSummaryDocumentManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli-entry",
    runCommand: async (_node, _entry, args, options) => {
      calls.push({ args, input: options.input });
      if (args.includes("+fetch")) return { ok: true, data: { document: { content: LOCATED } } };
      return { ok: true, data: { result: "success" } };
    },
  });
  await manager.update({ url: URL, summary: "新摘要\n第二行" });
  const update = calls.at(-1);
  assert.deepEqual(update.args.slice(update.args.indexOf("--command"), update.args.indexOf("--command") + 4), [
    "--command", "block_replace", "--block-id", "summary_block",
  ]);
  assert.equal(update.input, "<p>新摘要<br/>第二行</p>");
});
