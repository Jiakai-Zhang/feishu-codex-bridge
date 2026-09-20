import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FEISHU_VIDEO_TARGET_BYTES = 27 * 1024 * 1024;
export const FEISHU_VIDEO_COVER_MAX_BYTES = 10 * 1024 * 1024;
const MIN_VIDEO_BITRATE_KBPS = 180;
const AUDIO_BITRATE_KBPS = 96;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function runExecutable(executable, args, {
  cwd,
  execFile = nodeExecFile,
  timeout = 30 * 60_000,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 10_000_000,
      timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(`${path.basename(executable)} failed`, { cause: error });
        failure.name = "VideoTranscodeError";
        failure.code = error.code === "ENOENT" ? "ffmpeg_unavailable" : "video_transcode_failed";
        failure.stderr = String(stderr || "").slice(-2_000);
        reject(failure);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function executableCandidates(name, env = process.env) {
  const extension = process.platform === "win32" ? ".exe" : "";
  const candidates = [`${name}${extension}`];
  if (process.platform !== "win32") return candidates;
  const localAppData = String(env.LOCALAPPDATA || "").trim();
  if (localAppData) {
    candidates.unshift(path.join(localAppData, "Microsoft", "WinGet", "Links", `${name}.exe`));
  }
  return candidates;
}

async function resolveWinGetFfmpegExecutable(name, { fsImpl = fs, env = process.env } = {}) {
  if (process.platform !== "win32") return undefined;
  const localAppData = String(env.LOCALAPPDATA || "").trim();
  if (!localAppData) return undefined;
  const packagesRoot = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  let packages;
  try { packages = await fsImpl.readdir(packagesRoot, { withFileTypes: true }); }
  catch { return undefined; }
  const ffmpegPackages = packages
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("Gyan.FFmpeg_"))
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const packageEntry of ffmpegPackages) {
    const packagePath = path.join(packagesRoot, packageEntry.name);
    let versions;
    try { versions = await fsImpl.readdir(packagePath, { withFileTypes: true }); }
    catch { continue; }
    const candidates = versions
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ffmpeg-"))
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const candidate of candidates) {
      const executable = path.join(packagePath, candidate.name, "bin", `${name}.exe`);
      try {
        const stat = await fsImpl.stat(executable);
        if (stat.isFile()) return executable;
      } catch {
        // Continue across installed WinGet package versions.
      }
    }
  }
  return undefined;
}

async function resolveExecutable(name, { fsImpl = fs, env = process.env } = {}) {
  let pathLookupCandidate;
  for (const candidate of executableCandidates(name, env)) {
    if (!path.isAbsolute(candidate)) {
      pathLookupCandidate = candidate;
      continue;
    }
    try {
      const stat = await fsImpl.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next candidate or PATH lookup.
    }
  }
  const winGetExecutable = await resolveWinGetFfmpegExecutable(name, { fsImpl, env });
  if (winGetExecutable) return winGetExecutable;
  return pathLookupCandidate || `${name}${process.platform === "win32" ? ".exe" : ""}`;
}

export function calculateVideoBitrateKbps(durationSeconds, {
  targetBytes = FEISHU_VIDEO_TARGET_BYTES,
  audioBitrateKbps = AUDIO_BITRATE_KBPS,
} = {}) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  const totalKbps = Math.floor((Number(targetBytes) * 8 * 0.94) / duration / 1_000);
  const videoKbps = totalKbps - Number(audioBitrateKbps);
  return videoKbps >= MIN_VIDEO_BITRATE_KBPS ? videoKbps : undefined;
}

export async function probeVideoDuration(localPath, {
  ffprobeExecutable,
  execFile = nodeExecFile,
  fsImpl = fs,
  env = process.env,
} = {}) {
  const executable = ffprobeExecutable || await resolveExecutable("ffprobe", { fsImpl, env });
  const result = await runExecutable(executable, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    localPath,
  ], { execFile, timeout: 60_000 });
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { parsed = undefined; }
  const duration = Number(parsed?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    const error = new Error("ffprobe returned no valid video duration");
    error.name = "VideoTranscodeError";
    error.code = "video_probe_failed";
    throw error;
  }
  return duration;
}

export async function extractVideoFrameForFeishu(localPath, {
  ffmpegExecutable,
  ffprobeExecutable,
  execFile = nodeExecFile,
  fsImpl = fs,
  env = process.env,
} = {}) {
  if (!path.isAbsolute(localPath)) throw new TypeError("video path must be absolute");
  const duration = await probeVideoDuration(localPath, {
    ffprobeExecutable,
    execFile,
    fsImpl,
    env,
  });
  const executable = ffmpegExecutable || await resolveExecutable("ffmpeg", { fsImpl, env });
  const midpoint = Math.max(0.05, duration / 2);
  const timestampSeconds = Math.min(midpoint, Math.max(0.5, Math.min(5, duration * 0.1)));
  const image = await new Promise((resolve, reject) => {
    execFile(executable, [
      "-hide_banner", "-loglevel", "error",
      "-ss", timestampSeconds.toFixed(3),
      "-i", localPath,
      "-frames:v", "1",
      "-vf", "scale=w='min(640,iw)':h=-2",
      "-an",
      "-f", "image2pipe",
      "-vcodec", "png",
      "pipe:1",
    ], {
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: FEISHU_VIDEO_COVER_MAX_BYTES,
      timeout: 60_000,
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error("ffmpeg video cover extraction failed", { cause: error });
        failure.name = "VideoTranscodeError";
        failure.code = error.code === "ENOENT" ? "ffmpeg_unavailable" : "video_cover_failed";
        failure.stderr = Buffer.isBuffer(stderr)
          ? stderr.toString("utf8").slice(-2_000)
          : String(stderr || "").slice(-2_000);
        reject(failure);
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ""));
    });
  });
  if (image.length === 0 || image.length > FEISHU_VIDEO_COVER_MAX_BYTES) {
    throw new Error("ffmpeg returned an invalid video cover size");
  }
  if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("ffmpeg returned a non-PNG video cover");
  }
  return image;
}

