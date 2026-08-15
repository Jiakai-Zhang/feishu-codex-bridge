import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_INBOUND_ATTACHMENT_LIMITS = Object.freeze({
  maxItems: 10,
  maxFileBytes: 30 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxCacheBytes: 1024 * 1024 * 1024,
});

const SUPPORTED_RESOURCE_TYPES = new Set(["image", "file", "audio", "video"]);
const CONTEXT_START = "<feishu_bridge_local_attachments version=\"1\">";
const CONTEXT_END = "</feishu_bridge_local_attachments>";
const CONTEXT_PATTERN = /<feishu_bridge_local_attachments version="1">\s*([\s\S]*?)\s*<\/feishu_bridge_local_attachments>/g;
const CODEX_DESKTOP_FILES_HEADING = "# Files mentioned by the user:";
const CODEX_DESKTOP_REQUEST_HEADING = "## My request for Codex:";
const CODEX_DESKTOP_REQUEST_HEADINGS = new Set([
  CODEX_DESKTOP_REQUEST_HEADING,
  "## My request:",
]);
const CODEX_DESKTOP_FILE_ENTRY = /^##\s+(.+?):\s+((?:[A-Za-z]:[\\/]|\\\\|\/|file:\/\/|https?:\/\/).+)$/i;

const CONTENT_TYPE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["image/tiff", ".tiff"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["application/pdf", ".pdf"],
  ["application/zip", ".zip"],
  ["application/json", ".json"],
  ["text/plain", ".txt"],
  ["text/csv", ".csv"],
  ["audio/mpeg", ".mp3"],
  ["audio/mp4", ".m4a"],
  ["audio/wav", ".wav"],
  ["audio/x-wav", ".wav"],
  ["audio/ogg", ".ogg"],
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);

export class FeishuInboundAttachmentError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "FeishuInboundAttachmentError";
    this.code = code;
  }
}

function attachmentError(code, message, options) {
  return new FeishuInboundAttachmentError(code, message, options);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedContentType(value) {
  const contentType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return contentType || undefined;
}

function responseHeader(raw, name) {
  if (!raw || typeof raw !== "object") return undefined;
  const headers = raw.headers;
  if (!headers || typeof headers !== "object") return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name.toLowerCase()] ?? headers[name] ?? headers[name.replace(/(^|-)([a-z])/g, (_, dash, letter) => `${dash}${letter.toUpperCase()}`)];
}

function responseContentType(raw) {
  return normalizedContentType(responseHeader(raw, "content-type"));
}

function responseContentLength(raw) {
  const size = Number(responseHeader(raw, "content-length"));
  return Number.isFinite(size) && size >= 0 ? size : undefined;
}

function byteLimitTransform(maxBytes) {
  let bytesWritten = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesWritten += buffer.length;
      if (bytesWritten > maxBytes) {
        callback(attachmentError("attachment_too_large", "Feishu attachment exceeds the configured per-file limit"));
        return;
      }
      callback(null, buffer);
    },
  });
  return { stream, bytesWritten: () => bytesWritten };
}

async function writeBoundedDownload(raw, destination, maxBytes) {
  const advertisedSize = responseContentLength(raw);
  if (advertisedSize != null && advertisedSize > maxBytes) {
    throw attachmentError("attachment_too_large", "Feishu attachment exceeds the configured per-file limit");
  }
  if (raw && typeof raw === "object" && typeof raw.getReadableStream === "function") {
    const limiter = byteLimitTransform(maxBytes);
    await pipeline(
      raw.getReadableStream(),
      limiter.stream,
      createWriteStream(destination, { flags: "w", mode: 0o600 }),
    );
    return limiter.bytesWritten();
  }
  const data = Buffer.isBuffer(raw)
    ? raw
    : raw instanceof Uint8Array
      ? Buffer.from(raw)
      : Buffer.isBuffer(raw?.data)
        ? raw.data
        : raw?.data instanceof Uint8Array
          ? Buffer.from(raw.data)
          : undefined;
  if (!data) throw attachmentError("attachment_download_failed", "Unexpected Feishu attachment response");
  if (data.length > maxBytes) {
    throw attachmentError("attachment_too_large", "Feishu attachment exceeds the configured per-file limit");
  }
  await fs.writeFile(destination, data, { mode: 0o600 });
  return data.length;
}

