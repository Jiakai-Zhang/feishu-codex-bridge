import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FEISHU_FILE_MAX_BYTES,
  FEISHU_IMAGE_MAX_BYTES,
  FEISHU_VIDEO_COVER_VERSION,
  buildNativeAttachmentMessage,
  buildNativeAttachmentDeliveries,
  classifyFeishuImageSize,
  configureFeishuVideoUploadTimeout,
  createFeishuVideoCover,
  inspectFeishuNativeAttachment,
  resolveFeishuVideoCover,
  safeNativeAttachmentName,
  sendFeishuNativeVideo,
  uploadFeishuNativeAttachment,
} from "../../../src/feishu/feishu-native-attachment.mjs";

test("extends only Feishu file-upload requests for slow networks", () => {
  let interceptor;
  const client = {
    httpInstance: { interceptors: { request: { use: (value) => { interceptor = value; } } } },
  };
  assert.equal(configureFeishuVideoUploadTimeout(client, { timeoutMs: 600_000 }), true);
  assert.equal(configureFeishuVideoUploadTimeout(client, { timeoutMs: 600_000 }), false);
  assert.equal(interceptor({ url: "https://open.feishu.cn/open-apis/im/v1/files", timeout: 20_000 }).timeout, 600_000);
  assert.equal(interceptor({ url: "https://open.feishu.cn/open-apis/im/v1/messages", timeout: 20_000 }).timeout, 20_000);
});

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
  assert.equal(safeNativeAttachmentName("", "/private/output/report.txt"), "report.txt");
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

