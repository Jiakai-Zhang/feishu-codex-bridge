import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DriveFileUploadStore,
  FeishuDriveFileManager,
  fingerprintDriveFile,
} from "../../../src/feishu/feishu-drive-file.mjs";

test("uploads a local file with a relative CLI path and accepts a trusted Drive URL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-drive-test-"));
  const localPath = path.join(root, "large video.mp4");
  await fs.writeFile(localPath, "fixture");
  let invocation;
  const manager = new FeishuDriveFileManager({
    nodeExecutable: "node-test",
    larkCliEntry: "lark-test.mjs",
    runCommand: async (...args) => {
      invocation = args;
      return { ok: true, data: { file: { url: "https://example.feishu.cn/file/fixture" } } };
    },
  });

  try {
    const result = await manager.upload({ localPath, name: "演示.mp4" });
    assert.equal(result.url, "https://example.feishu.cn/file/fixture");
    assert.equal(invocation[2].includes(path.resolve(localPath)), false);
    assert.equal(invocation[2].includes(`.${path.sep}${path.basename(localPath)}`), true);
    assert.equal(invocation[3].cwd, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("persists Drive upload URLs by a source fingerprint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-drive-store-test-"));
  const localPath = path.join(root, "source.bin");
  const storePath = path.join(root, "uploads.json");
  await fs.writeFile(localPath, "fixture");
  try {
    const source = await fingerprintDriveFile(localPath);
    const store = await DriveFileUploadStore.open(storePath);
    await store.put({
      fingerprint: source.fingerprint,
      url: "https://example.feishu.cn/file/persisted",
      createdAt: 1,
    });
    const reopened = await DriveFileUploadStore.open(storePath);
    assert.equal(reopened.get(source.fingerprint).url, "https://example.feishu.cn/file/persisted");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects an untrusted upload URL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-drive-invalid-test-"));
  const localPath = path.join(root, "source.bin");
  await fs.writeFile(localPath, "fixture");
  const manager = new FeishuDriveFileManager({
    nodeExecutable: "node-test",
    larkCliEntry: "lark-test.mjs",
    runCommand: async () => ({ ok: true, data: { url: "https://example.invalid/file/source" } }),
  });
  try {
    await assert.rejects(() => manager.upload({ localPath }), { code: "drive_invalid_response" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
