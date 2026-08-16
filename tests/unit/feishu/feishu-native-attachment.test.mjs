import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FEISHU_FILE_MAX_BYTES,
  FEISHU_IMAGE_MAX_BYTES,
  buildNativeAttachmentDeliveries,
  classifyFeishuImageSize,
  inspectFeishuNativeAttachment,
  safeNativeAttachmentName,
  uploadFeishuNativeAttachment,
} from "../../../src/feishu/feishu-native-attachment.mjs";

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
  ]);

  assert.equal(records.length, 2);
  assert.equal(records[0].dependsOn, "codex-turn:thread:turn");
  assert.equal(records[0].messageId, "om_prompt");
  assert.equal(records[1].dependsOn, "codex-turn:thread:turn");
  assert.ok(records[0].createdAt < records[1].createdAt);
});
