import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { basenameFsPath, extnameFsPath } from "../runtime/shared/fs-paths.mjs";

export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;
const FEISHU_IMAGE_EXTENSIONS = new Set([
  ".bmp", ".gif", ".heic", ".ico", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp",
]);
const videoCoverScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/media/render-video-cover.ps1",
);

function findMp4BoxPayload(buffer, begin, end, name) {
  let cursor = begin;
  while (cursor + 8 <= end && cursor + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(cursor);
    const type = buffer.subarray(cursor + 4, cursor + 8).toString("ascii");
    const headerSize = size === 1 ? 16 : 8;
    if (size === 1 && cursor + headerSize > end) return undefined;
    const boxEnd = size === 1
      ? cursor + Number(buffer.readBigUInt64BE(cursor + 8))
      : size === 0 ? end : cursor + size;
    if (boxEnd <= cursor || boxEnd > end || boxEnd > buffer.length) return undefined;
    if (type === name) return { start: cursor + headerSize, end: boxEnd };
    cursor = boxEnd;
  }
  return undefined;
}

export function parseMp4Duration(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return undefined;
  const movie = findMp4BoxPayload(buffer, 0, buffer.length, "moov");
  if (!movie) return undefined;
  const header = findMp4BoxPayload(buffer, movie.start, movie.end, "mvhd");
  if (!header || header.start + 20 > buffer.length) return undefined;
  const version = buffer.readUInt8(header.start);
  const base = header.start + 4;
  let timescale;
  let duration;
  if (version === 1) {
    if (base + 28 > buffer.length) return undefined;
    timescale = buffer.readUInt32BE(base + 16);
    duration = Number(buffer.readBigUInt64BE(base + 20));
  } else {
    if (base + 16 > buffer.length) return undefined;
    timescale = buffer.readUInt32BE(base + 8);
    duration = buffer.readUInt32BE(base + 12);
  }
  if (!timescale || !Number.isFinite(duration) || duration <= 0) return undefined;
  return Math.round(duration / timescale * 1_000);
}

function extractWindowsVideoCover(localPath) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", videoCoverScript,
      "-SourcePath", localPath,
    ], {
      encoding: "buffer",
      maxBuffer: FEISHU_IMAGE_MAX_BYTES,
      timeout: 20_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(new Error("Windows could not render a video cover", { cause: error }));
      else if (!Buffer.isBuffer(stdout) || stdout.length === 0) reject(new Error("Video cover is empty"));
      else resolve(stdout);
    });
  });
}

function normalizedMediaType(value) {
  return value === "image" || value === "video" ? value : "file";
}

export function classifyFeishuImageSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return "invalid";
  if (size <= FEISHU_IMAGE_MAX_BYTES) return "image";
  if (size <= FEISHU_FILE_MAX_BYTES) return "file";
  return "too_large";
}

export function classifyFeishuNativeMedia(fileName, fileSize) {
  const extension = path.win32.extname(String(fileName || "")).toLowerCase();
  if (extension === ".mp4") return "video";
  if (FEISHU_IMAGE_EXTENSIONS.has(extension) && classifyFeishuImageSize(fileSize) === "image") {
    return "image";
  }
  return "file";
}

export function safeNativeAttachmentName(value, localPath) {
  const requested = String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const fallback = basenameFsPath(localPath);
  const fallbackExtension = extnameFsPath(fallback);
  const requestedWithExtension = requested && fallbackExtension && !extnameFsPath(requested)
    ? `${requested}${fallbackExtension}`
    : requested;
  const name = (requestedWithExtension || fallback || "Codex-attachment.bin")
    .replace(/[\\/]/g, "_")
    .trim();
  return (name || "Codex-attachment.bin").slice(0, 200);
}

export async function inspectFeishuNativeAttachment(localPath, {
  name,
  fsImpl = fs,
} = {}) {
  const target = String(localPath || "");
  if (!path.isAbsolute(target)) throw new Error("native attachment path must be absolute");
  const stat = await fsImpl.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("native attachment must be a regular non-symlink file");
  }
  if (stat.size <= 0) throw new Error("native attachment must not be empty");
  if (stat.size > FEISHU_FILE_MAX_BYTES) {
    throw new Error("native attachment exceeds the Feishu 30 MB file limit");
  }
  const fileName = safeNativeAttachmentName(name, target);
  return Object.freeze({
    localPath: target,
    fileName,
    fileSize: stat.size,
    modifiedAtMs: Number(stat.mtimeMs) || undefined,
    mediaType: classifyFeishuNativeMedia(fileName, stat.size),
  });
}

