import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  calculateVideoBitrateKbps,
  extractVideoFrameForFeishu,
  transcodeVideoForFeishu,
} from "../../../src/runtime/video-transcoder.mjs";

const portableVideoPath = path.join(os.tmpdir(), "bridge-video-cover-test.mp4");

test("calculates a bounded video bitrate and rejects unusably low quality", () => {
  assert.equal(calculateVideoBitrateKbps(60, { targetBytes: 10 * 1024 * 1024 }) > 1_000, true);
  assert.equal(calculateVideoBitrateKbps(24 * 60 * 60, { targetBytes: 1024 * 1024 }), undefined);
  assert.equal(calculateVideoBitrateKbps(0), undefined);
});

test("transcodes an MP4 with two passes into the persistent cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-transcode-test-"));
  const source = path.join(root, "source.mp4");
  const cacheDir = path.join(root, "cache");
  await fs.writeFile(source, Buffer.alloc(2_000));
  const calls = [];
  const execFile = (executable, args, options, callback) => {
    calls.push({ executable, args });
    if (String(executable).includes("ffprobe")) {
      callback(null, JSON.stringify({ format: { duration: "10" } }), "");
      return;
    }
    const output = args.at(-1);
    if (output.endsWith(".tmp.mp4")) {
      fs.writeFile(output, Buffer.alloc(20_000)).then(() => callback(null, "", ""));
      return;
    }
    callback(null, "", "");
  };

  try {
    const result = await transcodeVideoForFeishu(source, {
      cacheDir,
      targetBytes: 1024 * 1024,
      ffmpegExecutable: "ffmpeg-test",
      ffprobeExecutable: "ffprobe-test",
      execFile,
    });
    assert.equal(result.outputSize, 20_000);
    assert.equal(result.cached, false);
    assert.equal(path.dirname(result.localPath), cacheDir);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].args.includes("1"), true);
    assert.equal(calls[2].args.includes("2"), true);

    const cached = await transcodeVideoForFeishu(source, {
      cacheDir,
      targetBytes: 1024 * 1024,
      execFile: () => assert.fail("a valid cache entry must not invoke ffmpeg"),
    });
    assert.equal(cached.cached, true);
    assert.equal(cached.localPath, result.localPath);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extracts a real PNG frame from the final video for the Feishu cover", async () => {
  const calls = [];
  const png = Buffer.from("89504e470d0a1a0a01020304", "hex");
  const execFile = (executable, args, options, callback) => {
    calls.push({ executable, args, options });
    if (String(executable).includes("ffprobe")) {
      callback(null, JSON.stringify({ format: { duration: "80" } }), "");
      return;
    }
    callback(null, png, Buffer.alloc(0));
  };

  const result = await extractVideoFrameForFeishu(portableVideoPath, {
    ffmpegExecutable: "ffmpeg-test",
    ffprobeExecutable: "ffprobe-test",
    execFile,
  });

  assert.strictEqual(result, png);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes("5.000"), true);
  assert.equal(calls[1].args.includes("pipe:1"), true);
  assert.equal(calls[1].options.encoding, "buffer");
});

test("rejects an invalid extracted frame and removes an oversized temporary transcode", async () => {
  const invalidFrameExec = (executable, args, options, callback) => {
    if (String(executable).includes("ffprobe")) {
      callback(null, JSON.stringify({ format: { duration: "10" } }), "");
      return;
    }
    callback(null, Buffer.from("not a png"), Buffer.alloc(0));
  };
  await assert.rejects(() => extractVideoFrameForFeishu(portableVideoPath, {
    ffmpegExecutable: "ffmpeg-test",
    ffprobeExecutable: "ffprobe-test",
    execFile: invalidFrameExec,
  }), /non-PNG/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-transcode-error-test-"));
  const source = path.join(root, "source.mp4");
  const cacheDir = path.join(root, "cache");
  await fs.writeFile(source, Buffer.alloc(2_000));
  const execFile = (executable, args, options, callback) => {
    if (String(executable).includes("ffprobe")) {
      callback(null, JSON.stringify({ format: { duration: "10" } }), "");
      return;
    }
    const output = args.at(-1);
    if (output.endsWith(".tmp.mp4")) {
      fs.writeFile(output, Buffer.alloc(2 * 1024 * 1024)).then(() => callback(null, "", ""));
      return;
    }
    callback(null, "", "");
  };
  try {
    await assert.rejects(() => transcodeVideoForFeishu(source, {
      cacheDir,
      targetBytes: 1024 * 1024,
      ffmpegExecutable: "ffmpeg-test",
      ffprobeExecutable: "ffprobe-test",
      execFile,
    }), { code: "video_still_too_large" });
    const remaining = await fs.readdir(cacheDir);
    assert.equal(remaining.some((name) => name.endsWith(".tmp.mp4")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