async function downloadResource(channel, { messageId, fileKey, downloadType, destination, maxBytes }) {
  const getResource = channel?.rawClient?.im?.v1?.messageResource?.get;
  if (typeof getResource === "function") {
    const raw = await getResource.call(channel.rawClient.im.v1.messageResource, {
      path: { message_id: messageId, file_key: fileKey },
      params: { type: downloadType },
    });
    return Object.freeze({
      contentType: responseContentType(raw),
      bytesWritten: await writeBoundedDownload(raw, destination, maxBytes),
    });
  }
  if (typeof channel?.downloadResourceToFile !== "function") {
    throw attachmentError("attachment_download_failed", "Feishu resource download is unavailable");
  }
  const result = await channel.downloadResourceToFile(messageId, fileKey, downloadType, destination);
  const bytesWritten = Number(result?.bytesWritten);
  if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) {
    throw attachmentError("attachment_download_failed", "Feishu returned an empty attachment");
  }
  if (bytesWritten > maxBytes) {
    throw attachmentError("attachment_too_large", "Feishu attachment exceeds the configured per-file limit");
  }
  return Object.freeze({
    contentType: normalizedContentType(result?.contentType),
    bytesWritten,
  });
}

function messageDirectoryName(messageId) {
  return createHash("sha256").update(String(messageId)).digest("hex").slice(0, 32);
}

function defaultResourceName(type) {
  switch (type) {
    case "audio": return "audio";
    case "video": return "video";
    case "image": return "image";
    default: return "attachment";
  }
}