test("uploads images with their native Feishu media type", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-native-media-"));
  const image = path.join(dir, "result.png");
  try {
    await fs.writeFile(image, "image bytes", "utf8");
    const requests = [];
    const client = {
      im: {
        image: { create: async (value) => {
          requests.push({ endpoint: "image", value });
          return { data: { image_key: "img_test" } };
        } },
        v1: { file: { create: async (value) => {
          requests.push({ endpoint: "file", value });
          return { data: { file_key: "file_test" } };
        } } },
      },
    };

    const uploadedImage = await uploadFeishuNativeAttachment(client, { localPath: image });

    assert.equal(uploadedImage.mediaType, "image");
    assert.equal(uploadedImage.fileKey, "img_test");
    assert.equal(requests[0].endpoint, "image");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("builds native Feishu message payloads for images and files", () => {
  assert.deepEqual(buildNativeAttachmentMessage({ mediaType: "image", fileKey: "img_test" }), {
    msgType: "image",
    content: { image_key: "img_test" },
  });
  assert.throws(
    () => buildNativeAttachmentMessage({ mediaType: "video", fileKey: "file_video" }),
    /Channel SDK video flow/,
  );
  assert.deepEqual(buildNativeAttachmentMessage({ mediaType: "file", fileKey: "file_test" }), {
    msgType: "file",
    content: { file_key: "file_test" },
  });
});

test("streams an MP4 through the native Feishu media flow with progress and a generated cover", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-native-video-"));
  const video = path.join(dir, "demo.mp4");
  try {
    await fs.writeFile(video, "video bytes", "utf8");
    const calls = [];
    const channel = {
      rawClient: { im: {
        v1: {
          image: { create: async ({ data }) => {
            calls.push({ type: "cover", data });
            return { data: { image_key: "img_cover" } };
          } },
          file: { create: async ({ data }) => {
            const chunks = [];
            for await (const chunk of data.file) chunks.push(chunk);
            calls.push({ type: "upload", data: { ...data, file: Buffer.concat(chunks) } });
            return { data: { file_key: "file_video" } };
          } },
        },
        message: { reply: async (request) => {
          calls.push({ type: "reply", request });
          return { data: { message_id: "om_video" } };
        } },
      } },
    };
    let prepared;
    const progress = [];
    const extractedCover = Buffer.from("89504e470d0a1a0a01020304", "hex");
    const result = await sendFeishuNativeVideo(channel, {
      localPath: video,
      fileName: "demo.mp4",
      fileSize: 11,
      chatId: "oc_group",
      messageId: "om_prompt",
      threadId: "omt_thread",
    }, {
      onPrepared: async (value) => { prepared = value; },
      onProgress: async (value) => { progress.push(value); },
      durationProvider: async () => 1.25,
      idempotencyKey: "video-delivery-key",
      videoCoverProvider: async () => extractedCover,
    });

    assert.equal(calls[0].type, "cover");
    assert.strictEqual(calls[0].data.image, extractedCover);
    assert.equal(calls[1].type, "upload");
    assert.equal(calls[1].data.file_type, "mp4");
    assert.equal(calls[1].data.duration, 1_250);
    assert.equal(calls[1].data.file.toString("utf8"), "video bytes");
    assert.equal(calls[2].type, "reply");
    assert.equal(calls[2].request.path.message_id, "om_prompt");
    assert.equal(calls[2].request.data.msg_type, "media");
    assert.equal(calls[2].request.data.reply_in_thread, true);
    assert.equal(calls[2].request.data.uuid, "video-delivery-key");
    assert.deepEqual(JSON.parse(calls[2].request.data.content), {
      file_key: "file_video",
      image_key: "img_cover",
    });
    assert.equal(prepared.coverImageKey, "img_cover");
    assert.equal(prepared.coverVersion, FEISHU_VIDEO_COVER_VERSION);
    assert.equal(prepared.fileKey, "file_video");
    assert.equal(result.messageId, "om_video");
    assert.equal(progress.some(({ stage }) => stage === "uploading"), true);
    assert.equal(progress.at(-1).stage, "complete");
    assert.strictEqual(createFeishuVideoCover(), createFeishuVideoCover());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("uses a native video thumbnail when available and falls back when extraction fails", async () => {
  const frame = Buffer.from("89504e470d0a1a0a0304", "hex");
  const thumbnail = Buffer.from("89504e470d0a1a0a0102", "hex");
  assert.strictEqual(await resolveFeishuVideoCover("C:/output/demo.mp4", {
    frameExtractor: async () => frame,
    thumbnailReader: async () => assert.fail("a decoded video frame must win"),
  }), frame);
  assert.strictEqual(await resolveFeishuVideoCover("C:/output/demo.mp4", {
    frameExtractor: async () => { throw new Error("ffmpeg unavailable"); },
    thumbnailReader: async () => thumbnail,
  }), thumbnail);
  assert.strictEqual(await resolveFeishuVideoCover("C:/output/demo.mp4", {
    frameExtractor: async () => { throw new Error("ffmpeg unavailable"); },
    thumbnailReader: async () => { throw new Error("codec unavailable"); },
  }), createFeishuVideoCover());
});

test("reuses persisted video resources after an interrupted final message send", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-native-video-retry-"));
  const video = path.join(dir, "retry.mp4");
  try {
    await fs.writeFile(video, "retry video", "utf8");
    let replyRequest;
    const channel = {
      rawClient: { im: {
        v1: {
          image: { create: async () => assert.fail("persisted cover must be reused") },
          file: { create: async () => assert.fail("persisted video upload must be reused") },
        },
        message: { reply: async (request) => {
          replyRequest = request;
          return { data: { message_id: "om_retry" } };
        } },
      } },
    };
    const result = await sendFeishuNativeVideo(channel, {
      localPath: video,
      fileName: "retry.mp4",
      fileSize: 11,
      messageId: "om_prompt",
      fileKey: "file_video",
      coverImageKey: "img_cover",
      coverVersion: FEISHU_VIDEO_COVER_VERSION,
    });

    assert.deepEqual(JSON.parse(replyRequest.data.content), {
      file_key: "file_video",
      image_key: "img_cover",
    });
    assert.equal(result.fileKey, "file_video");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sends a proactive video to the target chat without re-uploading persisted resources", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-native-video-send-"));
  const video = path.join(dir, "proactive.mp4");
  try {
    await fs.writeFile(video, "proactive video", "utf8");
    let createRequest;
    const channel = {
      rawClient: { im: {
        v1: {
          image: { create: async () => assert.fail("persisted cover must be reused") },
          file: { create: async () => assert.fail("persisted video upload must be reused") },
        },
        message: { create: async (request) => {
          createRequest = request;
          return { data: { message_id: "om_proactive" } };
        } },
      } },
    };

    const result = await sendFeishuNativeVideo(channel, {
      localPath: video,
      fileName: "proactive.mp4",
      fileSize: 15,
      chatId: "oc_target",
      fileKey: "file_video",
      coverImageKey: "img_cover",
      coverVersion: FEISHU_VIDEO_COVER_VERSION,
    }, { idempotencyKey: "proactive-video-key" });

    assert.equal(createRequest.params.receive_id_type, "chat_id");
    assert.equal(createRequest.data.receive_id, "oc_target");
    assert.equal(createRequest.data.msg_type, "media");
    assert.equal(createRequest.data.uuid, "proactive-video-key");
    assert.equal(result.messageId, "om_proactive");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fails closed when video resources change or Feishu omits required upload keys", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-native-video-errors-"));
  const video = path.join(dir, "error.mp4");
  try {
    await fs.writeFile(video, "video bytes", "utf8");
    const channel = {
      rawClient: { im: {
        v1: {
          image: { create: async () => ({ data: {} }) },
          file: { create: async () => assert.fail("upload must not run without a cover key") },
        },
        message: { reply: async () => assert.fail("send must not run without uploaded resources") },
      } },
    };

    await assert.rejects(() => sendFeishuNativeVideo(channel, {
      localPath: video,
      fileName: "error.mp4",
      fileSize: 999,
      messageId: "om_prompt",
    }), /changed after it was queued/);
    await assert.rejects(() => sendFeishuNativeVideo(channel, {
      localPath: video,
      fileName: "error.mp4",
      fileSize: 11,
      messageId: "om_prompt",
    }, { videoCoverProvider: async () => createFeishuVideoCover() }), /no image_key/);
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
