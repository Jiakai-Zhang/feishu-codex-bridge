import { promises as fs } from "node:fs";
import path from "node:path";
import { basenameFsPath, extnameFsPath } from "../runtime/shared/fs-paths.mjs";

export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;
const FEISHU_IMAGE_EXTENSIONS = new Set([
  ".bmp", ".gif", ".heic", ".ico", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp",
]);

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
  return mediaType === "image"
    ? { msgType: "image", content: { image_key: fileKey } }
    : { msgType: mediaType === "video" ? "media" : "file", content: { file_key: fileKey } };
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