export async function uploadFeishuNativeAttachment(client, attachment, {
  fsImpl = fs,
  parseVideoDuration = parseMp4Duration,
  extractVideoCover = extractWindowsVideoCover,
} = {}) {
  const inspected = await inspectFeishuNativeAttachment(attachment?.localPath, {
    name: attachment?.fileName,
    fsImpl,
  });
  const expectedSize = Number(attachment?.fileSize);
  if (Number.isFinite(expectedSize) && expectedSize > 0 && inspected.fileSize !== expectedSize) {
    throw new Error("native attachment changed after it was queued");
  }
  const file = await fsImpl.readFile(inspected.localPath);
  let videoMetadata;
  if (inspected.mediaType === "video") {
    const durationMs = Number(parseVideoDuration(file));
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error("MP4 duration could not be determined");
    }
    const cover = await extractVideoCover(inspected.localPath);
    if (!Buffer.isBuffer(cover) || cover.length <= 0 || cover.length > FEISHU_IMAGE_MAX_BYTES) {
      throw new Error("Video cover does not satisfy Feishu image limits");
    }
    videoMetadata = { durationMs, cover };
  }
  let response;
  if (inspected.mediaType === "image") {
    if (!client?.im?.image?.create) throw new Error("Feishu image upload client is unavailable");
    response = await client.im.image.create({ data: { image_type: "message", image: file } });
  } else {
    if (!client?.im?.v1?.file?.create) throw new Error("Feishu file upload client is unavailable");
    response = await client.im.v1.file.create({
      data: {
        file_type: inspected.mediaType === "video" ? "mp4" : "stream",
        file_name: inspected.fileName,
        file,
        ...(videoMetadata ? { duration: videoMetadata.durationMs } : {}),
      },
    });
  }
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu native attachment upload failed with code ${response.code}`);
  }
  const fileKey = inspected.mediaType === "image"
    ? response?.image_key || response?.data?.image_key
    : response?.file_key || response?.data?.file_key;
  if (!fileKey) throw new Error("Feishu native attachment upload returned no resource key");
  let coverImageKey;
  if (videoMetadata) {
    if (!client?.im?.image?.create) throw new Error("Feishu image upload client is unavailable");
    const coverResponse = await client.im.image.create({
      data: { image_type: "message", image: videoMetadata.cover },
    });
    if (coverResponse?.code !== undefined && coverResponse.code !== 0) {
      throw new Error(`Feishu video cover upload failed with code ${coverResponse.code}`);
    }
    coverImageKey = coverResponse?.image_key || coverResponse?.data?.image_key;
    if (!coverImageKey) throw new Error("Feishu video cover upload returned no image key");
  }
  return Object.freeze({
    ...inspected,
    fileKey: String(fileKey),
    coverImageKey: coverImageKey ? String(coverImageKey) : undefined,
    durationMs: videoMetadata?.durationMs,
  });
}

export function buildNativeAttachmentMessage(record) {
  const fileKey = String(record?.fileKey || "");
  if (!fileKey) throw new TypeError("Native attachment message requires a resource key");
  const mediaType = normalizedMediaType(record?.mediaType);
  if (mediaType === "image") return { msgType: "image", content: { image_key: fileKey } };
  if (mediaType === "video") {
    const coverImageKey = String(record?.coverImageKey || "");
    if (!coverImageKey) throw new TypeError("Native video message requires a cover image key");
    return { msgType: "media", content: { file_key: fileKey, image_key: coverImageKey } };
  }
  return { msgType: "file", content: { file_key: fileKey } };
}

export function buildNativeAttachmentDeliveries(baseRecord, attachments) {
  const source = Array.isArray(attachments) ? attachments : [];
  const records = [];
  const baseDeliveryId = String(baseRecord?.deliveryId || "codex-attachment");
  const createdAt = Number(baseRecord?.createdAt) || Date.now();
  source.forEach((attachment, index) => {
    const deliveryId = `${baseDeliveryId}:attachment:${index + 1}`;
    const fileName = safeNativeAttachmentName(attachment?.fileName, attachment?.localPath);
    records.push(Object.freeze({
      kind: "file",
      deliveryId,
      dependsOn: baseDeliveryId,
      messageId: baseRecord?.kind === "reply" ? baseRecord.messageId : undefined,
      chatId: String(baseRecord?.chatId || ""),
      threadId: baseRecord?.threadId ? String(baseRecord.threadId) : undefined,
      localPath: String(attachment?.localPath || ""),
      fileName,
      fileSize: Number(attachment?.fileSize) || undefined,
      modifiedAtMs: Number(attachment?.modifiedAtMs) || undefined,
      mediaType: normalizedMediaType(
        attachment?.mediaType || classifyFeishuNativeMedia(fileName, attachment?.fileSize),
      ),
      createdAt: createdAt + index + 1,
    }));
  });
  return Object.freeze(records);
}