export function safeInboundAttachmentName(value, fallback = "attachment") {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f<>:\"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  const backup = String(fallback || "attachment")
    .replace(/[\u0000-\u001f\u007f<>:\"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim() || "attachment";
  const requested = cleaned || backup;
  if (requested.length <= 180) return requested;
  const extension = path.extname(requested).slice(0, 20);
  return `${requested.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
}

function resourceExtension(resource, contentType) {
  const detected = CONTENT_TYPE_EXTENSIONS.get(contentType);
  if (contentType?.startsWith("image/") && detected) return detected;
  const supplied = path.extname(String(resource?.fileName || "")).toLowerCase();
  if (supplied && /^[.][a-z0-9]{1,12}$/i.test(supplied)) return supplied;
  return detected || "";
}

function downloadedKind(resource, contentType, extension) {
  if (contentType?.startsWith("image/") && contentType !== "image/svg+xml") return "image";
  if (resource.type === "image" && (!contentType || contentType.startsWith("image/"))) return "image";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "file";
}

export function normalizeInboundResourceDescriptors(resources) {
  if (!Array.isArray(resources)) return Object.freeze([]);
  const unique = new Map();
  for (const resource of resources) {
    const type = String(resource?.type || "").trim().toLowerCase();
    const fileKey = String(resource?.fileKey || "").trim();
    if (!SUPPORTED_RESOURCE_TYPES.has(type) || !fileKey) continue;
    const key = `${type}:${fileKey}`;
    if (unique.has(key)) continue;
    unique.set(key, Object.freeze({
      type,
      fileKey,
      fileName: resource?.fileName ? safeInboundAttachmentName(resource.fileName) : undefined,
    }));
  }
  return Object.freeze([...unique.values()]);
}

export function sanitizeFeishuResourceContent(value, resources) {
  let text = String(value || "");
  for (const resource of normalizeInboundResourceDescriptors(resources)) {
    const key = escapeRegExp(resource.fileKey);
    text = text
      .replace(new RegExp(`!\\[[^\\]]*\\]\\(${key}\\)`, "g"), "")
      .replace(new RegExp(`<(?:file|audio|video)\\b[^>]*\\bkey=(?:\"${key}\"|'${key}')[^>]*/?>`, "gi"), "");
  }
  return text
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeCodexPromptAttachments(attachments) {
  if (!Array.isArray(attachments)) return Object.freeze([]);
  return Object.freeze(attachments.map((attachment, index) => {
    const kind = attachment?.kind === "image" ? "image" : "file";
    const localPath = String(attachment?.localPath || "");
    const name = safeInboundAttachmentName(attachment?.name, `${kind}-${index + 1}`);
    if (!path.isAbsolute(localPath)) throw new TypeError("Codex prompt attachment path must be absolute");
    const size = Number(attachment?.size);
    return Object.freeze({
      kind,
      localPath: path.resolve(localPath),
      name,
      contentType: normalizedContentType(attachment?.contentType),
      size: Number.isFinite(size) && size > 0 ? size : undefined,
    });
  }));
}

export function buildFeishuAttachmentContext(attachments) {
  const files = normalizeCodexPromptAttachments(attachments)
    .filter(({ kind }) => kind === "file")
    .map(({ name, localPath, contentType, size }) => ({ name, path: localPath, contentType, size }));
  if (files.length === 0) return "";
  return `${CONTEXT_START}\n${JSON.stringify({
    instruction: "These are user-provided Feishu attachments. Read them with local tools when relevant and never expose their local paths in the answer.",
    files,
  })}\n${CONTEXT_END}`;
}

export function parseFeishuAttachmentContexts(value) {
  const records = [];
  const text = String(value || "");
  CONTEXT_PATTERN.lastIndex = 0;
  for (let match; (match = CONTEXT_PATTERN.exec(text)) !== null;) {
    try {
      const parsed = JSON.parse(match[1]);
      for (const file of parsed?.files || []) {
        const localPath = String(file?.path || "");
        if (!path.isAbsolute(localPath)) continue;
        records.push(Object.freeze({
          kind: "file",
          localPath: path.resolve(localPath),
          name: safeInboundAttachmentName(file?.name),
          contentType: normalizedContentType(file?.contentType),
          size: Number(file?.size) || undefined,
        }));
      }
    } catch {
      // A malformed lookalike remains ordinary user text and yields no attachment metadata.
    }
  }
  CONTEXT_PATTERN.lastIndex = 0;
  return Object.freeze(records);
}

export function stripFeishuAttachmentContexts(value) {
  const original = String(value || "");
  CONTEXT_PATTERN.lastIndex = 0;
  let matchedValidContext = false;
  const stripped = original.replace(CONTEXT_PATTERN, (block, payload) => {
    try {
      const parsed = JSON.parse(payload);
      if (!Array.isArray(parsed?.files)) return block;
      matchedValidContext = true;
      return "";
    } catch {
      return block;
    }
  });
  CONTEXT_PATTERN.lastIndex = 0;
  if (!matchedValidContext) return original;
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

export function buildCodexDesktopFilePrompt(text, attachments) {
  const files = normalizeCodexPromptAttachments(attachments).filter(({ kind }) => kind === "file");
  if (files.length === 0) return String(text || "");
  const lines = ["", CODEX_DESKTOP_FILES_HEADING, ""];
  for (const file of files) {
    if (/[\r\n]/.test(file.localPath)) throw new TypeError("Codex prompt attachment path contains a line break");
    lines.push(`## ${file.name}: ${file.localPath}`, "");
  }
  lines.push(CODEX_DESKTOP_REQUEST_HEADING, String(text || ""));
  return lines.join("\n");
}

export function parseCodexDesktopFilePrompt(value) {
  const original = String(value || "");
  const lines = original.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines[0]?.trim() !== CODEX_DESKTOP_FILES_HEADING) return undefined;

  const files = [];
  let cursor = 1;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor].trim();
    if (!line) continue;
    if (CODEX_DESKTOP_REQUEST_HEADINGS.has(line)) break;
    const match = CODEX_DESKTOP_FILE_ENTRY.exec(line);
    if (!match) return undefined;
    files.push(Object.freeze({
      name: safeInboundAttachmentName(match[1]),
      path: match[2],
    }));
  }
  if (files.length === 0 || !CODEX_DESKTOP_REQUEST_HEADINGS.has(lines[cursor]?.trim())) return undefined;
  return Object.freeze({
    text: lines.slice(cursor + 1).join("\n").trim(),
    files: Object.freeze(files),
  });
}

