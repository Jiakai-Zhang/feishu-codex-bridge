import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  extractCodexAnswerMedia,
  normalizeCodexLocalImagePath,
} from "./codex-answer-media.mjs";

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