export async function transcodeVideoForFeishu(localPath, {
  cacheDir,
  targetBytes = FEISHU_VIDEO_TARGET_BYTES,
  ffmpegExecutable,
  ffprobeExecutable,
  execFile = nodeExecFile,
  fsImpl = fs,
  env = process.env,
} = {}) {
  if (!path.isAbsolute(localPath)) throw new TypeError("video path must be absolute");
  if (!path.isAbsolute(String(cacheDir || ""))) throw new TypeError("video cache directory must be absolute");
  const sourceStat = await fsImpl.lstat(localPath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size <= 0) {
    throw new TypeError("video must be a regular non-empty file");
  }
  const fingerprint = createHash("sha256")
    .update(`${path.resolve(localPath)}\0${sourceStat.size}\0${Number(sourceStat.mtimeMs) || 0}`)
    .digest("hex");
  await fsImpl.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const outputPath = path.join(cacheDir, `${fingerprint}.mp4`);
  try {
    const cached = await fsImpl.lstat(outputPath);
    if (cached.isFile() && !cached.isSymbolicLink() && cached.size > 0 && cached.size <= targetBytes) {
      return Object.freeze({ localPath: outputPath, sourceSize: sourceStat.size, outputSize: cached.size, cached: true });
    }
  } catch {
    // Cache miss.
  }

  const duration = await probeVideoDuration(localPath, {
    ffprobeExecutable,
    execFile,
    fsImpl,
    env,
  });
  const videoBitrateKbps = calculateVideoBitrateKbps(duration, { targetBytes });
  if (!videoBitrateKbps) {
    const error = new Error("video would require an unacceptably low bitrate");
    error.name = "VideoTranscodeError";
    error.code = "video_quality_too_low";
    throw error;
  }

  const executable = ffmpegExecutable || await resolveExecutable("ffmpeg", { fsImpl, env });
  const passLog = path.join(cacheDir, `${fingerprint}-${process.pid}-${Date.now()}`);
  const temporaryOutput = path.join(cacheDir, `${fingerprint}-${process.pid}-${Date.now()}.tmp.mp4`);
  const nullOutput = process.platform === "win32" ? "NUL" : "/dev/null";
  const videoArgs = [
    "-map", "0:v:0",
    "-c:v", "libx264",
    "-preset", "medium",
    "-b:v", `${videoBitrateKbps}k`,
    "-maxrate", `${videoBitrateKbps}k`,
    "-bufsize", `${videoBitrateKbps * 2}k`,
    "-vf", "scale=w='min(1280,iw)':h=-2",
    "-pix_fmt", "yuv420p",
  ];
  try {
    await runExecutable(executable, [
      "-y", "-i", localPath,
      ...videoArgs,
      "-an", "-pass", "1", "-passlogfile", passLog,
      "-f", "mp4", nullOutput,
    ], { execFile });
    await runExecutable(executable, [
      "-y", "-i", localPath,
      ...videoArgs,
      "-map", "0:a:0?", "-c:a", "aac", "-b:a", `${AUDIO_BITRATE_KBPS}k`,
      "-pass", "2", "-passlogfile", passLog,
      "-movflags", "+faststart",
      temporaryOutput,
    ], { execFile });
    const outputStat = await fsImpl.lstat(temporaryOutput);
    if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.size <= 0 || outputStat.size > targetBytes) {
      const error = new Error("transcoded video did not fit the Feishu delivery budget");
      error.name = "VideoTranscodeError";
      error.code = "video_still_too_large";
      throw error;
    }
    await fsImpl.rename(temporaryOutput, outputPath);
    return Object.freeze({
      localPath: outputPath,
      sourceSize: sourceStat.size,
      outputSize: outputStat.size,
      durationSeconds: duration,
      videoBitrateKbps,
      cached: false,
    });
  } finally {
    await Promise.allSettled([
      fsImpl.rm(temporaryOutput, { force: true }),
      fsImpl.rm(`${passLog}-0.log`, { force: true }),
      fsImpl.rm(`${passLog}-0.log.mbtree`, { force: true }),
      fsImpl.rm(`${passLog}.log`, { force: true }),
      fsImpl.rm(`${passLog}.log.mbtree`, { force: true }),
    ]);
  }
}

export function defaultVideoCacheDir(runtimeDir) {
  return path.join(String(runtimeDir || os.tmpdir()), "session-relay-outbound-video");
}
