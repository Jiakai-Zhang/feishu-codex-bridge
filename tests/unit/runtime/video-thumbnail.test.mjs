import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { readNativeVideoThumbnail } from "../../../src/runtime/video-thumbnail.mjs";

test("skips the Windows thumbnail helper on other platforms", async () => {
  const result = await readNativeVideoThumbnail("/output/demo.mp4", {
    platform: "linux",
    spawnImpl: () => { throw new Error("unexpected process spawn"); },
  });
  assert.equal(result, undefined);
});

function thumbnailProcess({ output, closeCode = 0, close = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; };
  queueMicrotask(() => {
    if (output) child.stdout.end(output);
    if (close) child.emit("close", closeCode);
  });
  return child;
}

test("accepts only a bounded PNG from the Windows thumbnail helper", async () => {
  const png = Buffer.from("89504e470d0a1a0a01020304", "hex");
  const result = await readNativeVideoThumbnail("C:/output/demo.mp4", {
    platform: "win32",
    spawnImpl: () => thumbnailProcess({ output: png.toString("base64") }),
  });
  assert.deepEqual(result, png);

  const invalid = await readNativeVideoThumbnail("C:/output/demo.mp4", {
    platform: "win32",
    spawnImpl: () => thumbnailProcess({ output: Buffer.from("not-png").toString("base64") }),
  });
  assert.equal(invalid, undefined);
});

test("times out and terminates a stalled Windows thumbnail helper", async () => {
  let child;
  const result = await readNativeVideoThumbnail("C:/output/demo.mp4", {
    platform: "win32",
    timeoutMs: 5,
    spawnImpl: () => {
      child = thumbnailProcess({ close: false });
      return child;
    },
  });
  assert.equal(result, undefined);
  assert.equal(child.killed, true);
});
