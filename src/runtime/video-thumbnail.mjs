import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VIDEO_THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;
const WINDOWS_VIDEO_THUMBNAIL_SCRIPT = fileURLToPath(
  new URL("../../scripts/windows/read-video-thumbnail.ps1", import.meta.url),
);

export function readNativeVideoThumbnail(localPath, {
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = 15_000,
} = {}) {
  if (platform !== "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", WINDOWS_VIDEO_THUMBNAIL_SCRIPT,
      ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      finish(undefined);
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, timeoutMs);
    timer.unref?.();
    child.on("error", () => finish(undefined));
    child.stdout.setEncoding("ascii");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > Math.ceil(VIDEO_THUMBNAIL_MAX_BYTES * 4 / 3) + 16) {
        child.kill();
        finish(undefined);
      }
    });
    child.on("close", (code) => {
      if (code !== 0) return finish(undefined);
      try {
        const image = Buffer.from(stdout.trim(), "base64");
        const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
        if (image.length === 0 || image.length > VIDEO_THUMBNAIL_MAX_BYTES) return finish(undefined);
        if (!image.subarray(0, pngSignature.length).equals(pngSignature)) return finish(undefined);
        return finish(image);
      } catch {
        return finish(undefined);
      }
    });
    child.stdin.on("error", () => finish(undefined));
    child.stdin.end(JSON.stringify({ inputPath: String(localPath) }), "utf8");
  });
}