export function buildCodexPromptInput({ text, attachments } = {}) {
  const normalizedAttachments = normalizeCodexPromptAttachments(attachments);
  const input = [];
  const promptText = buildCodexDesktopFilePrompt(text, normalizedAttachments);
  if (promptText.trim()) input.push({ type: "text", text: promptText, text_elements: [] });
  for (const attachment of normalizedAttachments) {
    if (attachment.kind === "image") input.push({ type: "localImage", path: attachment.localPath });
  }
  if (input.length === 0) throw new TypeError("Codex prompt is empty");
  return Object.freeze(input.map((item) => Object.freeze(item)));
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directorySize(itemPath);
    else if (entry.isFile()) total += Number((await fs.stat(itemPath)).size) || 0;
  }
  return total;
}

export class FeishuInboundAttachmentStore {
  constructor(rootDir, options = {}) {
    if (!path.isAbsolute(String(rootDir || ""))) throw new TypeError("Inbound attachment cache root must be absolute");
    this.rootDir = path.resolve(rootDir);
    this.maxItems = Number(options.maxItems) || DEFAULT_INBOUND_ATTACHMENT_LIMITS.maxItems;
    this.maxFileBytes = Number(options.maxFileBytes) || DEFAULT_INBOUND_ATTACHMENT_LIMITS.maxFileBytes;
    this.maxTotalBytes = Number(options.maxTotalBytes) || DEFAULT_INBOUND_ATTACHMENT_LIMITS.maxTotalBytes;
    this.retentionMs = Number(options.retentionMs) || DEFAULT_INBOUND_ATTACHMENT_LIMITS.retentionMs;
    this.maxCacheBytes = Number(options.maxCacheBytes) || DEFAULT_INBOUND_ATTACHMENT_LIMITS.maxCacheBytes;
  }

  messageDirectory(messageId) {
    const id = String(messageId || "");
    if (!id) throw new TypeError("Feishu message id is required for attachment storage");
    return path.join(this.rootDir, messageDirectoryName(id));
  }

  async ensureRoot() {
    await fs.mkdir(this.rootDir, { recursive: true });
    const stat = await fs.lstat(this.rootDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw attachmentError("attachment_cache_unsafe", "Inbound attachment cache root is not a regular directory");
    }
  }

