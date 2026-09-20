import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { basenameFsPath, extnameFsPath } from "../runtime/shared/fs-paths.mjs";
import {
  extractVideoFrameForFeishu,
  probeVideoDuration,
} from "../runtime/video-transcoder.mjs";
import { readNativeVideoThumbnail } from "../runtime/video-thumbnail.mjs";

export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;
export const FEISHU_VIDEO_COVER_VERSION = 2;
export const FEISHU_VIDEO_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const FEISHU_IMAGE_EXTENSIONS = new Set([
  ".bmp", ".gif", ".heic", ".ico", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp",
]);
const VIDEO_COVER_WIDTH = 320;
const VIDEO_COVER_HEIGHT = 180;
let cachedVideoCover;
const videoUploadTimeoutClients = new WeakSet();

export function configureFeishuVideoUploadTimeout(client, {
  timeoutMs = FEISHU_VIDEO_UPLOAD_TIMEOUT_MS,
} = {}) {
  if (!client || videoUploadTimeoutClients.has(client)) return false;
  const requestInterceptors = client.httpInstance?.interceptors?.request;
  if (typeof requestInterceptors?.use !== "function") return false;
  requestInterceptors.use((request) => {
    const url = String(request?.url || "");
    if (!/\/open-apis\/im\/v1\/files(?:\?|$)/.test(url)) return request;
    return {
      ...request,
      timeout: Math.max(Number(request.timeout) || 0, Number(timeoutMs) || 0),
    };
  });
  videoUploadTimeoutClients.add(client);
  return true;
}

