import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  extractCodexAnswerMedia,
  normalizeCodexLocalAttachmentPath,
  normalizeCodexLocalImagePath,
} from "../../../src/codex/codex-answer-media.mjs";

test("extracts a Codex Desktop local image and removes its visualize directive", () => {
  const answer = [
    "已加上 stage 坐标。",
    "",
    "![带像素格和stage坐标的荧光屏图像](/G:/Projects/auto_stigmator/output/pixel_stage_grid.png)",
    "",
    "其他像素还需要标定。",
    "",
    String.raw`::visualize{"path":"C:\\Users\\Admin\\.codex\\visualizations\\grid.html"}`,
  ].join("\n");

  const result = extractCodexAnswerMedia(answer);
  assert.deepEqual(result.segments.map((segment) => segment.type), ["text", "image", "text"]);
  assert.equal(result.segments[0].text, "已加上 stage 坐标。");
  assert.equal(result.segments[1].path, path.win32.normalize("G:/Projects/auto_stigmator/output/pixel_stage_grid.png"));
  assert.equal(result.segments[2].text, "其他像素还需要标定。");
  assert.equal(result.strippedDirectiveCount, 1);
  assert.equal(result.attachmentCount, 1);
  assert.equal(result.attachments[0].name, "grid.html");
  assert.equal(JSON.stringify(result.segments.filter((segment) => segment.type === "text")).includes("visualize"), false);
  assert.equal(JSON.stringify(result.segments.filter((segment) => segment.type === "text")).includes("G:/Projects"), false);
});

test("keeps remote Markdown images and user prose that only resembles a directive", () => {
  const result = extractCodexAnswerMedia([
    "![remote](https://example.com/image.png)",
    "prefix ::visualize{not-a-standalone-directive}",
  ].join("\n"));

  assert.equal(result.imageCount, 0);
  assert.equal(result.strippedDirectiveCount, 0);
  assert.equal(result.segments[0].text.includes("https://example.com/image.png"), true);
  assert.equal(result.segments[0].text.includes("prefix ::visualize"), true);
});

test("normalizes Windows Markdown and file URL paths without accepting relative paths", () => {
  assert.equal(
    normalizeCodexLocalImagePath("/C:/Users/Admin/image%20one.png"),
    path.win32.normalize("C:/Users/Admin/image one.png"),
  );
  assert.equal(normalizeCodexLocalImagePath("./image.png"), undefined);
  assert.equal(normalizeCodexLocalImagePath("https://example.com/image.png"), undefined);
  assert.equal(normalizeCodexLocalAttachmentPath("C:/repo/file.mjs:42"), undefined);
});

test("normalizes POSIX images and attachment names", () => {
  const result = extractCodexAnswerMedia([
    "![chart](/private/output/chart.png)",
    "[report](/private/output/report.pdf)",
    '::visualize{"path":"/private/output/result.html"}',
  ].join("\n"));
  assert.equal(result.segments[0].path, "/private/output/chart.png");
  assert.deepEqual(result.attachments.map(({ name }) => name), ["report", "result.html"]);
});

test("extracts local file links as native attachments without exposing their paths", () => {
  const result = extractCodexAnswerMedia([
    "结果见 [分析报告](C:/private/output/report.pdf)。",
    "[数据表](/C:/private/output/result.csv)",
    "源码位置：[relay](C:/repo/session-relay.mjs:640)",
  ].join("\n"));

  assert.deepEqual(result.attachments.map(({ name, source }) => ({ name, source })), [
    { name: "分析报告", source: "link" },
    { name: "数据表", source: "link" },
  ]);
  assert.equal(result.segments[0].text.includes("C:/private"), false);
  assert.match(result.segments[0].text, /📎 分析报告/);
  assert.match(result.segments[0].text, /session-relay\.mjs:640/);
});

test("extracts local videos for native Feishu file delivery", () => {
  const result = extractCodexAnswerMedia([
    "演示视频：[查看结果](/C:/private/output/demo.mp4)",
    "补充视频：[第二段](C:/private/output/second.webm)",
  ].join("\n"), { maxAttachments: Number.MAX_SAFE_INTEGER });

  assert.deepEqual(result.attachments.map(({ name, path: localPath }) => ({
    name,
    extension: path.win32.extname(localPath),
  })), [
    { name: "查看结果", extension: ".mp4" },
    { name: "第二段", extension: ".webm" },
  ]);
  assert.equal(result.omittedAttachmentCount, 0);
  assert.doesNotMatch(result.segments[0].text, /C:\\private|C:\/private/);
});

test("bounds distinct native attachments and reports omitted artifacts", () => {
  const result = extractCodexAnswerMedia([
    "[one](/C:/private/one.pdf)",
    "[two](/C:/private/two.pdf)",
  ].join("\n"), { maxAttachments: 1 });

  assert.equal(result.attachmentCount, 1);
  assert.equal(result.omittedAttachmentCount, 1);
  assert.equal(result.segments.at(-1).text.includes("1 个附件未发送"), true);
  assert.equal(JSON.stringify(result.segments).includes("C:/private"), false);
});

