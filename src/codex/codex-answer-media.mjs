import path from "node:path";
import { fileURLToPath } from "node:url";
import { basenameFsPath } from "../runtime/shared/fs-paths.mjs";

const MARKDOWN_IMAGE_LINE = /^\s*!\[([^\]\r\n]*)\]\((.+)\)\s*$/;
const MARKDOWN_LINK = /\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g;
const VISUALIZE_DIRECTIVE_LINE = /^\s*::visualize\s*(\{[^\r\n]*\})\s*$/i;

function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export function normalizeCodexLocalAttachmentPath(value) {
  let target = String(value || "").trim();
  if (!target || /[\u0000-\u001f\u007f]/.test(target)) return undefined;

  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  target = safeDecodeURIComponent(target);
  if (/(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)$/i.test(target)) return undefined;

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

export function normalizeCodexLocalImagePath(value) {
  return normalizeCodexLocalAttachmentPath(value);
}

function safeAttachmentName(value, localPath) {
  const requested = String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const fallback = basenameFsPath(localPath);
  return (requested || fallback || "Codex 附件").slice(0, 200);
}

function visualizeAttachmentFromLine(line) {
  const match = line.match(VISUALIZE_DIRECTIVE_LINE);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]);
    const localPath = normalizeCodexLocalAttachmentPath(value?.path);
    if (!localPath) return undefined;
    return Object.freeze({
      type: "attachment",
      path: localPath,
      name: safeAttachmentName(undefined, localPath),
      source: "visualize",
    });
  } catch {
    return undefined;
  }
}

function freezeSegment(segment) {
  return Object.freeze(segment);
}

export function extractCodexAnswerMedia(value, { maxImages = 10, maxAttachments = 10 } = {}) {
  const limit = Math.max(0, Number(maxImages) || 0);
  const attachmentLimit = Math.max(0, Number(maxAttachments) || 0);
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const segments = [];
  const attachments = [];
  const attachmentPaths = new Set();
  let textLines = [];
  let strippedDirectiveCount = 0;
  let strippedMetadataBlockCount = 0;
  let omittedImageCount = 0;
  let omittedAttachmentCount = 0;
  let imageCount = 0;
  let insideMetadataBlock = false;

  const flushText = () => {
    const text = textLines.join("\n").trim();
    textLines = [];
    if (text) segments.push(freezeSegment({ type: "text", text }));
  };

  const addAttachment = (attachment) => {
    if (!attachment?.path || attachmentPaths.has(attachment.path)) return;
    attachmentPaths.add(attachment.path);
    if (attachments.length >= attachmentLimit) {
      omittedAttachmentCount += 1;
      return;
    }
    attachments.push(freezeSegment({
      type: "attachment",
      path: attachment.path,
      name: safeAttachmentName(attachment.name, attachment.path),
      source: attachment.source || "link",
    }));
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
    const visualizeAttachment = visualizeAttachmentFromLine(line);
    if (VISUALIZE_DIRECTIVE_LINE.test(line)) {
      strippedDirectiveCount += 1;
      if (visualizeAttachment) addAttachment(visualizeAttachment);
      continue;
    }

    const imageMatch = line.match(MARKDOWN_IMAGE_LINE);
    const localPath = imageMatch ? normalizeCodexLocalImagePath(imageMatch[2]) : undefined;
    if (!localPath) {
      const sanitizedLine = line.replace(MARKDOWN_LINK, (full, label, target, offset, source) => {
        if (offset > 0 && source[offset - 1] === "!") return full;
        const attachmentPath = normalizeCodexLocalAttachmentPath(target);
        if (!attachmentPath) return full;
        const name = safeAttachmentName(label, attachmentPath);
        addAttachment({ path: attachmentPath, name, source: "link" });
        return `📎 ${name}`;
      });
      textLines.push(sanitizedLine);
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
  if (omittedAttachmentCount > 0) {
    segments.push(freezeSegment({
      type: "text",
      text: `（另有 ${omittedAttachmentCount} 个附件未发送；完整回答保留在绑定的 Codex 任务中。）`,
    }));
  }

  return Object.freeze({
    segments: Object.freeze(segments),
    attachments: Object.freeze(attachments),
    imageCount,
    omittedImageCount,
    attachmentCount: attachments.length,
    omittedAttachmentCount,
    strippedDirectiveCount,
    strippedMetadataBlockCount,
  });
}