function normalizedMediaType(value) {
  return value === "image" || value === "video" ? value : "file";
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

export function createFeishuVideoCover() {
  if (cachedVideoCover) return cachedVideoCover;
  const stride = 1 + (VIDEO_COVER_WIDTH * 4);
  const pixels = Buffer.alloc(stride * VIDEO_COVER_HEIGHT);
  const centerX = VIDEO_COVER_WIDTH / 2;
  const centerY = VIDEO_COVER_HEIGHT / 2;
  const radiusSquared = 44 * 44;
  for (let y = 0; y < VIDEO_COVER_HEIGHT; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < VIDEO_COVER_WIDTH; x += 1) {
      const offset = row + 1 + (x * 4);
      const distanceSquared = ((x - centerX) ** 2) + ((y - centerY) ** 2);
      const insideButton = distanceSquared <= radiusSquared;
      const insideTriangle = x >= 148 && x <= 184 && Math.abs(y - centerY) <= (x - 145) * 0.72;
      const color = insideTriangle
        ? [255, 255, 255]
        : insideButton ? [51, 112, 255] : [31 + Math.floor(y / 18), 35 + Math.floor(y / 18), 41 + Math.floor(y / 18)];
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(VIDEO_COVER_WIDTH, 0);
  header.writeUInt32BE(VIDEO_COVER_HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;
  cachedVideoCover = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND"),
  ]);
  return cachedVideoCover;
}

export async function resolveFeishuVideoCover(localPath, {
  frameExtractor = extractVideoFrameForFeishu,
  thumbnailReader = readNativeVideoThumbnail,
} = {}) {
  try {
    const frame = await frameExtractor(localPath);
    if (frame) return frame;
  } catch {
    // Fall back when FFmpeg is unavailable or the source has no decodable video frame.
  }
  try {
    const thumbnail = await thumbnailReader(localPath);
    if (thumbnail) return thumbnail;
  } catch {
    // Keep delivery available when the operating system has no provider for the codec.
  }
  return createFeishuVideoCover();
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
} = {}) {
  const inspected = await inspectFeishuNativeAttachment(attachment?.localPath, {
    name: attachment?.fileName,
    fsImpl,
  });
  const expectedSize = Number(attachment?.fileSize);
  if (Number.isFinite(expectedSize) && expectedSize > 0 && inspected.fileSize !== expectedSize) {
    throw new Error("native attachment changed after it was queued");
  }
  if (inspected.mediaType === "video") {
    throw new Error("native video must be delivered through the Channel SDK video flow");
  }
  const file = await fsImpl.readFile(inspected.localPath);
  let response;
  if (inspected.mediaType === "image") {
    if (!client?.im?.image?.create) throw new Error("Feishu image upload client is unavailable");
    response = await client.im.image.create({ data: { image_type: "message", image: file } });
  } else {
    if (!client?.im?.v1?.file?.create) throw new Error("Feishu file upload client is unavailable");
    response = await client.im.v1.file.create({
      data: {
        file_type: "stream",
        file_name: inspected.fileName,
        file,
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
  return Object.freeze({
    ...inspected,
    fileKey: String(fileKey),
  });
}

export function buildNativeAttachmentMessage(record) {
  const fileKey = String(record?.fileKey || "");
  if (!fileKey) throw new TypeError("Native attachment message requires a resource key");
  const mediaType = normalizedMediaType(record?.mediaType);
  if (mediaType === "video") {
    throw new Error("native video messages must be sent through the Channel SDK video flow");
  }
  return mediaType === "image"
    ? { msgType: "image", content: { image_key: fileKey } }
    : { msgType: "file", content: { file_key: fileKey } };
}

export async function sendFeishuNativeVideo(channel, attachment, {
  fsImpl = fs,
  createReadStreamImpl = createReadStream,
  durationProvider = probeVideoDuration,
  idempotencyKey,
  onPrepared,
  onProgress,
  videoCoverProvider = resolveFeishuVideoCover,
} = {}) {
  if (!channel?.rawClient?.im?.v1?.file?.create) {
    throw new Error("Feishu video upload client is unavailable");
  }
  const inspected = await inspectFeishuNativeAttachment(attachment?.localPath, {
    name: attachment?.fileName,
    fsImpl,
  });
  if (inspected.mediaType !== "video") throw new TypeError("Channel SDK video delivery requires an MP4 file");
  const expectedSize = Number(attachment?.fileSize);
  if (Number.isFinite(expectedSize) && expectedSize > 0 && inspected.fileSize !== expectedSize) {
    throw new Error("native attachment changed after it was queued");
  }
  const emitProgress = async (progress) => {
    if (!onProgress) return;
    try { await onProgress(Object.freeze({ ...progress })); }
    catch { /* Progress display is best-effort and must not block delivery. */ }
  };
  await emitProgress({ stage: "preparing", uploadedBytes: 0, totalBytes: inspected.fileSize });

  const reusableCover = Number(attachment?.coverVersion) === FEISHU_VIDEO_COVER_VERSION;
  let coverImageKey = reusableCover && attachment?.coverImageKey
    ? String(attachment.coverImageKey)
    : undefined;
  if (!coverImageKey) {
    const imageApi = channel.rawClient?.im?.v1?.image || channel.rawClient?.im?.image;
    if (!imageApi?.create) throw new Error("Feishu image upload client is unavailable for the video cover");
    const videoCover = await videoCoverProvider(inspected.localPath);
    const coverResponse = await imageApi.create({
      data: { image_type: "message", image: videoCover },
    });
    if (coverResponse?.code !== undefined && coverResponse.code !== 0) {
      throw new Error(`Feishu video cover upload failed with code ${coverResponse.code}`);
    }
    coverImageKey = coverResponse?.image_key || coverResponse?.data?.image_key;
    if (!coverImageKey) throw new Error("Feishu video cover upload returned no image_key");
  }
  let prepared = Object.freeze({
    ...inspected,
    coverImageKey: String(coverImageKey),
    coverVersion: FEISHU_VIDEO_COVER_VERSION,
    ...(attachment?.fileKey ? { fileKey: String(attachment.fileKey) } : {}),
    ...(Number(attachment?.durationMs) > 0 ? { durationMs: Number(attachment.durationMs) } : {}),
  });
  if (onPrepared) await onPrepared(prepared);
  await emitProgress({ stage: "cover_ready", uploadedBytes: 0, totalBytes: inspected.fileSize });

  let fileKey = attachment?.fileKey ? String(attachment.fileKey) : undefined;
  if (!fileKey) {
    configureFeishuVideoUploadTimeout(channel.rawClient);
    const durationSeconds = await durationProvider(inspected.localPath);
    const durationMs = Math.max(1, Math.round(Number(durationSeconds) * 1_000));
    let uploadedBytes = 0;
    const source = createReadStreamImpl(inspected.localPath);
    source.on?.("data", (chunk) => {
      uploadedBytes = Math.min(inspected.fileSize, uploadedBytes + Buffer.byteLength(chunk));
      void emitProgress({ stage: "uploading", uploadedBytes, totalBytes: inspected.fileSize });
    });
    const uploadResponse = await channel.rawClient.im.v1.file.create({
      data: {
        file_type: "mp4",
        file_name: inspected.fileName,
        file: source,
        duration: durationMs,
      },
    });
    if (uploadResponse?.code !== undefined && uploadResponse.code !== 0) {
      throw new Error(`Feishu video upload failed with code ${uploadResponse.code}`);
    }
    fileKey = uploadResponse?.file_key || uploadResponse?.data?.file_key;
    if (!fileKey) throw new Error("Feishu video upload returned no file_key");
    prepared = Object.freeze({ ...prepared, fileKey: String(fileKey), durationMs });
    if (onPrepared) await onPrepared(prepared);
  } else {
    prepared = Object.freeze({ ...prepared, fileKey });
  }

  await emitProgress({
    stage: "sending",
    uploadedBytes: inspected.fileSize,
    totalBytes: inspected.fileSize,
  });
  const content = JSON.stringify({
    file_key: prepared.fileKey,
    image_key: prepared.coverImageKey,
  });
  const response = attachment?.messageId
    ? await channel.rawClient.im.message.reply({
      data: {
        content,
        msg_type: "media",
        reply_in_thread: Boolean(attachment.threadId),
        ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
      },
      path: { message_id: String(attachment.messageId) },
    })
    : await channel.rawClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: String(attachment?.chatId || ""),
        content,
        msg_type: "media",
        ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
      },
    });
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu video send failed with code ${response.code}`);
  }
  await emitProgress({
    stage: "complete",
    uploadedBytes: inspected.fileSize,
    totalBytes: inspected.fileSize,
  });
  return Object.freeze({
    ...prepared,
    messageId: response?.data?.message_id || response?.data?.message?.message_id,
  });
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
      cleanupAfterDelivery: attachment?.cleanupAfterDelivery === true,
      mediaType: normalizedMediaType(
        attachment?.mediaType || classifyFeishuNativeMedia(fileName, attachment?.fileSize),
      ),
      createdAt: createdAt + index + 1,
    }));
  });
  return Object.freeze(records);
}