test("bounds extracted images without retaining their local paths in message text", () => {
  const result = extractCodexAnswerMedia([
    "![one](/C:/private/one.png)",
    "![two](/C:/private/two.png)",
  ].join("\n"), { maxImages: 1 });

  assert.equal(result.imageCount, 1);
  assert.equal(result.omittedImageCount, 1);
  assert.equal(result.segments.at(-1).text.includes("1 张图片未发送"), true);
  assert.equal(result.segments.at(-1).text.includes("C:/private"), false);
});

test("removes renderer-only memory citation metadata from the Feishu copy", () => {
  const result = extractCodexAnswerMedia([
    "visible answer",
    "",
    "<oai-mem-citation>",
    "<citation_entries>",
    "MEMORY.md:1-2|note=[internal]",
    "</citation_entries>",
    "<rollout_ids>",
    "019ff5b8-decb-7ca3-802c-f115f2f196de",
    "</rollout_ids>",
    "</oai-mem-citation>",
  ].join("\n"));

  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, "visible answer");
  assert.equal(result.strippedMetadataBlockCount, 1);
});

test("extracts inline Desktop file citations without exposing renderer metadata or paths", () => {
  const result = extractCodexAnswerMedia('更新版共 11 页：:codex-file-citation{path="C:/private/output/入口 对照.pdf" title="report"} 请查收。');
  assert.deepEqual(result.attachments, [{
    type: "attachment",
    path: path.win32.normalize("C:/private/output/入口 对照.pdf"),
    name: "入口 对照.pdf",
    source: "file-citation",
  }]);
  assert.equal(result.segments[0].text, "更新版共 11 页：📎 入口 对照.pdf 请查收。");
  assert.doesNotMatch(JSON.stringify(result.segments), /private|codex-file-citation|title=/);
});

test("supports quoted citation attributes, Windows backslashes, POSIX and encoded paths", () => {
  const result = extractCodexAnswerMedia([
    String.raw`:codex-file-citation{label="first" path = "C:\private\output\one.pdf" }`,
    ":codex-file-citation{path='/private/output/report {final}.pdf'}",
    ':codex-file-citation{path="/C:/private/output/report%20two.pdf"}',
    ':codex-file-citation{path="file:///C:/private/output/three.pdf"}',
  ].join("\n"));
  assert.deepEqual(result.attachments.map(({ name }) => name), [
    "one.pdf", "report {final}.pdf", "report two.pdf", "three.pdf",
  ]);
  assert.equal(result.attachments[0].path, path.win32.normalize("C:/private/output/one.pdf"));
  assert.doesNotMatch(JSON.stringify(result.segments), /private|codex-file-citation/);
});

test("deduplicates citations with Markdown links and visualize attachments and respects limits", () => {
  const result = extractCodexAnswerMedia([
    ':codex-file-citation{path="C:/private/one.pdf"} :codex-file-citation{path="C:/private/two.mp4"}',
    "[one again](C:/private/one.pdf)",
    '::visualize{"path":"C:/private/two.mp4"}',
    ':codex-file-citation{path="C:/private/two.mp4"}',
  ].join("\n"), { maxAttachments: 1 });
  assert.equal(result.attachmentCount, 1);
  assert.equal(result.omittedAttachmentCount, 1);
  assert.equal(result.attachments[0].name, "one.pdf");
  assert.doesNotMatch(JSON.stringify(result.segments), /private|codex-file-citation/);
});

test("rejects unsafe or malformed file citations without leaking their renderer attributes", () => {
  for (const attributes of [
    'path="https://example.com/report.pdf"',
    'path="./report.pdf"',
    'path="C:/private/code.mjs:42"',
    'notpath="C:/private/report.pdf"',
    'path="C:/private/report.pdf" path="C:/private/other.pdf"',
    'path="C:/private/report.pdf"junk="value"',
    'path=C:/private/report.pdf',
    'path="C:/private/report.pdf" broken',
    'path="C:/private/report.pdf',
  ]) {
    const result = extractCodexAnswerMedia(`prefix :codex-file-citation{${attributes}} suffix`);
    assert.equal(result.attachmentCount, 0, attributes);
    assert.doesNotMatch(JSON.stringify(result.segments), /private|codex-file-citation|example\.com/, attributes);
    assert.match(result.segments[0].text, /^prefix /);
  }
  const unterminated = extractCodexAnswerMedia('result :codex-file-citation{path="C:/private/report.pdf"');
  assert.equal(unterminated.attachmentCount, 0);
  assert.doesNotMatch(unterminated.segments[0].text, /private|codex-file-citation/);
});
