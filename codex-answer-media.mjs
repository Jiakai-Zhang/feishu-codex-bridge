import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKDOWN_IMAGE_LINE = /^\s*!\[([^\]\r\n]*)\]\((.+)\)\s*$/;
const VISUALIZE_DIRECTIVE_LINE = /^\s*::visualize\s*\{[^\r\n]*\}\s*$/i;

function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export function normalizeCodexLocalImagePath(value) {
  let target = String(value || "").trim();
  if (!target || /[\u0000-\u001f\u007f]/.test(target)) return undefined;

  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  target = safeDecodeURIComponent(target);

  if (/^file:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (url.protocol !== "file:") return undefined;
      target = fileURLToPath(url);
    } catch {
      return undefined;
    }
  }

  // Codex Desktop renders Windows drive paths with an extra leading slash.
  if (/^\/[A-Za-z]:[\\/]/.test(target)) target = target.slice(1);
  if (/^[A-Za-z]:[\\/]/.test(target)) {
    return path.win32.normalize(target.replaceAll("/", "\\"));
  }
  if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(target)) {
    return path.win32.normalize(target.replaceAll("/", "\\"));
  }
  if (path.isAbsolute(target)) return path.normalize(target);
  return undefined;
}

function freezeSegment(segment) {
  return Object.freeze(segment);
}

export function extractCodexAnswerMedia(value, { maxImages = 10 } = {}) {
  const limit = Math.max(0, Number(maxImages) || 0);
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const segments = [];
  let textLines = [];
  let strippedDirectiveCount = 0;
  let strippedMetadataBlockCount = 0;
  let omittedImageCount = 0;
  let imageCount = 0;
  let insideMetadataBlock = false;

  const flushText = () => {
    const text = textLines.join("\n").trim();
    textLines = [];
    if (text) segments.push(freezeSegment({ type: "text", text }));
  };

  for (const line of lines) {
    if (line.trim() === "<oai-mem-citation>") {
      insideMetadataBlock = true;
      strippedMetadataBlockCount += 1;
      continue;
    }
    if (insideMetadataBlock) {
      if (line.trim() === "</oai-mem-citation>") insideMetadataBlock = false;
      continue;
    }
    if (VISUALIZE_DIRECTIVE_LINE.test(line)) {
      strippedDirectiveCount += 1;
      continue;
    }

    const imageMatch = line.match(MARKDOWN_IMAGE_LINE);
    const localPath = imageMatch ? normalizeCodexLocalImagePath(imageMatch[2]) : undefined;
    if (!localPath) {
      textLines.push(line);
      continue;
    }

    flushText();
    if (imageCount < limit) {
      segments.push(freezeSegment({
        type: "image",
        path: localPath,
        alt: String(imageMatch[1] || "").trim().slice(0, 200),
      }));
      imageCount += 1;
    } else {
      omittedImageCount += 1;
    }
  }
  flushText();

  if (omittedImageCount > 0) {
    segments.push(freezeSegment({
      type: "text",
      text: `（另有 ${omittedImageCount} 张图片未发送；完整回答保留在绑定的 Codex 任务中。）`,
    }));
  }

  return Object.freeze({
    segments: Object.freeze(segments),
    imageCount,
    omittedImageCount,
    strippedDirectiveCount,
    strippedMetadataBlockCount,
  });
}
