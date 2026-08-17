import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FEISHU_FILE_MAX_BYTES,
  FEISHU_IMAGE_MAX_BYTES,
  buildNativeAttachmentMessage,
  buildNativeAttachmentDeliveries,
  classifyFeishuImageSize,
  inspectFeishuNativeAttachment,
  parseMp4Duration,
  safeNativeAttachmentName,
  uploadFeishuNativeAttachment,
} from "../../../src/feishu/feishu-native-attachment.mjs";
import { DeliveryOutbox } from "../../../src/persistence/delivery-outbox.mjs";

test("classifies inline images and native-file fallbacks at Feishu limits", () => {
  assert.equal(classifyFeishuImageSize(0), "invalid");
  assert.equal(classifyFeishuImageSize(FEISHU_IMAGE_MAX_BYTES), "image");
  assert.equal(classifyFeishuImageSize(FEISHU_IMAGE_MAX_BYTES + 1), "file");
  assert.equal(classifyFeishuImageSize(FEISHU_FILE_MAX_BYTES), "file");
  assert.equal(classifyFeishuImageSize(FEISHU_FILE_MAX_BYTES + 1), "too_large");
});

test("sanitizes file names without exposing a local path", () => {
  assert.equal(safeNativeAttachmentName("folder/report.txt", "C:/private/report.txt"), "folder_report.txt");
  assert.equal(safeNativeAttachmentName("", "C:/private/report.txt"), "report.txt");
});

test("inspects and uploads a regular file as a Feishu stream attachment", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-native-attachment-"));
  const file = path.join(dir, "report.txt");
  try {
    await fs.writeFile(file, "report body", "utf8");
    const inspected = await inspectFeishuNativeAttachment(file);
    assert.equal(inspected.fileName, "report.txt");
    assert.equal(inspected.fileSize, 11);

    let request;
    const client = {
      im: { v1: { file: { create: async (value) => {
        request = value;
        return { data: { file_key: "file_test" } };
      } } } },
    };
    const uploaded = await uploadFeishuNativeAttachment(client, inspected);
    assert.equal(uploaded.fileKey, "file_test");
    assert.equal(request.data.file_type, "stream");
    assert.equal(request.data.file_name, "report.txt");
    assert.equal(request.data.file.toString("utf8"), "report body");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("uploads images and MP4 videos with their native Feishu media types", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-native-media-"));
  const image = path.join(dir, "result.png");
  const video = path.join(dir, "demo.mp4");
  try {
    await fs.writeFile(image, "image bytes", "utf8");
    await fs.writeFile(video, "video bytes", "utf8");
    const requests = [];
    const client = {
      im: {
        image: { create: async (value) => {
          requests.push({ endpoint: "image", value });
          return { data: { image_key: requests.length === 1 ? "img_test" : "img_cover" } };
        } },
        v1: { file: { create: async (value) => {
          requests.push({ endpoint: "file", value });
          return { data: { file_key: "file_test" } };
        } } },
      },
    };

    const uploadedImage = await uploadFeishuNativeAttachment(client, { localPath: image });
    const uploadedVideo = await uploadFeishuNativeAttachment(client, { localPath: video }, {
      parseVideoDuration: () => 4_321,
      extractVideoCover: async () => Buffer.from("cover bytes"),
    });

    assert.equal(uploadedImage.mediaType, "image");
    assert.equal(uploadedImage.fileKey, "img_test");
    assert.equal(uploadedVideo.mediaType, "video");
    assert.equal(uploadedVideo.fileKey, "file_test");
    assert.equal(uploadedVideo.coverImageKey, "img_cover");
    assert.equal(uploadedVideo.durationMs, 4_321);
    assert.equal(requests[0].endpoint, "image");
    assert.equal(requests[1].value.data.file_type, "mp4");
    assert.equal(requests[1].value.data.duration, 4_321);
    assert.equal(requests[2].endpoint, "image");
    assert.equal(requests[2].value.data.image_type, "message");
    assert.equal(requests[2].value.data.image.toString("utf8"), "cover bytes");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("builds native Feishu message payloads for images, videos, and files", () => {
  assert.deepEqual(buildNativeAttachmentMessage({ mediaType: "image", fileKey: "img_test" }), {
    msgType: "image",
    content: { image_key: "img_test" },
  });
  assert.deepEqual(buildNativeAttachmentMessage({
    mediaType: "video",
    fileKey: "file_video",
    coverImageKey: "img_cover",
  }), {
    msgType: "media",
    content: { file_key: "file_video", image_key: "img_cover" },
  });
  assert.deepEqual(buildNativeAttachmentMessage({ mediaType: "file", fileKey: "file_test" }), {
    msgType: "file",
    content: { file_key: "file_test" },
  });
});

test("parses MP4 movie duration from the mvhd box", () => {
  const box = (type, payload) => {
    const result = Buffer.alloc(payload.length + 8);
    result.writeUInt32BE(result.length, 0);
    result.write(type, 4, 4, "ascii");
    payload.copy(result, 8);
    return result;
  };
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(5_000, 16);
  const video = Buffer.concat([box("ftyp", Buffer.alloc(8)), box("moov", box("mvhd", mvhd))]);
  assert.equal(parseMp4Duration(video), 5_000);
  assert.equal(parseMp4Duration(Buffer.from("not an mp4")), undefined);
});

test("persists video cover and duration metadata for delivery retries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-video-outbox-"));
  const file = path.join(dir, "outbox.json");
  try {
    const outbox = await DeliveryOutbox.open(file);
    await outbox.put({
      kind: "file",
      deliveryId: "video-delivery",
      chatId: "oc_group",
      localPath: "C:/output/demo.mp4",
      fileKey: "file_video",
      coverImageKey: "img_cover",
      durationMs: 4_321,
      mediaType: "video",
    });
    const reopened = await DeliveryOutbox.open(file);
    assert.equal(reopened.list()[0].coverImageKey, "img_cover");
    assert.equal(reopened.list()[0].durationMs, 4_321);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("builds ordered attachment deliveries after the final answer", () => {
  const records = buildNativeAttachmentDeliveries({
    kind: "reply",
    deliveryId: "codex-turn:thread:turn",
    messageId: "om_prompt",
    chatId: "oc_group",
    threadId: "omt_thread",
    createdAt: 100,
  }, [
    { localPath: "C:/output/one.pdf", fileName: "one.pdf", fileSize: 10 },
    { localPath: "C:/output/two.png", fileName: "two.png", fileSize: 20 },
    { localPath: "C:/output/three.mp4", fileName: "three.mp4", fileSize: 30 },
  ]);

  assert.equal(records.length, 3);
  assert.equal(records[0].dependsOn, "codex-turn:thread:turn");
  assert.equal(records[0].messageId, "om_prompt");
  assert.equal(records[1].dependsOn, "codex-turn:thread:turn");
  assert.deepEqual(records.map(({ mediaType }) => mediaType), ["file", "image", "video"]);
  assert.ok(records[0].createdAt < records[1].createdAt);
});