  async ensureMessageDirectory(messageId) {
    await this.ensureRoot();
    const directory = this.messageDirectory(messageId);
    if (path.dirname(path.resolve(directory)) !== this.rootDir) {
      throw attachmentError("attachment_cache_unsafe", "Inbound attachment cache path escaped its root");
    }
    await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw attachmentError("attachment_cache_unsafe", "Inbound attachment message cache is not a regular directory");
    }
    return directory;
  }

  async downloadMessage(message, channel) {
    const messageId = String(message?.messageId || "");
    if (!messageId) throw new TypeError("Feishu message id is required for attachment download");
    const resources = normalizeInboundResourceDescriptors(message?.resources);
    if (resources.length === 0) return Object.freeze([]);
    if (resources.length > this.maxItems) {
      throw attachmentError("attachment_too_many", "Feishu message contains too many attachments");
    }
    const directory = await this.ensureMessageDirectory(messageId);
    const downloaded = [];
    let totalBytes = 0;
    try {
      for (let index = 0; index < resources.length; index += 1) {
        const resource = resources[index];
        const prefix = String(index + 1).padStart(2, "0");
        const temporaryPath = path.join(directory, `${prefix}.download`);
        await fs.rm(temporaryPath, { force: true });
        let result;
        try {
          result = await downloadResource(channel, {
            messageId,
            fileKey: resource.fileKey,
            downloadType: resource.type === "image" ? "image" : "file",
            destination: temporaryPath,
            maxBytes: this.maxFileBytes,
          });
        } catch (error) {
          await fs.rm(temporaryPath, { force: true }).catch(() => {});
          if (error instanceof FeishuInboundAttachmentError) throw error;
          throw attachmentError("attachment_download_failed", "Feishu attachment download failed", { cause: error });
        }
        const stat = await fs.lstat(temporaryPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
          throw attachmentError("attachment_download_failed", "Feishu returned an invalid attachment");
        }
        if (stat.size > this.maxFileBytes || stat.size !== result.bytesWritten) {
          throw attachmentError("attachment_too_large", "Feishu attachment exceeds the configured per-file limit");
        }
        totalBytes += stat.size;
        if (totalBytes > this.maxTotalBytes) {
          throw attachmentError("attachment_total_too_large", "Feishu message attachments exceed the configured total limit");
        }
        const extension = resourceExtension(resource, result.contentType);
        const kind = downloadedKind(resource, result.contentType, extension);
        const fallbackName = `${defaultResourceName(resource.type)}${extension}`;
        const requestedName = kind === "image"
          ? `image${extension || ".jpg"}`
          : safeInboundAttachmentName(resource.fileName, fallbackName);
        const fileName = `${prefix}-${safeInboundAttachmentName(requestedName, fallbackName)}`;
        const localPath = path.join(directory, fileName);
        await fs.rm(localPath, { force: true });
        await fs.rename(temporaryPath, localPath);
        downloaded.push(Object.freeze({
          kind,
          localPath,
          name: safeInboundAttachmentName(resource.fileName, requestedName),
          contentType: result.contentType,
          size: stat.size,
        }));
      }
      await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({
        version: 1,
        messageHash: messageDirectoryName(messageId),
        createdAt: Date.now(),
        attachments: downloaded,
      }, null, 2), { encoding: "utf8", mode: 0o600 });
      return Object.freeze(downloaded);
    } catch (error) {
      for (const file of await fs.readdir(directory).catch(() => [])) {
        if (file.endsWith(".download")) await fs.rm(path.join(directory, file), { force: true }).catch(() => {});
      }
      throw error;
    }
  }

  async prune({ protectedMessageIds = [], protectedAttachmentPaths = [], now = Date.now() } = {}) {
    await this.ensureRoot();
    const protectedNames = new Set(protectedMessageIds.map(messageDirectoryName));
    for (const attachmentPath of protectedAttachmentPaths) {
      const absolutePath = path.resolve(String(attachmentPath || ""));
      const directory = path.dirname(absolutePath);
      if (path.dirname(directory) !== this.rootDir) continue;
      protectedNames.add(path.basename(directory));
    }
    const candidates = [];
    for (const entry of await fs.readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(this.rootDir, entry.name);
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      candidates.push({
        name: entry.name,
        directory,
        modifiedAt: Number(stat.mtimeMs) || 0,
        size: await directorySize(directory),
      });
    }
    let total = candidates.reduce((sum, entry) => sum + entry.size, 0);
    let removed = 0;
    for (const entry of candidates.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
      if (protectedNames.has(entry.name)) continue;
      const expired = now - entry.modifiedAt > this.retentionMs;
      if (!expired && total <= this.maxCacheBytes) continue;
      if (path.dirname(path.resolve(entry.directory)) !== this.rootDir) continue;
      await fs.rm(entry.directory, { recursive: true, force: true });
      total -= entry.size;
      removed += 1;
    }
    return Object.freeze({ removed, bytesRemaining: Math.max(0, total) });
  }
}

export async function prepareFeishuPrompt(message, channel, store, { enabled = true } = {}) {
  const sourceResources = Array.isArray(message?.resources) ? message.resources : [];
  const resources = normalizeInboundResourceDescriptors(message?.resources);
  if (sourceResources.some((resource) => (
    !SUPPORTED_RESOURCE_TYPES.has(String(resource?.type || "").trim().toLowerCase()) ||
    !String(resource?.fileKey || "").trim()
  ))) {
    throw attachmentError("attachment_unsupported", "Feishu message contains an unsupported resource type");
  }
  const text = sanitizeFeishuResourceContent(message?.content, resources);
  if (resources.length > 0 && !enabled) {
    throw attachmentError("attachment_disabled", "Inbound Feishu attachments are disabled");
  }
  const attachments = resources.length > 0
    ? await store.downloadMessage({ ...message, resources }, channel)
    : Object.freeze([]);
  if (!text && attachments.length === 0) {
    throw attachmentError("empty_message", "Feishu message contains no usable prompt content");
  }
  return Object.freeze({ text, attachments });
}
